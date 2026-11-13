import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMockData, setMockFileContent } from '../test/platform-mocks';
import { platform } from '../platform';
import { initializeTestSchema } from '../test/initializeTestSchema';
import { createTestDb, createFileTestDb } from '../main/__tests__/test-db';
import { ensureSchema } from '../main/schema';
import { bindCatalogEntityFileInDb } from '../main/catalog-file-binding';
import {
  registerCatalogEntityInDb,
  registerWorkspaceFileInDb,
} from '../main/catalog-entity-registration';
import {
  ensureWorkspaceOwnerInDb,
  refreshCatalogFileFingerprintsInDb,
} from '../main/catalog-projection-commands';
import {
  bindCatalogEntityToFile,
  getCatalogEntity,
  getCatalogEntityForFilePath,
  getCatalogFileForPath,
  registerCatalogEntity,
  resolveWorkspaceScope,
} from '../db/workspace-catalog';
import { scopedProjectionId } from '../shared/workspace-scoped-identity';
import {
  indexWorkspaceHeadIntoCatalog,
  sequencePackageContentHash,
  type ManagedHeadReader,
} from './workspace-git-indexer';
import * as externalMoves from './external-move-reconcile';
import type { ManagedHeadIndex } from '../shared/workspace-git-types';
import { isVisibleManagedHeadFile } from '../shared/catalog-file-kind';
import {
  markRendererInteractionActivity,
  resetRendererInteractionActivityForTest,
} from '../lib/renderer-interaction-activity';
import {
  buildSequencePackageDocument,
  serializeSequencePackageDocument,
} from '../db/sequence-package';

const REPO = '/managed/abc/repo';
const oid = (c: string) => c.repeat(40);
const reader =
  (index: ManagedHeadIndex): ManagedHeadReader =>
  async () => ({
    ...index,
    scannedFileCount: index.files.length,
    visibleFileCount: index.files.filter((file) => isVisibleManagedHeadFile(file.relPath)).length,
  });

describe('indexWorkspaceHeadIntoCatalog (S3 renderer half)', () => {
  beforeEach(async () => {
    clearMockData();
    resetRendererInteractionActivityForTest();
    await initializeTestSchema();
  });

  it('pauses managed HEAD projection while a renderer gesture owns the frame budget', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      markRendererInteractionActivity();
      let completed = false;
      const indexing = indexWorkspaceHeadIntoCatalog(
        REPO,
        reader({
          headCommit: oid('c'),
          files: [{ relPath: 'notes.txt', oid: oid('d'), sizeBytes: 5, modifiedAt: 333 }],
        })
      ).then((result) => {
        completed = true;
        return result;
      });

      await vi.advanceTimersByTimeAsync(249);
      expect(completed).toBe(false);
      markRendererInteractionActivity();
      await vi.advanceTimersByTimeAsync(249);
      expect(completed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await vi.runAllTimersAsync();
      await expect(indexing).resolves.toMatchObject({ scanned: 1 });
    } finally {
      resetRendererInteractionActivityForTest();
      vi.useRealTimers();
    }
  });

  it('borrows the managed mount lease for external file relinks', async () => {
    const moves = vi
      .spyOn(externalMoves, 'applyExternalMovesForRoot')
      .mockResolvedValue({ relinked: 0, ambiguous: 0, errors: [] });
    try {
      await indexWorkspaceHeadIntoCatalog(REPO, reader({ headCommit: oid('c'), files: [] }), {
        mutationToken: 'mount-owned-lease',
      });
      expect(moves).toHaveBeenCalledWith(REPO, [], 'mount-owned-lease');
    } finally {
      moves.mockRestore();
    }
  });

  it('leaves accepted sequence state with its owner when Git still has older content or lacks the current path', async () => {
    const file = { relPath: 'accepted.gb', oid: oid('a'), sizeBytes: 12, modifiedAt: 1 };
    await indexWorkspaceHeadIntoCatalog(REPO, reader({ headCommit: oid('c'), files: [file] }));
    const path = `${REPO}/accepted.gb`;
    const before = await getCatalogFileForPath(path);
    if (!before) throw new Error('Accepted file fixture has no catalog identity.');
    const options = { acceptedPaths: [path], acceptedResourceIds: [before.entity_id] };
    await indexWorkspaceHeadIntoCatalog(
      REPO,
      reader({ headCommit: oid('d'), files: [{ ...file, oid: oid('b') }] }),
      options
    );
    expect(await getCatalogFileForPath(path)).toEqual(before);
    expect(
      await indexWorkspaceHeadIntoCatalog(
        REPO,
        reader({ headCommit: oid('e'), files: [] }),
        options
      )
    ).toMatchObject({ missing: 0 });
    expect(await getCatalogFileForPath(path)).toEqual(before);
  });

  it('projects sequence files from HEAD with the git content hash + an object uuid; skips non-sequences', async () => {
    const result = await indexWorkspaceHeadIntoCatalog(
      REPO,
      reader({
        headCommit: oid('c'),
        files: [
          { relPath: 'pUC19.gb', oid: oid('a'), sizeBytes: 20, modifiedAt: 111 },
          { relPath: 'sub/genome.fasta', oid: oid('b'), sizeBytes: 9, modifiedAt: 222 },
          { relPath: 'notes.txt', oid: oid('d'), sizeBytes: 5, modifiedAt: 333 },
        ],
      })
    );

    expect(result.scanned).toBe(3);
    expect(result.visibleFileCount).toBe(3);
    expect(result.registered).toBe(2);
    expect(result.missing).toBe(0);

    const gb = await getCatalogFileForPath(`${REPO}/pUC19.gb`);
    expect(gb?.content_hash).toBe(`git:${oid('a')}`);
    expect(gb?.object_uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(gb?.status).toBe('current');
    expect(gb?.size_bytes).toBe(20);
    expect(await getCatalogFileForPath(`${REPO}/notes.txt`)).toBeNull();
  });

  it.each(['faa', 'fasta'] as const)(
    'preserves the native protein ID and object UUID when reindexing %s',
    async (extension) => {
      const path = `${REPO}/Reporter.${extension}`;
      setMockFileContent(path, '>Reporter\nMKT\n');
      if (extension === 'fasta') {
        await registerCatalogEntity({
          id: 'protein-reporter',
          type: 'protein',
          name: 'Reporter protein',
          locator: `file://${path}`,
          storageType: 'file',
          workspaceRoot: REPO,
        });
        await bindCatalogEntityToFile({
          entityId: 'protein-reporter',
          path,
          fileKind: 'fasta',
          workspaceRoot: REPO,
        });
      }
      const head = reader({
        headCommit: oid('c'),
        files: [
          { relPath: `Reporter.${extension}`, oid: oid('a'), sizeBytes: 14, modifiedAt: 100 },
        ],
      });
      const first = await indexWorkspaceHeadIntoCatalog(REPO, head);
      expect(first.errors).toEqual([]);
      const before = await getCatalogFileForPath(path);
      expect(await getCatalogEntityForFilePath(path)).toMatchObject({
        id: extension === 'fasta' ? 'protein-reporter' : before!.entity_id,
        type: 'protein',
      });
      const second = await indexWorkspaceHeadIntoCatalog(
        REPO,
        reader({
          headCommit: oid('d'),
          files: [
            { relPath: `Reporter.${extension}`, oid: oid('b'), sizeBytes: 18, modifiedAt: 200 },
          ],
        })
      );
      expect(second.errors).toEqual([]);
      expect(await getCatalogFileForPath(path)).toMatchObject({
        entity_id: before!.entity_id,
        object_uuid: before!.object_uuid,
        content_hash: `git:${oid('b')}`,
        size_bytes: 18,
        status: 'current',
      });
      expect(second.registered).toBe(1);
    }
  );

  it.each([
    { type: 'sequence' as const, name: 'Native DNA.faa', bases: 'ACGTACGT' },
    { type: 'protein' as const, name: 'Native protein.fna', bases: 'MKQL' },
  ])('preserves exact native $type identity when managed HEAD presents $name', async (source) => {
    const fixture = createFileTestDb('native-fasta-head');
    const { db } = fixture;
    ensureSchema(db, fixture.dbPath);
    const root = join(realpathSync(fixture.tmpDir), 'workspace');
    mkdirSync(root);
    const path = join(root, source.name);
    writeFileSync(path, `>${source.name}\n${source.bases}\n`);
    const spies = [
      vi
        .spyOn(platform().db, 'select')
        .mockImplementation(
          async <T>(sql: string, params?: unknown[]) => db.prepare(sql).all(...(params ?? [])) as T
        ),
      vi
        .spyOn(platform().db, 'ensureWorkspaceOwner')
        .mockImplementation(async (root, access, discovery) =>
          ensureWorkspaceOwnerInDb(db, root, access, discovery)
        ),
      vi
        .spyOn(platform().db, 'registerCatalogEntity')
        .mockImplementation(async (input) => registerCatalogEntityInDb(db, input)),
      vi
        .spyOn(platform().db, 'registerWorkspaceFile')
        .mockImplementation(async (input) => registerWorkspaceFileInDb(db, input)),
      vi
        .spyOn(platform().db, 'bindCatalogEntityFile')
        .mockImplementation(async (input) => bindCatalogEntityFileInDb(db, input)),
      vi
        .spyOn(platform().db, 'refreshCatalogFileFingerprints')
        .mockImplementation(async (files) => refreshCatalogFileFingerprintsInDb(db, files)),
    ];
    try {
      const entityId = scopedProjectionId(
        await resolveWorkspaceScope(root),
        `native-${source.type}`
      );
      await registerCatalogEntity({
        id: entityId,
        type: source.type,
        name: source.name,
        locator: `file://${path}`,
        storageType: 'file',
        workspaceRoot: root,
      });
      await bindCatalogEntityToFile({ entityId, path, fileKind: 'fasta', workspaceRoot: root });
      const before = await getCatalogFileForPath(path);
      const result = await indexWorkspaceHeadIntoCatalog(
        root,
        reader({
          headCommit: oid('c'),
          files: [
            {
              relPath: source.name,
              oid: oid('a'),
              sizeBytes: source.bases.length,
              modifiedAt: 100,
            },
          ],
        }),
        { nativeFileBindings: [{ path, entityId, type: source.type }] }
      );
      expect(result.errors).toEqual([]);
      expect(result.registered).toBe(1);
      expect(await getCatalogEntityForFilePath(path)).toMatchObject({
        id: entityId,
        type: source.type,
      });
      expect(await getCatalogFileForPath(path)).toMatchObject({
        entity_id: entityId,
        object_uuid: before!.object_uuid,
        content_hash: `git:${oid('a')}`,
        status: 'current',
      });
    } finally {
      for (const spy of spies.reverse()) spy.mockRestore();
      fixture.cleanup();
    }
  });

  it.each([
    { count: 1, drift: null },
    { count: 201, drift: null },
    { count: 1, drift: 'object_uuid' },
    { count: 1, drift: 'file_kind' },
  ] as const)(
    'refreshes $count exact native sequence fingerprints with drift=$drift',
    async ({ count, drift }) => {
      const db = createTestDb();
      ensureSchema(db, ':memory:');
      const select = vi
        .spyOn(platform().db, 'select')
        .mockImplementation(
          async <T>(sql: string, params?: unknown[]) => db.prepare(sql).all(...(params ?? [])) as T
        );
      const writes = vi.spyOn(platform().db, 'execute').mockImplementation(async (sql, params) => {
        const result = db.prepare(sql).run(...(params ?? []));
        return { changes: result.changes, lastInsertRowid: Number(result.lastInsertRowid) };
      });
      const bindings = vi
        .spyOn(platform().db, 'bindCatalogEntityFile')
        .mockImplementation(async (input) => bindCatalogEntityFileInDb(db, input));
      const owners = vi
        .spyOn(platform().db, 'ensureWorkspaceOwner')
        .mockImplementation(async (root, access, discovery) =>
          ensureWorkspaceOwnerInDb(db, root, access, discovery)
        );
      const entities = vi
        .spyOn(platform().db, 'registerCatalogEntity')
        .mockImplementation(async (input) => registerCatalogEntityInDb(db, input));
      const fingerprints = vi
        .spyOn(platform().db, 'refreshCatalogFileFingerprints')
        .mockImplementation(async (files) => refreshCatalogFileFingerprintsInDb(db, files));
      try {
        const path = `${REPO}/Candidate.gb`;
        const entityId = scopedProjectionId(await resolveWorkspaceScope(REPO), 'candidate');
        const metadata = {
          reconstructedFrom: '.forge/catalog.json',
          classificationEvidence: { note: 'Preserve source evidence' },
        };
        await registerCatalogEntity({
          id: entityId,
          type: 'sequence',
          name: 'Human name',
          locator: `file://${path}`,
          storageType: 'file',
          workspaceRoot: REPO,
          metadata,
        });
        await bindCatalogEntityToFile({
          entityId,
          path,
          workspaceRoot: REPO,
          fileKind: 'genbank',
          contentHash: `sha256:${'a'.repeat(64)}`,
          sizeBytes: 20,
          modifiedAt: 10,
        });
        const before = await getCatalogFileForPath(path);
        const nativeSequenceBindings = [{ path, entityId }];
        const files = [{ relPath: 'Candidate.gb', oid: oid('b'), sizeBytes: 25, modifiedAt: 50 }];
        for (let index = 1; index < count; index++) {
          const relPath = `Candidate-${index}.gb`;
          const binding = { path: `${REPO}/${relPath}`, entityId: `${entityId}-${index}` };
          await registerCatalogEntity({
            id: binding.entityId,
            type: 'sequence',
            name: `Human name ${index}`,
            locator: `file://${binding.path}`,
            storageType: 'file',
            workspaceRoot: REPO,
            metadata,
          });
          await bindCatalogEntityToFile({
            ...binding,
            workspaceRoot: REPO,
            fileKind: 'genbank',
            contentHash: `sha256:${'a'.repeat(64)}`,
            sizeBytes: 20,
            modifiedAt: 10,
          });
          nativeSequenceBindings.push(binding);
          files.push({ relPath, oid: oid('b'), sizeBytes: 25, modifiedAt: 50 });
        }
        writes.mockClear();
        const indexing = indexWorkspaceHeadIntoCatalog(
          REPO,
          async (...args) => {
            if (drift === 'object_uuid')
              db.prepare('UPDATE catalog_entity_files SET object_uuid=? WHERE path=?').run(
                'changed-object',
                path
              );
            if (drift === 'file_kind')
              db.prepare('UPDATE catalog_entity_files SET file_kind=? WHERE path=?').run(
                'fasta',
                path
              );
            return reader({ headCommit: oid('c'), files })(...args);
          },
          { nativeSequenceBindings }
        );
        if (drift !== null) {
          await expect(indexing).rejects.toThrow('Native sequence binding changed');
          expect(await getCatalogFileForPath(path)).toMatchObject({
            content_hash: `sha256:${'a'.repeat(64)}`,
            size_bytes: 20,
            modified_at: 10,
          });
          return;
        }
        const result = await indexing;
        expect(result.errors).toEqual([]);
        expect(result.registered).toBe(count);
        expect(
          db
            .prepare(
              'SELECT COUNT(*) AS n FROM catalog_entity_files WHERE content_hash=? AND size_bytes=25 AND modified_at=50'
            )
            .get(`git:${oid('b')}`)
        ).toEqual({ n: count });
        expect(fingerprints).toHaveBeenCalledTimes(1);
        expect(fingerprints.mock.calls[0][0]).toHaveLength(count);
        expect(fingerprints.mock.calls[0][0].map((file) => file.path)).toEqual(
          nativeSequenceBindings.map((binding) => binding.path)
        );
        expect(await getCatalogEntityForFilePath(path)).toMatchObject({
          id: entityId,
          metadata: JSON.stringify(metadata),
        });
        expect(await getCatalogFileForPath(path)).toMatchObject({
          id: before?.id,
          entity_id: entityId,
          object_uuid: before?.object_uuid,
          content_hash: `git:${oid('b')}`,
          size_bytes: 25,
          modified_at: 50,
          status: 'current',
        });
        expect(
          writes.mock.calls.filter(([sql]) => /(?:UPDATE|INSERT INTO) catalog_entities/u.test(sql))
        ).toEqual([]);
      } finally {
        fingerprints.mockRestore();
        entities.mockRestore();
        owners.mockRestore();
        bindings.mockRestore();
        writes.mockRestore();
        select.mockRestore();
        db.close();
      }
    }
  );

  it('reconstructs a native protocol from its portable package ID in managed Git', async () => {
    const path = `${REPO}/Protocols/PCR/.forge/protocol.json`;
    setMockFileContent(
      path,
      JSON.stringify({
        schema: 'dnaforge.protocol.v1',
        kind: 'protocol',
        id: 'protocol-pcr',
        title: 'PCR',
      })
    );

    const result = await indexWorkspaceHeadIntoCatalog(
      REPO,
      reader({
        headCommit: oid('c'),
        files: [
          {
            relPath: 'Protocols/PCR/.forge/protocol.json',
            oid: oid('a'),
            sizeBytes: 120,
            modifiedAt: 111,
          },
        ],
      })
    );

    expect(result.errors).toEqual([]);
    expect(result.registered).toBe(1);
    expect(await getCatalogEntityForFilePath(path)).toMatchObject({
      id: scopedProjectionId(await resolveWorkspaceScope(REPO), 'protocol-pcr'),
      type: 'protocol',
      name: 'PCR',
    });
    expect((await getCatalogFileForPath(path))?.content_hash).toBe(`git:${oid('a')}`);
  });

  it('counts only file-tree-visible files for workspace telemetry', async () => {
    const result = await indexWorkspaceHeadIntoCatalog(
      REPO,
      reader({
        headCommit: oid('c'),
        files: [
          { relPath: 'pUC19.gb', oid: oid('a'), sizeBytes: 20 },
          { relPath: '.dnaforge-workspace.json', oid: oid('b'), sizeBytes: 4 },
          { relPath: 'sub/.hidden.txt', oid: oid('d'), sizeBytes: 3 },
          { relPath: 'seq.gb.waypoint.json', oid: oid('e'), sizeBytes: 2 },
        ],
      })
    );

    expect(result.scanned).toBe(4);
    expect(result.visibleFileCount).toBe(1);
  });

  it('returns managed primer and entity candidates from the same Git discovery pass', async () => {
    const result = await indexWorkspaceHeadIntoCatalog(
      REPO,
      reader({
        headCommit: oid('c'),
        files: [
          { relPath: 'oligos/F.primer.json', oid: oid('a'), sizeBytes: 20 },
          { relPath: 'Lab notes/.forge/notebook.json', oid: oid('b'), sizeBytes: 40 },
          { relPath: 'notes/readme.txt', oid: oid('d'), sizeBytes: 5 },
        ],
      })
    );

    expect(result.primerArtifactCandidatePaths).toEqual([`${REPO}/oligos/F.primer.json`]);
    expect(result.entityArtifactCandidatePaths).toEqual([`${REPO}/Lab notes/.forge/notebook.json`]);
  });

  it('preserves object_uuid across re-index but updates the content hash (immutable identity)', async () => {
    await indexWorkspaceHeadIntoCatalog(
      REPO,
      reader({
        headCommit: oid('c'),
        files: [{ relPath: 'seq.gb', oid: oid('a'), sizeBytes: 10, modifiedAt: 1 }],
      })
    );
    const before = await getCatalogFileForPath(`${REPO}/seq.gb`);
    const uuid = before?.object_uuid;
    expect(uuid).toBeTruthy();

    await indexWorkspaceHeadIntoCatalog(
      REPO,
      reader({
        headCommit: oid('d'),
        files: [{ relPath: 'seq.gb', oid: oid('e'), sizeBytes: 12, modifiedAt: 2 }],
      })
    );
    const after = await getCatalogFileForPath(`${REPO}/seq.gb`);
    expect(after?.object_uuid).toBe(uuid);
    expect(after?.content_hash).toBe(`git:${oid('e')}`);
  });

  it('projects supported coordinate files from managed HEAD as structures', async () => {
    const result = await indexWorkspaceHeadIntoCatalog(
      REPO,
      reader({
        headCommit: oid('c'),
        files: [
          { relPath: 'structures/1FS0.pdb', oid: oid('a'), sizeBytes: 20, modifiedAt: 111 },
          { relPath: 'structures/1FS0.cif', oid: oid('b'), sizeBytes: 30, modifiedAt: 222 },
          { relPath: 'structures/1FS0.bcif', oid: oid('d'), sizeBytes: 15, modifiedAt: 333 },
        ],
      })
    );

    expect(result.registered).toBe(3);
    await expect(getCatalogEntityForFilePath(`${REPO}/structures/1FS0.pdb`)).resolves.toMatchObject(
      { type: 'structure' }
    );
    expect((await getCatalogFileForPath(`${REPO}/structures/1FS0.cif`))?.content_hash).toBe(
      `git:${oid('b')}`
    );
  });

  it('flips a catalog row to missing when HEAD no longer contains it (no dangling pointer), keeping its uuid', async () => {
    await indexWorkspaceHeadIntoCatalog(
      REPO,
      reader({
        headCommit: oid('c'),
        files: [
          { relPath: 'keep.gb', oid: oid('a'), sizeBytes: 10, modifiedAt: 1 },
          { relPath: 'drop.gb', oid: oid('b'), sizeBytes: 10, modifiedAt: 1 },
        ],
      })
    );
    const droppedBefore = await getCatalogFileForPath(`${REPO}/drop.gb`);
    expect(droppedBefore?.status).toBe('current');
    const dropUuid = droppedBefore?.object_uuid;

    const result = await indexWorkspaceHeadIntoCatalog(
      REPO,
      reader({
        headCommit: oid('d'),
        files: [{ relPath: 'keep.gb', oid: oid('a'), sizeBytes: 10, modifiedAt: 1 }],
      })
    );
    expect(result.missing).toBe(1);

    const dropped = await getCatalogFileForPath(`${REPO}/drop.gb`);
    expect(dropped?.status).toBe('missing');
    expect(dropped?.object_uuid).toBe(dropUuid);
    expect((await getCatalogFileForPath(`${REPO}/keep.gb`))?.status).toBe('current');
  });

  it.each([
    { type: 'construct' as const, fileKind: 'waypoint-sequence', name: 'Package' },
    { type: 'sequence' as const, fileKind: 'genbank', name: 'new.gb' },
  ])(
    'does not mark a $type published after the HEAD snapshot missing',
    async ({ type, fileKind, name }) => {
      const path = `${REPO}/${name}`;
      await registerCatalogEntity({
        id: 'new-publication',
        type,
        name,
        locator: path,
        storageType: 'file',
        workspaceRoot: REPO,
      });
      const result = await indexWorkspaceHeadIntoCatalog(REPO, async () => {
        await bindCatalogEntityToFile({
          entityId: 'new-publication',
          path,
          fileKind,
          workspaceRoot: REPO,
        });
        return { headCommit: oid('a'), files: [], scannedFileCount: 0, visibleFileCount: 0 };
      });

      expect(result.missing).toBe(0);
      expect(await getCatalogFileForPath(path)).toMatchObject({
        entity_id: 'new-publication',
        status: 'current',
      });
    }
  );
});

describe('indexWorkspaceHeadIntoCatalog — plasmid packages ', () => {
  beforeEach(async () => {
    clearMockData();
    await initializeTestSchema();
    seedPackage('pMyConstruct', 'package-pMyConstruct', 'pMyConstruct', 'pMyConstruct.gb');
  });

  function seedPackage(root: string, id: string, name: string, productFile: string): void {
    const prefix = root ? `${REPO}/${root}` : REPO;
    setMockFileContent(
      `${prefix}/.forge/plasmid.json`,
      serializeSequencePackageDocument(
        buildSequencePackageDocument({ id, name, product: { file: productFile } })
      )
    );
  }

  const packageFiles = [
    { relPath: 'pMyConstruct/.forge/plasmid.json', oid: oid('1'), sizeBytes: 900, modifiedAt: 1 },
    { relPath: 'pMyConstruct/pMyConstruct.gb', oid: oid('2'), sizeBytes: 400, modifiedAt: 2 },
    {
      relPath: 'pMyConstruct/primers/pMyConstruct.primers.fasta',
      oid: oid('3'),
      sizeBytes: 80,
      modifiedAt: 3,
    },
    {
      relPath: 'pMyConstruct/primers/pMyConstruct.primers.csv',
      oid: oid('4'),
      sizeBytes: 60,
      modifiedAt: 4,
    },
  ];

  it('indexes the package entity but never its GenBank payload or primer export', async () => {
    await indexWorkspaceHeadIntoCatalog(
      REPO,
      reader({ headCommit: oid('c'), files: packageFiles })
    );

    expect(await getCatalogFileForPath(`${REPO}/pMyConstruct`)).toMatchObject({
      entity_id: 'package-pMyConstruct',
      file_kind: 'waypoint-sequence',
      status: 'current',
    });
    expect(await getCatalogEntity('package-pMyConstruct')).toMatchObject({
      name: 'pMyConstruct',
      type: 'sequence',
    });
    expect(await getCatalogFileForPath(`${REPO}/pMyConstruct/pMyConstruct.gb`)).toBeNull();

    expect(
      await getCatalogFileForPath(`${REPO}/pMyConstruct/primers/pMyConstruct.primers.fasta`)
    ).toBeNull();
  });

  it('keeps the exact finalized package current before its owning Git commit', async () => {
    await registerCatalogEntity({
      id: 'package-pMyConstruct',
      type: 'construct',
      name: 'pMyConstruct',
      locator: 'waypoint://construct/package-pMyConstruct',
      storageType: 'file',
      workspaceRoot: REPO,
    });
    await bindCatalogEntityToFile({
      entityId: 'package-pMyConstruct',
      path: `${REPO}/pMyConstruct`,
      fileKind: 'waypoint-sequence',
      workspaceRoot: REPO,
    });
    const before = await getCatalogFileForPath(`${REPO}/pMyConstruct`);
    const options = {
      mutationToken: 'finalization-owned-lease',
      pendingSequenceDocument: {
        kind: 'managed-sequence' as const,
        packageId: 'package-pMyConstruct',
        packageRoot: `${REPO}/pMyConstruct`,
      },
    };
    const result = await indexWorkspaceHeadIntoCatalog(
      REPO,
      reader({ headCommit: oid('c'), files: [] }),
      options
    );
    expect(result.errors).toEqual([]);
    expect(result.missing).toBe(0);
    expect(await getCatalogFileForPath(`${REPO}/pMyConstruct`)).toMatchObject({
      id: before!.id,
      entity_id: 'package-pMyConstruct',
      workspace_id: before!.workspace_id,
      file_kind: 'waypoint-sequence',
      status: 'current',
      object_uuid: before!.object_uuid,
    });
    expect(result.entityArtifactCandidatePaths).toContain(
      `${REPO}/pMyConstruct/.forge/plasmid.json`
    );
    expect(await getCatalogFileForPath(`${REPO}/pMyConstruct/pMyConstruct.gb`)).toBeNull();
    expect(await getCatalogEntity('package-pMyConstruct')).toMatchObject({ type: 'construct' });
  });

  it('refuses a different saved UUID instead of replacing the pending package owner', async () => {
    const options = {
      mutationToken: 'finalization-owned-lease',
      pendingSequenceDocument: {
        kind: 'managed-sequence' as const,
        packageId: 'another-package',
        packageRoot: `${REPO}/pMyConstruct`,
      },
    };
    const result = await indexWorkspaceHeadIntoCatalog(
      REPO,
      reader({ headCommit: oid('c'), files: [] }),
      options
    );
    expect(result.errors).toEqual([
      expect.objectContaining({
        message: expect.stringContaining('identity changed'),
      }),
    ]);
    expect(await getCatalogEntity('package-pMyConstruct')).toBeNull();
    expect(await getCatalogEntity('another-package')).toBeNull();
    expect(await getCatalogFileForPath(`${REPO}/pMyConstruct`)).toBeNull();
  });

  it.each([
    { mutationToken: undefined, packageRoot: `${REPO}/pMyConstruct` },
    { mutationToken: 'finalization-owned-lease', packageRoot: '/another/project/pMyConstruct' },
  ])(
    'refuses pending package reconstruction outside its owning lease or project: %j',
    async (boundary) => {
      const options = {
        mutationToken: boundary.mutationToken,
        pendingSequenceDocument: {
          kind: 'managed-sequence' as const,
          packageId: 'package-pMyConstruct',
          packageRoot: boundary.packageRoot,
        },
      };
      await expect(
        indexWorkspaceHeadIntoCatalog(REPO, reader({ headCommit: oid('c'), files: [] }), options)
      ).rejects.toThrow('owning project lease and path');
      expect(await getCatalogEntity('package-pMyConstruct')).toBeNull();
    }
  );

  it('keeps a matured design binding current at the package root', async () => {
    await registerCatalogEntity({
      id: 'package-pMyConstruct',
      type: 'construct',
      name: 'pMyConstruct',
      locator: 'waypoint://construct/package-pMyConstruct',
      storageType: 'file',
      workspaceRoot: REPO,
    });
    await bindCatalogEntityToFile({
      entityId: 'package-pMyConstruct',
      path: `${REPO}/pMyConstruct`,
      fileKind: 'waypoint-sequence',
      workspaceRoot: REPO,
    });

    await indexWorkspaceHeadIntoCatalog(
      REPO,
      reader({ headCommit: oid('c'), files: packageFiles })
    );

    expect(await getCatalogFileForPath(`${REPO}/pMyConstruct`)).toMatchObject({
      entity_id: 'package-pMyConstruct',
      file_kind: 'waypoint-sequence',
      status: 'current',
    });
  });

  it('indexes the plasmid of a package NESTED inside another package', async () => {
    seedPackage('pMyConstruct/pInner', 'package-pInner', 'pInner', 'pInner.gb');
    const nested = [
      ...packageFiles,
      {
        relPath: 'pMyConstruct/pInner/.forge/plasmid.json',
        oid: oid('5'),
        sizeBytes: 900,
        modifiedAt: 5,
      },
      { relPath: 'pMyConstruct/pInner/pInner.gb', oid: oid('6'), sizeBytes: 400, modifiedAt: 6 },
      {
        relPath: 'pMyConstruct/pInner/primers/pInner.primers.csv',
        oid: oid('7'),
        sizeBytes: 60,
        modifiedAt: 7,
      },
    ];

    await indexWorkspaceHeadIntoCatalog(REPO, reader({ headCommit: oid('c'), files: nested }));

    expect(await getCatalogFileForPath(`${REPO}/pMyConstruct`)).toMatchObject({
      entity_id: 'package-pMyConstruct',
    });
    expect(await getCatalogFileForPath(`${REPO}/pMyConstruct/pInner`)).toMatchObject({
      entity_id: 'package-pInner',
    });
    expect(await getCatalogFileForPath(`${REPO}/pMyConstruct/pMyConstruct.gb`)).toBeNull();
    expect(await getCatalogFileForPath(`${REPO}/pMyConstruct/pInner/pInner.gb`)).toBeNull();
    expect(
      await getCatalogFileForPath(`${REPO}/pMyConstruct/pInner/primers/pInner.primers.csv`)
    ).toBeNull();
  });

  it('reaches the same verdict whichever order git lists the meta files', async () => {
    seedPackage('a', 'package-a', 'a', 'a.gb');
    seedPackage('a/b', 'package-b', 'b', 'b.gb');
    const outerFirst = [
      { relPath: 'a/.forge/plasmid.json', oid: oid('1'), sizeBytes: 900, modifiedAt: 1 },
      { relPath: 'a/b/.forge/plasmid.json', oid: oid('2'), sizeBytes: 900, modifiedAt: 2 },
      { relPath: 'a/b/b.gb', oid: oid('3'), sizeBytes: 400, modifiedAt: 3 },
    ];
    await indexWorkspaceHeadIntoCatalog(REPO, reader({ headCommit: oid('c'), files: outerFirst }));
    const withOuterFirst = await getCatalogFileForPath(`${REPO}/a/b`);

    clearMockData();
    await initializeTestSchema();
    seedPackage('a', 'package-a', 'a', 'a.gb');
    seedPackage('a/b', 'package-b', 'b', 'b.gb');

    await indexWorkspaceHeadIntoCatalog(
      REPO,
      reader({ headCommit: oid('c'), files: [...outerFirst].reverse() })
    );
    const withInnerFirst = await getCatalogFileForPath(`${REPO}/a/b`);

    expect(withOuterFirst).not.toBeNull();
    expect(withInnerFirst).not.toBeNull();
  });

  it('does not treat a LOOSE fasta outside a package as a package member', async () => {
    await indexWorkspaceHeadIntoCatalog(
      REPO,
      reader({
        headCommit: oid('c'),
        files: [
          ...packageFiles,
          { relPath: 'primers/loose.primers.fasta', oid: oid('5'), sizeBytes: 40, modifiedAt: 5 },
          { relPath: 'sequences/pUC19.fasta', oid: oid('6'), sizeBytes: 40, modifiedAt: 6 },
        ],
      })
    );

    expect(await getCatalogFileForPath(`${REPO}/primers/loose.primers.fasta`)).not.toBeNull();
    expect(await getCatalogFileForPath(`${REPO}/sequences/pUC19.fasta`)).not.toBeNull();
  });

  it('sweeps a STALE package-member row left by an older build', async () => {
    await indexWorkspaceHeadIntoCatalog(
      REPO,
      reader({
        headCommit: oid('c'),
        files: [
          {
            relPath: 'pMyConstruct/primers/pMyConstruct.primers.fasta',
            oid: oid('3'),
            sizeBytes: 80,
            modifiedAt: 3,
          },
        ],
      })
    );
    const stale = `${REPO}/pMyConstruct/primers/pMyConstruct.primers.fasta`;
    expect(await getCatalogFileForPath(stale)).not.toBeNull();

    await indexWorkspaceHeadIntoCatalog(
      REPO,
      reader({ headCommit: oid('d'), files: packageFiles })
    );

    expect((await getCatalogFileForPath(stale))?.status).toBe('missing');
  });

  it('does not relink an unrelated missing sequence onto a package support FASTA', async () => {
    await registerCatalogEntity({
      id: 'missing-sequence',
      type: 'sequence',
      name: 'old.fasta',
      locator: `file://${REPO}/old.fasta`,
      storageType: 'file',
      workspaceRoot: REPO,
    });
    await bindCatalogEntityToFile({
      entityId: 'missing-sequence',
      path: `${REPO}/old.fasta`,
      fileKind: 'fasta',
      workspaceRoot: REPO,
      contentHash: `git:${oid('3')}`,
    });
    const relink = vi.spyOn(platform().workspace, 'relinkMovedEntityFile');

    const result = await indexWorkspaceHeadIntoCatalog(
      REPO,
      reader({ headCommit: oid('d'), files: packageFiles })
    );

    expect(relink).not.toHaveBeenCalled();
    expect(result.externalMovesRelinked).toBe(0);
    expect(await getCatalogFileForPath(`${REPO}/old.fasta`)).toMatchObject({
      entity_id: 'missing-sequence',
      status: 'missing',
    });
  });

  it('replaces a stale product-file projection with the package identity', async () => {
    const productPath = `${REPO}/pMyConstruct/pMyConstruct.gb`;
    await indexWorkspaceHeadIntoCatalog(
      REPO,
      reader({
        headCommit: oid('b'),
        files: [
          {
            relPath: 'pMyConstruct/pMyConstruct.gb',
            oid: oid('2'),
            sizeBytes: 400,
            modifiedAt: 2,
          },
        ],
      })
    );
    expect(await getCatalogFileForPath(productPath)).toMatchObject({
      file_kind: 'genbank',
      status: 'current',
    });

    await indexWorkspaceHeadIntoCatalog(
      REPO,
      reader({ headCommit: oid('c'), files: packageFiles })
    );

    expect(await getCatalogFileForPath(productPath)).toMatchObject({ status: 'missing' });
    expect(await getCatalogFileForPath(`${REPO}/pMyConstruct`)).toMatchObject({
      entity_id: 'package-pMyConstruct',
      file_kind: 'waypoint-sequence',
      status: 'current',
    });
  });

  it('recognizes a package at the workspace ROOT', async () => {
    seedPackage('', 'package-root', 'pUC19', 'pUC19.gb');
    await indexWorkspaceHeadIntoCatalog(
      REPO,
      reader({
        headCommit: oid('c'),
        files: [
          { relPath: '.forge/plasmid.json', oid: oid('1'), sizeBytes: 900, modifiedAt: 1 },
          { relPath: 'pUC19.gb', oid: oid('2'), sizeBytes: 400, modifiedAt: 2 },
          { relPath: 'primers/pUC19.primers.fasta', oid: oid('3'), sizeBytes: 80, modifiedAt: 3 },
        ],
      })
    );

    expect(await getCatalogFileForPath(REPO)).toMatchObject({
      entity_id: 'package-root',
      file_kind: 'waypoint-sequence',
    });
    expect(await getCatalogFileForPath(`${REPO}/pUC19.gb`)).toBeNull();
    expect(await getCatalogFileForPath(`${REPO}/primers/pUC19.primers.fasta`)).toBeNull();
  });

  it('leaves a notebook package alone (its members were never sequences)', async () => {
    const result = await indexWorkspaceHeadIntoCatalog(
      REPO,
      reader({
        headCommit: oid('c'),
        files: [
          {
            relPath: 'Lab notes/.forge/notebook.json',
            oid: oid('7'),
            sizeBytes: 100,
            modifiedAt: 7,
          },
          { relPath: 'Lab notes/Lab notes.md', oid: oid('8'), sizeBytes: 50, modifiedAt: 8 },
        ],
      })
    );
    expect(result.registered).toBe(0);
  });

  it('does not expose a plasmid nested inside an atomic notebook package', async () => {
    const result = await indexWorkspaceHeadIntoCatalog(
      REPO,
      reader({
        headCommit: oid('c'),
        files: [
          {
            relPath: 'Lab notes/.forge/notebook.json',
            oid: oid('7'),
            sizeBytes: 100,
            modifiedAt: 7,
          },
          {
            relPath: 'Lab notes/pInner/.forge/plasmid.json',
            oid: oid('8'),
            sizeBytes: 100,
            modifiedAt: 8,
          },
          {
            relPath: 'Lab notes/pInner/pInner.gb',
            oid: oid('9'),
            sizeBytes: 500,
            modifiedAt: 9,
          },
        ],
      })
    );

    expect(result.registered).toBe(0);
    expect(await getCatalogFileForPath(`${REPO}/Lab notes/pInner/pInner.gb`)).toBeNull();
  });
});

describe('sequencePackageContentHash', () => {
  const file = (relPath: string, oid: string) => ({
    relPath,
    oid,
    sizeBytes: 1,
    modifiedAt: null,
  });
  const meta = 'lab/pUC19/.forge/plasmid.json';
  const base = [
    file('lab/pUC19/pUC19.gb', 'a1'),
    file(meta, 'm1'),
    file('lab/pUC19/contents/read.ab1', 'r1'),
    file('lab/other.gb', 'o1'),
  ];

  it('changes with the product or metadata, not with attachments or siblings', () => {
    const hash = sequencePackageContentHash(base, 'lab/pUC19', meta);
    expect(hash).toBe('git-package:.forge/plasmid.json@m1,pUC19.gb@a1');
    const attachmentChanged = base.map((f) =>
      f.relPath.endsWith('read.ab1') ? file(f.relPath, 'r2') : f
    );
    expect(sequencePackageContentHash(attachmentChanged, 'lab/pUC19', meta)).toBe(hash);
    const productChanged = base.map((f) =>
      f.relPath.endsWith('pUC19.gb') ? file(f.relPath, 'a2') : f
    );
    expect(sequencePackageContentHash(productChanged, 'lab/pUC19', meta)).not.toBe(hash);
  });
});

import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../auth/session-store', () => ({
  getActiveStoredSession: vi.fn(async () => null),
}));
import type Database from 'better-sqlite3';
import { createTestDb } from './test-db';
import { ensureSchema } from '../schema';
import { registerLimsEntityInDb } from '../lims';
import { bindCatalogEntityFileInDb } from '../catalog-file-binding';
import {
  buildPrimerArtifact,
  serializePrimerArtifact,
  readBoundPrimerArtifact,
} from '../../shared/primers/primer-artifact';
import {
  acquireWorkspaceMutationShared,
  acquireWorkspaceSyncMutationLease,
  workspaceMutationRootIdentity,
} from '../workspace-sync-mutation-lease';
import { workspaceMutationCapabilities } from '../ipc/workspace-mutation-capability';
import * as mutationLease from '../workspace-sync-mutation-lease';
import {
  NATIVE_WORKSPACE_MANIFEST_PATH,
  serializeNativeWorkspaceManifest,
} from '../../shared/native-workspace-manifest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

vi.mock('../ipc/path-allowlist', () => ({
  assertSafePath: vi.fn(async (path: string) => path),
  withSafeWritablePaths: vi.fn(
    async <T>(
      requests: readonly { path: string }[],
      operation: (paths: readonly string[]) => Promise<T>
    ) => operation(requests.map((request) => request.path))
  ),
}));

let testDb: Database.Database;
vi.mock('../ipc/database', () => ({ getDb: () => testDb }));

const materializeSpy = vi.fn();
vi.mock('../lims-export-sync', () => ({
  materializeLimsGitExportForWorkspaceIds: (...args: unknown[]) => materializeSpy(...args),
}));

const hoisted = vi.hoisted(() => ({
  forceThrow: null as Error | null,
  afterMovePreparation: vi.fn(),
}));
vi.mock('../primer-file-move-intent', async (original) => {
  const actual = await original<typeof import('../primer-file-move-intent')>();
  return {
    ...actual,
    preparePrimerFileMove: async (...args: Parameters<typeof actual.preparePrimerFileMove>) => {
      const intent = await actual.preparePrimerFileMove(...args);
      hoisted.afterMovePreparation();
      return intent;
    },
  };
});
vi.mock('../workspace-relocate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace-relocate')>();
  return {
    ...actual,
    relocateWorkspaceFileRefsInDb: (
      db: Database.Database,
      input: Parameters<typeof actual.relocateWorkspaceFileRefsInDb>[1]
    ) => {
      if (hoisted.forceThrow) throw hoisted.forceThrow;
      return actual.relocateWorkspaceFileRefsInDb(db, input);
    },
  };
});

import { relocateEntityFile, relinkMovedEntityFile } from '../ipc/workspace-relocate';
import { installNativeDocumentTestProfile } from './native-document-profile-fixture';

installNativeDocumentTestProfile();

const HASH = (c: string) => `sha256:${c.repeat(64)}`;
const fileSeq = (relPath: string) => ({
  mode: 'file' as const,
  relPath,
  topology: 'circular' as const,
  length: 10,
  contentHash: HASH('a'),
  sourceFormat: 'gb' as const,
});
const seedCatalogFile = (db: Database.Database, path: string, portableId?: string): void => {
  db.prepare(
    `INSERT INTO catalog_entities
       (id, type, name, locator, storage_type, status, metadata, created_at, updated_at)
     VALUES (?, 'file', ?, ?, 'file', 'active', ?, 0, 0)`
  ).run(
    `ce-${path}`,
    path.split('/').pop(),
    `file://${path}`,
    portableId
      ? JSON.stringify({
          portableId,
          placement: { kind: 'file', relativePath: path.split('/').pop(), fileKind: 'genbank' },
        })
      : null
  );
  db.prepare(
    `INSERT INTO catalog_entity_files (id, entity_id, workspace_id, path, file_kind, status, created_at, updated_at)
     VALUES (?, ?, 1, ?, 'genbank', 'current', 0, 0)`
  ).run(`cf-${path}`, `ce-${path}`, path);
};
const seedIndexed = (db: Database.Database, path: string): number => {
  const fi = db
    .prepare(
      `INSERT INTO indexed_files (workspace_id, path, name, extension, indexed_at) VALUES (1, ?, ?, 'gb', 0)`
    )
    .run(path, path.split('/').pop());
  return Number(fi.lastInsertRowid);
};
const catalogPath = (db: Database.Database, oldPath: string) =>
  (
    db.prepare(`SELECT path FROM catalog_entity_files WHERE id=?`).get(`cf-${oldPath}`) as {
      path: string;
    }
  ).path;
const catalogMetadata = (db: Database.Database, oldPath: string) =>
  JSON.parse(
    (
      db.prepare(`SELECT metadata FROM catalog_entities WHERE id=?`).get(`ce-${oldPath}`) as {
        metadata: string;
      }
    ).metadata
  ) as Record<string, unknown>;
const limsRelPath = (db: Database.Database, id: string) =>
  JSON.parse(
    (db.prepare(`SELECT fields FROM lims_entity WHERE id=?`).get(id) as { fields: string }).fields
  ).sequence.relPath as string;

function writeNativeManifest(workspaceRoot: string, relativePath: string): void {
  const manifestPath = join(workspaceRoot, NATIVE_WORKSPACE_MANIFEST_PATH);
  mkdirSync(join(workspaceRoot, '.forge'), { recursive: true });
  writeFileSync(
    manifestPath,
    serializeNativeWorkspaceManifest({
      schema: 'dnaforge.native-workspace-manifest.v2',
      entities: [
        {
          id: 'sequence-portable',
          type: 'sequence',
          name: 'Portable sequence',
          placement: { kind: 'file', relativePath, fileKind: 'genbank' },
        },
      ],
      links: [],
    })
  );
}

describe('relocateEntityFile IPC orchestration', () => {
  let ws: string;
  let oldPath: string;
  let newPath: string;

  beforeEach(() => {
    hoisted.forceThrow = null;
    hoisted.afterMovePreparation.mockReset();
    materializeSpy.mockClear();
    testDb = createTestDb();
    testDb.pragma('foreign_keys = ON');
    ensureSchema(testDb, ':memory:');
    ws = mkdtempSync(join(tmpdir(), 'reloc-ipc-'));
    testDb.prepare(`INSERT INTO workspaces (id,name,path,created_at) VALUES (1,'W',?,0)`).run(ws);
    oldPath = join(ws, 'old.gb');
    newPath = join(ws, 'moved.gb');
    writeFileSync(oldPath, 'LOCUS old\n//\n');
  });

  afterEach(() => {
    testDb.close();
  });

  async function savedPrimer({ indirect = false, enroll = true } = {}) {
    const id = randomUUID();
    const path = join(ws, 'primers', 'registered.primer.json');
    mkdirSync(join(ws, 'primers'));
    const artifact = await buildPrimerArtifact({
      id,
      catalogNumber: 'P001',
      name: 'Registered primer',
      sequence: 'ACGTACGTACGT',
      workspaceRoot: ws,
      artifactPath: path,
      source: 'manual',
      now: 100,
      ...(indirect
        ? {
            binding: {
              id: randomUUID(),
              targetDocumentId: randomUUID(),
              targetFilePath: oldPath,
              targetLength: 100,
              targetTopology: 'linear' as const,
              targetFileContentHash: HASH('a'),
              targetNormalizedSequenceHash: HASH('b'),
              start: 0,
              end: 12,
              strand: 1 as const,
            },
          }
        : {}),
    });

    const bytes = indirect
      ? JSON.stringify({
          ...artifact,
          bindings: artifact.bindings.map((binding) => ({
            ...binding,
            target: { ...binding.target, workspaceRelativePath: 'old.gb' },
          })),
        })
      : serializePrimerArtifact(artifact);
    writeFileSync(path, bytes);
    const entity = registerLimsEntityInDb(testDb, {
      id,
      workspaceId: 1,
      kind: 'oligo',
      name: 'Registered primer',
      fields: {
        sequence: { mode: 'inline', bases: 'ACGTACGTACGT', length: 12, topology: 'linear' },
        artifact: { schema: 'dnaforge.primer', relativePath: 'primers/registered.primer.json' },
      },
    });
    testDb
      .prepare(
        `INSERT INTO catalog_entities
      (id,type,name,locator,storage_type,status,workspace_id,created_at,updated_at)
      VALUES(?,'primer','Registered primer',?,'file','active',1,1,1)`
      )
      .run(id, `file://${path}`);
    bindCatalogEntityFileInDb(testDb, {
      entityId: id,
      path,
      workspaceRoot: ws,
      fileKind: 'primer-artifact',
    });

    if (enroll)
      testDb
        .prepare(
          `INSERT INTO org_registry_local_records
      (org_id,account_id,entity_id,client_id,workspace_id,workspace_uuid,home_workspace_id,
      kind,local_schema_revision_id,authority_kind,schema_id,schema_revision_id,
      claim_mutation_id,claim_source_revision,claim_local_event_seq,created_at,updated_at)
      VALUES(?,?,?,?,1,?,?,'oligo',?,'primer_artifact',?,?,?,?,?,1,1)`
        )
        .run(
          randomUUID(),
          randomUUID(),
          id,
          randomUUID(),
          randomUUID(),
          randomUUID(),
          entity.schemaRevisionId,
          randomUUID(),
          randomUUID(),
          randomUUID(),
          'a'.repeat(64),
          entity.eventSeq
        );
    materializeSpy.mockClear();
    return { id, path, bytes };
  }

  const retainedPrimerState = () =>
    JSON.stringify({
      audit: testDb.prepare('SELECT * FROM lims_audit ORDER BY event_seq').all(),
      entities: testDb.prepare('SELECT * FROM lims_entity ORDER BY id').all(),
      files: testDb.prepare('SELECT * FROM catalog_entity_files ORDER BY id').all(),
      enrolled: testDb.prepare('SELECT * FROM org_registry_local_records ORDER BY entity_id').all(),
      pending: testDb.prepare('SELECT * FROM native_catalog_publication_outbox').all(),
    });

  it('refuses moving a folder containing a registered primer before files or journals change', async () => {
    const primer = await savedPrimer();
    const before = retainedPrimerState();
    await expect(
      relocateEntityFile({
        workspaceRoot: ws,
        oldPath: join(ws, 'primers'),
        newPath: join(ws, 'renamed'),
      })
    ).rejects.toThrow(/registered with an organization/);
    expect(readFileSync(primer.path, 'utf8')).toBe(primer.bytes);
    expect(existsSync(join(ws, 'renamed'))).toBe(false);
    expect(retainedPrimerState()).toBe(before);
    expect(materializeSpy).not.toHaveBeenCalled();
    expect(existsSync(join(ws, '.dnaforge/migration/native-workspace-manifest-move.v1.json'))).toBe(
      false
    );
  });

  it('refuses a target move that would rewrite a registered primer legacy reference', async () => {
    const primer = await savedPrimer({ indirect: true });
    const before = retainedPrimerState();
    await expect(relocateEntityFile({ workspaceRoot: ws, oldPath, newPath })).rejects.toThrow(
      /registered with an organization/
    );
    expect(readFileSync(primer.path, 'utf8')).toBe(primer.bytes);
    expect(readFileSync(oldPath, 'utf8')).toBe('LOCUS old\n//\n');
    expect(existsSync(newPath)).toBe(false);
    expect(retainedPrimerState()).toBe(before);
    expect(materializeSpy).not.toHaveBeenCalled();
  });

  it('refuses relinking a missing registered primer without reversing the external move', async () => {
    const primer = await savedPrimer();
    const moved = join(ws, 'external.primer.json');
    renameSync(primer.path, moved);
    testDb
      .prepare("UPDATE catalog_entity_files SET status='missing' WHERE entity_id=?")
      .run(primer.id);
    const before = retainedPrimerState();
    await expect(
      relinkMovedEntityFile({ workspaceRoot: ws, oldPath: primer.path, newPath: moved })
    ).rejects.toThrow(/registered with an organization/);
    expect(existsSync(primer.path)).toBe(false);
    expect(readFileSync(moved, 'utf8')).toBe(primer.bytes);
    expect(retainedPrimerState()).toBe(before);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses moving a registered primer through a directory alias',
    async () => {
      const primer = await savedPrimer();
      const alias = join(ws, 'alias');
      symlinkSync(join(ws, 'primers'), alias, 'dir');
      const before = retainedPrimerState();
      await expect(
        relocateEntityFile({
          workspaceRoot: ws,
          oldPath: join(alias, 'registered.primer.json'),
          newPath: join(ws, 'aliased-move.primer.json'),
        })
      ).rejects.toThrow(/registered with an organization/);
      expect(readFileSync(primer.path, 'utf8')).toBe(primer.bytes);
      expect(existsSync(join(ws, 'aliased-move.primer.json'))).toBe(false);
      expect(retainedPrimerState()).toBe(before);
    }
  );

  it('(a) happy path: moves the file and rebases catalog + indexed + LIMS in one op', async () => {
    const p = registerLimsEntityInDb(testDb, {
      workspaceId: 1,
      kind: 'plasmid',
      name: 'x',
      fields: { sequence: fileSeq(oldPath) },
    });
    seedCatalogFile(testDb, oldPath);
    const fileId = seedIndexed(testDb, oldPath);

    materializeSpy.mockClear();
    const result = await relocateEntityFile({ workspaceRoot: ws, oldPath, newPath });

    expect(result.newPath).toBe(newPath);
    expect(result.counts.lims.rebasedEntityIds).toEqual([p.id]);
    expect(existsSync(newPath)).toBe(true);
    expect(existsSync(oldPath)).toBe(false);
    expect(catalogPath(testDb, oldPath)).toBe(newPath);
    expect(limsRelPath(testDb, p.id)).toBe(newPath);
    expect(
      (testDb.prepare(`SELECT path FROM indexed_files WHERE id=?`).get(fileId) as { path: string })
        .path
    ).toBe(newPath);
    expect(materializeSpy).toHaveBeenCalledTimes(1);
  });

  it('updates a v2 direct-file placement in the same relocation operation', async () => {
    seedCatalogFile(testDb, oldPath, 'sequence-portable');
    writeNativeManifest(ws, 'old.gb');

    await relocateEntityFile({ workspaceRoot: ws, oldPath, newPath });

    const manifest = JSON.parse(readFileSync(join(ws, NATIVE_WORKSPACE_MANIFEST_PATH), 'utf8')) as {
      entities: Array<{ id: string; placement: { relativePath: string } }>;
    };
    expect(manifest.entities).toEqual([
      expect.objectContaining({
        id: 'sequence-portable',
        placement: expect.objectContaining({ relativePath: 'moved.gb' }),
      }),
    ]);
    expect(catalogMetadata(testDb, oldPath)).toMatchObject({
      portableId: 'sequence-portable',
      placement: { kind: 'file', relativePath: 'moved.gb' },
    });
    expect(existsSync(join(ws, '.dnaforge/migration/native-workspace-manifest-move.v1.json'))).toBe(
      false
    );
  });

  it('restores the v2 manifest and file when the catalog transaction fails', async () => {
    seedCatalogFile(testDb, oldPath, 'sequence-portable');
    writeNativeManifest(ws, 'old.gb');
    hoisted.forceThrow = new Error('injected catalog failure');

    await expect(relocateEntityFile({ workspaceRoot: ws, oldPath, newPath })).rejects.toThrow(
      'injected catalog failure'
    );

    expect(existsSync(oldPath)).toBe(true);
    expect(existsSync(newPath)).toBe(false);
    const manifest = JSON.parse(readFileSync(join(ws, NATIVE_WORKSPACE_MANIFEST_PATH), 'utf8')) as {
      entities: Array<{ placement: { relativePath: string } }>;
    };
    expect(manifest.entities[0]?.placement.relativePath).toBe('old.gb');
    expect(existsSync(join(ws, '.dnaforge/migration/native-workspace-manifest-move.v1.json'))).toBe(
      false
    );
  });

  it.each(['current', 'missing'])(
    'updates the same v2 placement when reconcile proves an external move from a %s binding',
    async (status) => {
      seedCatalogFile(testDb, oldPath, 'sequence-portable');
      writeNativeManifest(ws, 'old.gb');
      renameSync(oldPath, newPath);
      testDb.prepare('UPDATE catalog_entity_files SET status=? WHERE path=?').run(status, oldPath);

      await relinkMovedEntityFile({ workspaceRoot: ws, oldPath, newPath });

      const manifest = JSON.parse(
        readFileSync(join(ws, NATIVE_WORKSPACE_MANIFEST_PATH), 'utf8')
      ) as {
        entities: Array<{ placement: { relativePath: string } }>;
      };
      expect(manifest.entities[0]?.placement.relativePath).toBe('moved.gb');
      expect(catalogPath(testDb, oldPath)).toBe(newPath);
    }
  );

  it.each(['internal', 'external'] as const)(
    '%s move borrows the renderer mutation capability while a replica writer is queued',
    async (mode) => {
      const ownerId = 91;
      const releaseOuter = await acquireWorkspaceMutationShared(ws);
      const token = workspaceMutationCapabilities.issue(
        ownerId,
        workspaceMutationRootIdentity(ws),
        releaseOuter
      );
      let pullEntered = false;
      const pendingPull = acquireWorkspaceSyncMutationLease(ws).then((release) => {
        pullEntered = true;
        return release;
      });
      await Promise.resolve();
      expect(pullEntered).toBe(false);

      if (mode === 'external') renameSync(oldPath, newPath);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await expect(
          Promise.race([
            (mode === 'internal' ? relocateEntityFile : relinkMovedEntityFile)(
              { workspaceRoot: ws, oldPath, newPath, mutationToken: token },
              ownerId
            ),
            new Promise((_, reject) => {
              timeout = setTimeout(() => reject(new Error('Nested mutation lease stalled')), 1000);
            }),
          ])
        ).resolves.toMatchObject({ newPath });
        expect(pullEntered).toBe(false);
      } finally {
        clearTimeout(timeout);
        workspaceMutationCapabilities.release(token, ownerId);
        const release = await pendingPull;
        release();
      }

      const releasePull = await pendingPull;
      expect(pullEntered).toBe(true);
      releasePull();
    }
  );

  it.each([
    ['internal', 'internal'],
    ['internal', 'external'],
    ['external', 'internal'],
    ['external', 'external'],
  ] as const)(
    '%s capability move completes while an unrelated %s move waits for its lease',
    async (nestedMode, waitingMode) => {
      const ownerId = 92;
      const otherOld = join(ws, 'other.gb');
      const otherNew = join(ws, 'other-moved.gb');
      writeFileSync(otherOld, 'other sequence');
      if (waitingMode === 'external') renameSync(otherOld, otherNew);
      if (nestedMode === 'external') renameSync(oldPath, newPath);
      const releaseOuter = await acquireWorkspaceMutationShared(ws);
      const token = workspaceMutationCapabilities.issue(
        ownerId,
        workspaceMutationRootIdentity(ws),
        releaseOuter
      );
      let writerEntered = false;
      const pendingWriter = acquireWorkspaceSyncMutationLease(ws).then((release) => {
        writerEntered = true;
        return release;
      });
      let requested!: () => void;
      const leaseRequested = new Promise<void>((resolve) => {
        requested = resolve;
      });
      const original = mutationLease.withDeclaredWorkspaceMutation;
      const spy = vi
        .spyOn(mutationLease, 'withDeclaredWorkspaceMutation')
        .mockImplementation((...args) => {
          requested();
          return original(...args);
        });
      const waiting = (waitingMode === 'internal' ? relocateEntityFile : relinkMovedEntityFile)({
        workspaceRoot: ws,
        oldPath: otherOld,
        newPath: otherNew,
      });
      await leaseRequested;
      spy.mockRestore();
      const nested = (nestedMode === 'internal' ? relocateEntityFile : relinkMovedEntityFile)(
        { workspaceRoot: ws, oldPath, newPath, mutationToken: token },
        ownerId
      );
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await expect(
          Promise.race([
            nested,
            new Promise((_, reject) => {
              timeout = setTimeout(() => reject(new Error('Move lock order stalled')), 1000);
            }),
          ])
        ).resolves.toMatchObject({ newPath });
        expect(writerEntered).toBe(false);
      } finally {
        clearTimeout(timeout);
        workspaceMutationCapabilities.release(token, ownerId);
        releaseOuter();
        (await pendingWriter)();
        await Promise.allSettled([waiting, nested]);
      }
      await expect(waiting).resolves.toMatchObject({ newPath: otherNew });
      expect(existsSync(newPath)).toBe(true);
      expect(existsSync(otherNew)).toBe(true);
    }
  );

  it('(b) preflight rejects an OCCUPIED destination BEFORE moving — the file never leaves oldPath', async () => {
    registerLimsEntityInDb(testDb, {
      workspaceId: 1,
      kind: 'plasmid',
      name: 'x',
      fields: { sequence: fileSeq(oldPath) },
    });
    writeFileSync(newPath, 'something already here');

    await expect(relocateEntityFile({ workspaceRoot: ws, oldPath, newPath })).rejects.toThrow(
      /MOVE_EXISTS/
    );
    expect(existsSync(oldPath)).toBe(true);
  });

  it('preserves a destination claimed after preflight and retries with the same catalog identity', async () => {
    seedCatalogFile(testDb, oldPath);
    const original = readFileSync(oldPath);
    const occupant = Buffer.from('another writer');
    hoisted.afterMovePreparation.mockImplementationOnce(() =>
      writeFileSync(newPath, occupant, { flag: 'wx' })
    );
    await expect(relocateEntityFile({ workspaceRoot: ws, oldPath, newPath })).rejects.toThrow(
      'MOVE_EXISTS'
    );
    expect(readFileSync(newPath)).toEqual(occupant);
    expect(readFileSync(oldPath)).toEqual(original);
    expect(catalogPath(testDb, oldPath)).toBe(oldPath);
    const parked = join(ws, 'other-writer.gb');
    renameSync(newPath, parked);
    await expect(
      relocateEntityFile({ workspaceRoot: ws, oldPath, newPath })
    ).resolves.toMatchObject({ newPath });
    expect(readFileSync(parked)).toEqual(occupant);
    expect(readFileSync(newPath)).toEqual(original);
    expect(existsSync(oldPath)).toBe(false);
    expect(catalogPath(testDb, oldPath)).toBe(newPath);
  });
  it('settles only the unexecuted primer move when its destination is claimed and can retry it', async () => {
    const primer = await savedPrimer({ enroll: false });
    const relativePath = 'primers/renamed.primer.json';
    const destination = join(ws, relativePath);
    const pending = () =>
      testDb
        .prepare(
          "SELECT p.operation_id FROM native_catalog_publication_outbox p JOIN catalog_entity_events e ON e.id=p.operation_id WHERE e.entity_id=? AND e.event_type='primer_file_move_prepared'"
        )
        .all(primer.id);
    hoisted.afterMovePreparation.mockImplementationOnce(() => {
      expect(pending()).toHaveLength(1);
      writeFileSync(destination, 'intervening file', { flag: 'wx' });
    });
    const input = { workspaceRoot: ws, oldPath: primer.path, newPath: destination };
    await expect(relocateEntityFile(input)).rejects.toThrow('MOVE_EXISTS');
    expect(pending()).toEqual([]);
    expect(readFileSync(destination, 'utf8')).toBe('intervening file');
    expect(readFileSync(primer.path, 'utf8')).toBe(primer.bytes);
    renameSync(destination, join(ws, 'intervening-file'));
    await expect(relocateEntityFile(input)).resolves.toMatchObject({ newPath: destination });
    expect(pending()).toEqual([]);
    expect(
      readBoundPrimerArtifact(readFileSync(destination, 'utf8'), relativePath, primer.id).id
    ).toBe(primer.id);
    expect(
      testDb
        .prepare("SELECT path FROM catalog_entity_files WHERE entity_id=? AND status='current'")
        .all(primer.id)
    ).toEqual([{ path: destination }]);
  });
  it('(c) preflight rejects a uniqueness-violating move BEFORE moving (another active owner at newPath)', async () => {
    registerLimsEntityInDb(testDb, {
      workspaceId: 1,
      kind: 'plasmid',
      name: 'a',
      fields: { sequence: fileSeq(oldPath) },
    });

    registerLimsEntityInDb(testDb, {
      workspaceId: 1,
      kind: 'plasmid',
      name: 'b',
      fields: { sequence: fileSeq(newPath) },
    });

    await expect(relocateEntityFile({ workspaceRoot: ws, oldPath, newPath })).rejects.toThrow(
      /already owned/i
    );
    expect(existsSync(oldPath)).toBe(true);
    expect(existsSync(newPath)).toBe(false);
  });

  it('(d) preflight rejects a catalog-conflicting move BEFORE moving (stale catalog row at newPath)', async () => {
    registerLimsEntityInDb(testDb, {
      workspaceId: 1,
      kind: 'plasmid',
      name: 'a',
      fields: { sequence: fileSeq(oldPath) },
    });
    seedCatalogFile(testDb, oldPath);
    seedCatalogFile(testDb, newPath);

    await expect(relocateEntityFile({ workspaceRoot: ws, oldPath, newPath })).rejects.toThrow(
      /RELOCATE_CATALOG_CONFLICT/
    );
    expect(existsSync(oldPath)).toBe(true);
  });

  it('(e) a post-move failure COMPENSATES: file moved back to oldPath, DB unchanged', async () => {
    const p = registerLimsEntityInDb(testDb, {
      workspaceId: 1,
      kind: 'plasmid',
      name: 'x',
      fields: { sequence: fileSeq(oldPath) },
    });
    seedCatalogFile(testDb, oldPath);
    materializeSpy.mockClear();
    hoisted.forceThrow = new Error('boom in the atomic txn');

    await expect(relocateEntityFile({ workspaceRoot: ws, oldPath, newPath })).rejects.toThrow(
      /boom in the atomic txn/
    );

    expect(existsSync(oldPath)).toBe(true);
    expect(existsSync(newPath)).toBe(false);
    expect(catalogPath(testDb, oldPath)).toBe(oldPath);
    expect(limsRelPath(testDb, p.id)).toBe(oldPath);
    expect(materializeSpy).not.toHaveBeenCalled();
  });

  it('(f) oldPath === newPath is a no-op (zero counts, no fs churn)', async () => {
    registerLimsEntityInDb(testDb, {
      workspaceId: 1,
      kind: 'plasmid',
      name: 'x',
      fields: { sequence: fileSeq(oldPath) },
    });
    const result = await relocateEntityFile({ workspaceRoot: ws, oldPath, newPath: oldPath });
    expect(result.counts.lims.rebasedEntityIds).toEqual([]);
    expect(existsSync(oldPath)).toBe(true);
  });

  it('(g) a cross-workspace move (newPath outside workspaceRoot) is REJECTED before the file moves', async () => {
    registerLimsEntityInDb(testDb, {
      workspaceId: 1,
      kind: 'plasmid',
      name: 'x',
      fields: { sequence: fileSeq(oldPath) },
    });
    const otherWs = mkdtempSync(join(tmpdir(), 'reloc-ipc-other-'));
    await expect(
      relocateEntityFile({ workspaceRoot: ws, oldPath, newPath: join(otherWs, 'moved.gb') })
    ).rejects.toThrow(/RELOCATE_CROSS_WORKSPACE/);
    expect(existsSync(oldPath)).toBe(true);
  });

  it('(h) concurrent moves to the SAME destination SERIALIZE — one wins, one gets MOVE_EXISTS, no overwrite', async () => {
    const aOld = join(ws, 'a.gb');
    const bOld = join(ws, 'b.gb');
    const dest = join(ws, 'dest.gb');
    writeFileSync(aOld, 'AAA');
    writeFileSync(bOld, 'BBB');
    registerLimsEntityInDb(testDb, {
      workspaceId: 1,
      kind: 'plasmid',
      name: 'a',
      fields: { sequence: fileSeq(aOld) },
    });
    registerLimsEntityInDb(testDb, {
      workspaceId: 1,
      kind: 'plasmid',
      name: 'b',
      fields: { sequence: fileSeq(bOld) },
    });

    const results = await Promise.allSettled([
      relocateEntityFile({ workspaceRoot: ws, oldPath: aOld, newPath: dest }),
      relocateEntityFile({ workspaceRoot: ws, oldPath: bOld, newPath: dest }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0].reason)).toMatch(/MOVE_EXISTS/);
    expect(existsSync(dest)).toBe(true);

    expect(existsSync(aOld) !== existsSync(bOld)).toBe(true);
  });

  it('(i) an unwritable affected .primer.json ABORTS the move (fail-closed) — file back at oldPath, DB unchanged', async () => {
    const p = registerLimsEntityInDb(testDb, {
      workspaceId: 1,
      kind: 'plasmid',
      name: 'x',
      fields: { sequence: fileSeq(oldPath) },
    });
    seedCatalogFile(testDb, oldPath);

    const primer = join(ws, 'p.primer.json');
    writeFileSync(
      primer,
      JSON.stringify({
        schema: 'dnaforge.primer',
        file: { workspaceRelativePath: 'p.primer.json' },
        bindings: [
          { id: 'b0', relation: 'binds_to_sequence', target: { workspaceRelativePath: 'old.gb' } },
        ],
      })
    );

    mkdirSync(`${primer}.reloc.tmp`, { recursive: true });
    materializeSpy.mockClear();

    await expect(relocateEntityFile({ workspaceRoot: ws, oldPath, newPath })).rejects.toThrow(
      /RELOCATE_PRIMER_WRITE_FAILED/
    );

    expect(existsSync(oldPath)).toBe(true);
    expect(existsSync(newPath)).toBe(false);
    expect(catalogPath(testDb, oldPath)).toBe(oldPath);
    expect(limsRelPath(testDb, p.id)).toBe(oldPath);
    expect(materializeSpy).not.toHaveBeenCalled();
  });
});

import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb } from '../__tests__/test-db';
import { ensureSchema } from '../schema';
import {
  queryProviderBindingCandidates,
  upsertProviderBinding,
} from '../catalog-provider-bindings';
import { isValidationReportV2, type MigrationRun } from '../../shared/benchling-migration';
import { buildSyntheticNativeExportZip } from './__fixtures__/native-export-zip-fixture';
import { ContentArchive } from './content-archive';
import { executeLocalBundleMigration } from './local-bundle-executor';
import { intakeLocalBenchlingExportBundle } from './local-export-bundle';
import { resolveProviderReference } from './provider-reference-resolver';
import { MigrationStore } from './store';
import { finalizeUnlockedMigrationRecovery, unlockMigrationWorkspace } from './staging-workspace';
import { appendBenchlingExportsToWorkspace } from './workspace-append-executor';

const PROVIDER = 'benchling';
const INTENDED = 'seq_DemoSeq004';
const TWIN = 'seq_DEMOSQ0004';

describe('provider reference resolution matrix', () => {
  it('resolves both exact edges of a complete import', () => {
    for (const stableObjectId of [INTENDED, 'etr_NOTEBOOKB']) {
      expect(
        resolveProviderReference({
          reference: reference(
            stableObjectId,
            stableObjectId.startsWith('seq_') ? 'sequence' : 'notebook'
          ),
          destinationWorkspaceId: 'ws-1',
          allowedWorkspaceIds: ['ws-1'],
          candidates: [
            candidate(
              `entity-${stableObjectId}`,
              stableObjectId.startsWith('seq_') ? 'sequence' : 'notebook'
            ),
          ],
        })
      ).toEqual({
        status: 'resolved',
        entityId: `entity-${stableObjectId}`,
        scope: 'workspace',
        evidence: 'stable_id',
      });
    }
  });

  it('reports pending before the target is imported, and resolved after', () => {
    const before = resolveProviderReference({
      reference: reference(INTENDED),
      destinationWorkspaceId: 'ws-1',
      allowedWorkspaceIds: ['ws-1'],
      candidates: [],
    });
    const after = resolveProviderReference({
      reference: reference(INTENDED),
      destinationWorkspaceId: 'ws-1',
      allowedWorkspaceIds: ['ws-1'],
      candidates: [candidate('entity-intended')],
    });

    expect(before).toEqual({ status: 'pending', reason: 'target_not_imported' });
    expect(after).toMatchObject({ status: 'resolved', entityId: 'entity-intended' });
  });

  it('resolves immediately when the target was imported first', () => {
    expect(
      resolveProviderReference({
        reference: reference(INTENDED),
        destinationWorkspaceId: 'ws-1',
        allowedWorkspaceIds: ['ws-1'],
        candidates: [candidate('entity-intended')],
      })
    ).toMatchObject({ status: 'resolved', entityId: 'entity-intended' });
  });

  it('refuses to resolve a reference whose export carried no stable identity', () => {
    expect(
      resolveProviderReference({
        reference: null,
        destinationWorkspaceId: 'ws-1',
        allowedWorkspaceIds: ['ws-1'],
        candidates: [candidate('entity-twin')],
      })
    ).toEqual({ status: 'pending', reason: 'identity_missing' });
  });

  it('resolves to a reviewed mapping when a human made one', () => {
    expect(
      resolveProviderReference({
        reference: reference(INTENDED),
        destinationWorkspaceId: 'ws-1',
        allowedWorkspaceIds: ['ws-1'],
        candidates: [candidate('entity-reviewed', 'sequence', { bindingKind: 'reviewed' })],
      })
    ).toEqual({
      status: 'resolved',
      entityId: 'entity-reviewed',
      scope: 'workspace',
      evidence: 'reviewed_mapping',
    });
  });

  it('reuses an exact entity that lives in another mounted workspace', () => {
    expect(
      resolveProviderReference({
        reference: reference(INTENDED),
        destinationWorkspaceId: 'ws-1',
        allowedWorkspaceIds: ['ws-1', 'ws-2'],
        candidates: [candidate('entity-elsewhere', 'sequence', { workspaceId: 'ws-2' })],
      })
    ).toMatchObject({ status: 'resolved', entityId: 'entity-elsewhere' });
  });

  it('stays pending when the only exact entity is in a workspace that is not allowed', () => {
    expect(
      resolveProviderReference({
        reference: reference(INTENDED),
        destinationWorkspaceId: 'ws-1',
        allowedWorkspaceIds: ['ws-1'],
        candidates: [candidate('entity-unmounted', 'sequence', { workspaceId: 'ws-trashed' })],
      })
    ).toEqual({ status: 'pending', reason: 'target_not_imported' });
  });

  it('reuses an existing sequence package rather than importing a second copy', () => {
    expect(
      resolveProviderReference({
        reference: reference(INTENDED),
        destinationWorkspaceId: 'ws-1',
        allowedWorkspaceIds: ['ws-1'],
        candidates: [candidate('entity-package'), candidate('entity-package')],
      })
    ).toMatchObject({ status: 'resolved', entityId: 'entity-package' });
  });

  it('reuses a visible registry entity', () => {
    expect(
      resolveProviderReference({
        reference: reference(INTENDED),
        destinationWorkspaceId: 'ws-1',
        allowedWorkspaceIds: ['ws-1'],
        allowedRegistryEntityIds: ['registry-entity'],
        candidates: [
          candidate('registry-entity', 'sequence', { scope: 'registry', workspaceId: null }),
        ],
      })
    ).toEqual({
      status: 'resolved',
      entityId: 'registry-entity',
      scope: 'registry',
      evidence: 'stable_id',
    });
  });

  it('refuses to choose between two exact candidates', () => {
    expect(
      resolveProviderReference({
        reference: reference(INTENDED),
        allowedWorkspaceIds: ['ws-1', 'ws-2'],
        candidates: [
          candidate('entity-a', 'sequence', { workspaceId: 'ws-1' }),
          candidate('entity-b', 'sequence', { workspaceId: 'ws-2' }),
        ],
      })
    ).toEqual({
      status: 'ambiguous',
      candidateEntityIds: ['entity-a', 'entity-b'],
      reason: 'multiple_exact_candidates',
    });
  });

  it('preserves an external reference to a person', () => {
    expect(
      resolveProviderReference({
        reference: reference('prt_PERSON1', 'person'),
        disposition: 'external',
        sourceUrl: 'https://benchling.com/exampleuser/f/lib_x/prt_PERSON1/edit',
        destinationWorkspaceId: 'ws-1',
        allowedWorkspaceIds: ['ws-1'],
      })
    ).toEqual({
      status: 'external',
      sourceUrl: 'https://benchling.com/exampleuser/f/lib_x/prt_PERSON1/edit',
    });
  });

  it('preserves a link that was already broken at the source', () => {
    expect(
      resolveProviderReference({
        reference: reference(INTENDED),
        disposition: 'source_broken',
        brokenReason: 'The linked item was deleted in Benchling.',
        destinationWorkspaceId: 'ws-1',
        allowedWorkspaceIds: ['ws-1'],
      })
    ).toEqual({
      status: 'source_broken',
      reason: 'The linked item was deleted in Benchling.',
    });
  });

  it('never offers the same-named, byte-identical twin as a candidate', () => {
    const db = createTestDb();
    ensureSchema(db, ':memory:');
    seedWorkspace(db, 1);
    seedEntity(db, 'sequence-intended', 1, 'Controlled Corpus Sequence');
    seedEntity(db, 'sequence-twin', 1, 'Controlled Corpus Sequence');
    upsertProviderBinding(db, {
      reference: {
        provider: PROVIDER,
        stableObjectId: INTENDED,
        objectClass: 'sequence',
        canonicalUrl: null,
        providerAccountHint: null,
      },
      entityId: 'sequence-intended',
      bindingKind: 'observed',
      evidence: { source: 'benchling_export_filename' },
    });
    upsertProviderBinding(db, {
      reference: {
        provider: PROVIDER,
        stableObjectId: TWIN,
        objectClass: 'sequence',
        canonicalUrl: null,
        providerAccountHint: null,
      },
      entityId: 'sequence-twin',
      bindingKind: 'observed',
      evidence: { source: 'benchling_export_filename' },
    });

    const candidates = queryProviderBindingCandidates(db, {
      provider: PROVIDER,
      stableObjectId: INTENDED,
      objectClass: 'sequence',
      allowedWorkspaceIds: [1],
      allowedRegistryEntityIds: [],
    });

    expect(candidates.map((entry) => entry.entityId)).toEqual(['sequence-intended']);
    expect(
      resolveProviderReference({
        reference: reference(INTENDED),
        candidates,
        allowedWorkspaceIds: ['1'],
        destinationWorkspaceId: '1',
      })
    ).toMatchObject({
      status: 'resolved',
      entityId: 'sequence-intended',
    });
    db.close();
  });

  it('does not offer an entity from a workspace the caller did not allow', () => {
    const db = createTestDb();
    ensureSchema(db, ':memory:');
    seedWorkspace(db, 1);
    seedWorkspace(db, 2);
    seedEntity(db, 'sequence-elsewhere', 2, 'Elsewhere');
    upsertProviderBinding(db, {
      reference: {
        provider: PROVIDER,
        stableObjectId: INTENDED,
        objectClass: 'sequence',
        canonicalUrl: null,
        providerAccountHint: null,
      },
      entityId: 'sequence-elsewhere',
      bindingKind: 'observed',
      evidence: { source: 'benchling_export_filename' },
    });

    expect(
      queryProviderBindingCandidates(db, {
        provider: PROVIDER,
        stableObjectId: INTENDED,
        objectClass: 'sequence',
        allowedWorkspaceIds: [1],
        allowedRegistryEntityIds: [],
      })
    ).toEqual([]);
    db.close();
  });

  it('does not offer an entity of a different object class', () => {
    const db = createTestDb();
    ensureSchema(db, ':memory:');
    seedWorkspace(db, 1);
    seedEntity(db, 'notebook-entity', 1, 'A notebook', 'notebook');
    upsertProviderBinding(db, {
      reference: {
        provider: PROVIDER,
        stableObjectId: INTENDED,
        objectClass: 'notebook',
        canonicalUrl: null,
        providerAccountHint: null,
      },
      entityId: 'notebook-entity',
      bindingKind: 'observed',
      evidence: { source: 'benchling_export_filename' },
    });

    expect(
      queryProviderBindingCandidates(db, {
        provider: PROVIDER,
        stableObjectId: INTENDED,
        objectClass: 'sequence',
        allowedWorkspaceIds: [1],
        allowedRegistryEntityIds: [],
      })
    ).toEqual([]);
    db.close();
  });
});

function reference(stableObjectId: string, objectClass = 'sequence') {
  return {
    provider: PROVIDER,
    stableObjectId,
    objectClass,
    canonicalUrl: null,
    providerAccountHint: null,
  } as Parameters<typeof resolveProviderReference>[0]['reference'];
}

function candidate(
  entityId: string,
  objectClass = 'sequence',
  overrides: Partial<{
    bindingKind: 'observed' | 'reviewed';
    scope: 'workspace' | 'registry';
    workspaceId: string | null;
  }> = {}
) {
  return {
    entityId,
    objectClass,
    bindingKind: overrides.bindingKind ?? ('observed' as const),
    scope: overrides.scope ?? ('workspace' as const),
    workspaceId: overrides.workspaceId === undefined ? 'ws-1' : overrides.workspaceId,
    providerAccountHint: null,
  };
}

function seedWorkspace(db: ReturnType<typeof createTestDb>, id: number): void {
  db.prepare('INSERT INTO workspaces (id, name, path, created_at) VALUES (?, ?, ?, 0)').run(
    id,
    `Workspace ${id}`,
    `/tmp/workspace-${id}`
  );
}

function seedEntity(
  db: ReturnType<typeof createTestDb>,
  id: string,
  workspaceId: number,
  name: string,
  type = 'sequence'
): void {
  db.prepare(
    `INSERT INTO catalog_entities
       (id, type, name, locator, storage_type, status, workspace_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'file', 'active', ?, 0, 0)`
  ).run(id, type, name, `file:${id}`, workspaceId);
}

describe('Benchling import order does not change the result', () => {
  let root: string;
  let nextNow: () => string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'reference-resolution-order-'));
    nextNow = monotonicClock('2026-08-20T21:00:00.000Z');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reaches an identical destination whichever export is imported first', async () => {
    const notebooksFirst = await importInOrder('notebooks-first', 'notebook', 'sequence');
    const targetsFirst = await importInOrder('targets-first', 'sequence', 'notebook');

    expect(targetsFirst.destinations).toEqual(notebooksFirst.destinations);
    expect(targetsFirst.entities).toEqual(notebooksFirst.entities);
    expect(targetsFirst.bindings).toEqual(notebooksFirst.bindings);
    expect(targetsFirst.links).toEqual(notebooksFirst.links);
    expect(targetsFirst.referenceCounts).toEqual(notebooksFirst.referenceCounts);

    expect(notebooksFirst.bindings.map((row) => row.stable_object_id)).toContain(INTENDED);
    expect(notebooksFirst.referenceCounts?.resolved).toBeGreaterThan(0);
  });

  type OrderResult = {
    destinations: string[];
    entities: unknown[];
    bindings: Array<{ stable_object_id: string; entity_id: string; binding_kind: string }>;
    links: unknown[];
    referenceCounts: Record<string, number> | undefined;
  };

  async function importInOrder(
    label: string,
    firstKind: 'notebook' | 'sequence',
    secondKind: 'notebook' | 'sequence'
  ): Promise<OrderResult> {
    const workspacePath = join(root, label);
    const archive = new ContentArchive(join(workspacePath, '.dnaforge', 'migration', 'archive'));
    const store = new MigrationStore(createTestDb(), true);
    const globalDb = createTestDb();
    ensureSchema(globalDb, ':memory:');
    try {
      const sourcePath = await writeZip(label, 'original.zip', [
        entryFor(firstKind, 'Selected Root/'),
      ]);
      const artifact = await intakeLocalBenchlingExportBundle({ workspacePath, sourcePath });
      if (artifact.format !== 'zip') throw new Error('Expected a ZIP artifact.');
      const run = runFor(workspacePath, artifact);
      store.saveRun(run);
      const result = await executeLocalBundleMigration(run, {
        store,
        archive,
        now: nextNow,
        renderValidator: passingRenderValidator,
        persistPassedReport: async () => undefined,
      });
      if (result.run.state !== 'ready_to_unlock') {
        throw new Error(`${label}: original import did not validate (${result.run.state}).`);
      }
      await unlockMigrationWorkspace({
        workspacePath,
        globalDb,
        now: nextNow,
        openStore: () => nonClosing(store),
        finalizationDeps: finalizationDeps(globalDb),
      });

      const appendPath = await writeZip(label, 'appended.zip', [entryFor(secondKind, '')]);
      await appendBenchlingExportsToWorkspace(store.getRun()!, [appendPath], {
        store,
        archive,
        now: nextNow,
        renderValidator: passingRenderValidator,
        persistPassedReport: async () => undefined,
        listFilesAtHead: async () => listImportedFiles(workspacePath),
        finalizeUnlockedRecovery: (updated, report) =>
          finalizeUnlockedMigrationRecovery({
            run: updated,
            report,
            store,
            globalDb,
            now: nextNow,
            finalizationDeps: finalizationDeps(globalDb),
          }),
      });

      const report = store.getValidationReport(run.id);
      return {
        destinations: store
          .listProjectionReceipts(run.id)
          .map((receipt) => `${receipt.sourceObjectId} -> ${receipt.destinationObjectId}`)
          .sort(),
        entities: globalDb.prepare('SELECT id, type, name FROM catalog_entities ORDER BY id').all(),
        bindings: globalDb
          .prepare(
            `SELECT stable_object_id, entity_id, binding_kind
               FROM catalog_provider_bindings ORDER BY stable_object_id, entity_id`
          )
          .all() as OrderResult['bindings'],
        links: globalDb
          .prepare(
            `SELECT source_entity_id, relation, target_entity_id
               FROM catalog_entity_links
              ORDER BY source_entity_id, relation, target_entity_id`
          )
          .all(),
        referenceCounts:
          report && isValidationReportV2(report) ? report.providerReferences?.counts : undefined,
      };
    } finally {
      store.close();
      globalDb.close();
    }
  }

  function entryFor(kind: 'notebook' | 'sequence', prefix: string) {
    return kind === 'notebook'
      ? {
          path: `${prefix}Order Notebook (etr_ORDERNB).html`,
          bytes:
            '<!doctype html><html><body><h1>Order Notebook</h1>' +
            `<div class="note-entry" data-test-component="NoteDropTarget" data-test-element="noteLinkedFilePreview"><a href="https://benchling.com/exampleuser/f/lib_SELECTED_ROOT-selected-root/${INTENDED}-corpus-sequence/edit"><div class="note-itemName" data-test-element="previewItemName">Controlled Corpus Sequence</div></a></div>` +
            '</body></html>',
        }
      : {
          path: `${prefix}Controlled Corpus Sequence (${INTENDED}).gb`,
          bytes: [
            `LOCUS       ${INTENDED}       8 bp    DNA     linear`,
            'DEFINITION  Controlled Corpus Sequence.',
            'FEATURES             Location/Qualifiers',
            'ORIGIN',
            '        1 acgtacgt',
            '//',
            '',
          ].join('\n'),
        };
  }

  function runFor(
    workspacePath: string,
    artifact: Awaited<ReturnType<typeof intakeLocalBenchlingExportBundle>>
  ): MigrationRun {
    if (artifact.format !== 'zip') throw new Error('Expected a ZIP artifact.');
    return {
      version: 1,
      id: 'run-reference-order',
      workspaceId: 'workspace-reference-order',
      workspacePath,
      displayName: 'Reference order',
      scope: {
        version: 1,
        kind: 'folder',
        acquisition: 'local_bundle',
        folder: {
          id: 'lib_SELECTED_ROOT',
          url: 'https://benchling.com/exampleuser/f_/lib_SELECTED_ROOT-selected-root',
          objectType: 'folder',
        },
        includeChildren: false,
        includeArchived: false,
      },
      binding: null,
      state: 'scope_planning',
      resumeState: null,
      attempt: 0,
      converterVersions: {},
      createdAt: nextNow(),
      updatedAt: nextNow(),
      startedAt: nextNow(),
      unlockedAt: null,
      lastError: null,
      localExportArtifact: {
        schema: artifact.schema,
        format: artifact.format,
        logicalFilename: artifact.logicalFilename,
        sha256: artifact.sha256,
        sizeBytes: artifact.sizeBytes,
        immutableLocalPath: artifact.immutableLocalPath,
        capturedAt: nextNow(),
        archive: artifact.archive,
        resources: [],
      },
    };
  }

  async function writeZip(
    label: string,
    filename: string,
    entries: Parameters<typeof buildSyntheticNativeExportZip>[0]
  ): Promise<string> {
    const fixture = buildSyntheticNativeExportZip(entries);
    const path = join(root, label, 'exports', filename);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.from(fixture.bytes));
    return path;
  }

  async function listImportedFiles(workspacePath: string): Promise<string[]> {
    const files: string[] = [];
    const walk = async (absolute: string, relative: string): Promise<void> => {
      for (const entry of await readdir(absolute, { withFileTypes: true })) {
        const next = join(absolute, entry.name);
        const nextRelative = `${relative}/${entry.name}`;
        if (entry.isDirectory()) await walk(next, nextRelative);
        else if (entry.isFile()) files.push(nextRelative);
      }
    };
    await walk(join(workspacePath, 'Benchling Imports'), 'Benchling Imports');
    return files.sort();
  }

  function finalizationDeps(globalDb: ReturnType<typeof createTestDb>) {
    return {
      resolveHeadCommit: async () => 'a'.repeat(40),
      commitAllIfDirty: async () => 'b'.repeat(40),
      openTransactionDb: () => ({ db: globalDb, close: () => undefined }),
    };
  }

  function nonClosing(target: MigrationStore): MigrationStore {
    return new Proxy(target, {
      get(storeTarget, property, receiver) {
        if (property === 'close') return () => undefined;
        const value = Reflect.get(storeTarget, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(storeTarget) : value;
      },
    });
  }

  async function passingRenderValidator(input: {
    selectedSourceObjectIds: readonly string[];
  }): Promise<Array<{ sourceObjectId: string; passed: boolean }>> {
    return input.selectedSourceObjectIds.map((sourceObjectId) => ({
      sourceObjectId,
      passed: true,
    }));
  }
});

function monotonicClock(start: string): () => string {
  let value = Date.parse(start);
  return () => {
    value += 1_000;
    return new Date(value).toISOString();
  };
}

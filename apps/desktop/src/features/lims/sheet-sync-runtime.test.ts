import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LimsImportPlan } from '../../shared/lims';
import type { SheetSyncConnection, SheetSyncSnapshot } from './sheet-sync-connection';
import { parseSheetSyncConnection, sheetSyncConnectionRelativePath } from './sheet-sync-connection';
import { sha256Hex } from '../primers/public/primer-artifact';
import { createSheetSyncRuntime } from '../../shared/registry-artifacts/sheet-sync/runtime';
import { createSheetSyncPersistence } from '../../shared/registry-artifacts/sheet-sync/persistence';
import { createSheetSyncSources } from '../../shared/registry-artifacts/sheet-sync/sources';
import { resolveWorkspaceId } from '../../db/workspace-catalog';
import { withRendererWorkspaceMutation } from '../../services/workspace-mutation-transaction';
import { readPrimerArtifactAtPath } from '../primers/primer-artifact-service';
import { createLimsImportPlan } from './ingress';
import { scientificIdentityPath } from '@waypoint/scientific-objects';
const mocks = vi.hoisted(() => ({
  fs: { exists: vi.fn(), readTextFile: vi.fn(), writeWorkspaceTextFileAtomic: vi.fn() },
  readSource: vi.fn(),
  googleWorksheet: vi.fn(),
  googleGrant: vi.fn(),
  query: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  importSet: vi.fn(),
  reconcile: vi.fn(),
  authorization: vi.fn(),
  acknowledgement: vi.fn(),
  acknowledged: vi.fn(),
  gitRepo: vi.fn(),
  gitStatus: vi.fn(),
  gitCommit: vi.fn(),
  gitHead: vi.fn(),
  gitShow: vi.fn(),
}));
vi.mock('../../platform', () => ({
  platform: () => ({ fs: mocks.fs, googleSheets: { worksheet: mocks.googleWorksheet } }),
}));
vi.mock('../../db/workspace-catalog', () => ({ resolveWorkspaceId: vi.fn(async () => 1) }));
vi.mock('../../services/workspace-mutation-transaction', () => ({
  withRendererWorkspaceMutation: async (
    _root: string,
    operation: (token: string) => Promise<unknown>
  ) => operation('project-lease'),
}));
vi.mock('../../services/workspace-operations', () => ({
  reconcileWorkspaceAfterFilesChanged: mocks.reconcile,
}));
vi.mock('../../services/lims-entity-mutations', () => ({ updateLimsEntity: mocks.update }));
const localFunctions = {
  localSheetSyncAuthorization: mocks.authorization,
  localGoogleSheetSyncGrant: mocks.googleGrant,
  authorizeGoogleSheetSync: vi.fn(),
  authorizeLocalSheetSync: vi.fn(),
  setLocalSheetSyncActive: vi.fn(),
  sheetSyncFinalizationAcknowledged: mocks.acknowledged,
  acknowledgeSheetSyncFinalization: mocks.acknowledgement,
};
vi.mock('../workspace/git', () => ({
  isGitRepo: mocks.gitRepo,
  gitStatus: mocks.gitStatus,
  gitCommitPaths: mocks.gitCommit,
  gitHead: mocks.gitHead,
  gitShowCommit: mocks.gitShow,
}));
vi.mock('../primers/primer-artifact-service', () => ({ readPrimerArtifactAtPath: vi.fn() }));
vi.mock('./operations', () => ({ queryLimsEntities: mocks.query }));
vi.mock('./import-set', () => ({ persistImportSet: mocks.importSet }));
vi.mock('./excel-sync-source', () => ({ readExcelSyncSource: mocks.readSource }));
const artifactFunctions = {
  createSheetSyncArtifact: mocks.create,
  updateSheetSyncPrimer: vi.fn(),
  sheetSyncCreateIntent: async (_connection: unknown, row: { key: string }) => ({
    owner: 'record' as const,
    key: row.key,
    entityId: crypto.randomUUID(),
  }),
  sheetSyncEntityRecord: (
    entity: { kind: string; name: string; fields: Record<string, unknown> },
    scope: { fields: Record<string, unknown> }
  ) => ({
    kind: entity.kind,
    name: entity.name,
    fields: Object.fromEntries(
      Object.keys(scope.fields)
        .filter((key) => Object.hasOwn(entity.fields, key))
        .map((key) => [key, entity.fields[key]])
    ),
  }),
};
function unexpectedArtifactPort(): never {
  throw new Error('This runtime fixture does not configure an artifact owner.');
}
const persistenceFiles = { ...mocks.fs, readDir: unexpectedArtifactPort };
const sources = createSheetSyncSources({
  createLimsImportPlan,
  readFile: unexpectedArtifactPort,
});
const { createExcelSheetSyncConnection, pullExcelSheetConnection } = createSheetSyncRuntime({
  fs: persistenceFiles,
  resolveWorkspaceId,
  withRendererWorkspaceMutation,
  recordPrimers: unexpectedArtifactPort,
  readPrimerArtifactAtPath,
  reconcilePrimerArtifact: unexpectedArtifactPort,
  updatePrimerArtifactContent: unexpectedArtifactPort,
  recordProtein: unexpectedArtifactPort,
  recordEntityArtifact: unexpectedArtifactPort,
  resolvePrimerSchema: unexpectedArtifactPort,
  calculatePrimerTm: unexpectedArtifactPort,
  queryLimsEntities: mocks.query,
  reconcileWorkspaceAfterFilesChanged: mocks.reconcile,
  updateLimsEntity: mocks.update,
  persistImportSet: mocks.importSet,
  isGitRepo: mocks.gitRepo,
  gitStatus: mocks.gitStatus,
  gitCommitPaths: mocks.gitCommit,
  gitHead: mocks.gitHead,
  gitShowCommit: mocks.gitShow,
  googleSheets: { worksheet: mocks.googleWorksheet, status: unexpectedArtifactPort },
  newConnectionId: () => crypto.randomUUID(),
  publicationPaths: async (root, dirty) => {
    if (
      files.has(`${root}/${scientificIdentityPath}`) ||
      [...dirty.keys()].some((path) => path.startsWith('.dnaforge/relationships/'))
    )
      throw new Error('This runtime fixture does not configure an accepted scientific namespace.');
    return [];
  },
  ...createSheetSyncPersistence(persistenceFiles),
  ...sources,
  ...localFunctions,
  ...artifactFunctions,
  readExcelSyncSource: mocks.readSource,
});
const files = new Map<string, string>();
const entities = new Map<
  string,
  {
    id: string;
    kind: string;
    name: string;
    fields: Record<string, unknown>;
    eventSeq: number;
    tombstone: boolean;
    archivedAt: number | null;
  }
>();
const connection: SheetSyncConnection = {
  schema: 'dnaforge.sheet-sync',
  schemaVersion: 1,
  id: 'd788e456-ebdf-4672-818c-d5e6a1ff99b4',
  importSetId: 'connected-import-set',
  source: {
    path: '/master.xlsx',
    sheetName: 'Strains',
    keyColumn: 'ID',
    forcedKind: 'strain',
    columnMappings: [],
  },
  destinationRelativePath: '',
  revision: `sha256:${'0'.repeat(64)}`,
  enabled: true,
  pending: null,
  finalization: null,
  checkpoints: [],
};
const connectionPath = `/project/${sheetSyncConnectionRelativePath(connection.id)}`;
let failCheckpoint = false;
let finalizationFailure: 'after-revision' | 'import-set' | 'reconcile' | 'commit' | null = null;
const acknowledgements = new Set<string>();
const committedFiles = new Map<string, string>();
function source(rows: Array<{ key: string; name: string; notes: string }>, revision = 'a') {
  const mapped = rows.map((row) => ({
    key: row.key,
    record: { kind: 'strain', name: row.name, fields: { notes: row.notes } },
  }));
  const plan: LimsImportPlan = {
    id: 'source-plan',
    sourceName: 'master.xlsx',
    sourceKind: 'xlsx',
    detectedKind: 'strain_table',
    selectedSheet: 'Strains',
    forcedKind: 'strain',
    columns: [
      {
        sourceColumn: 'ID',
        mappingMode: 'source_only',
        confidence: 'user_overridden',
        warnings: [],
      },
      {
        sourceColumn: 'Name',
        mappedField: 'entity.name',
        mappingMode: 'mapped',
        confidence: 'user_overridden',
        warnings: [],
      },
    ],
    records: rows.map((row) => ({
      id: `row-${row.key}`,
      externalRowId: row.key,
      accepted: true,
      action: 'create',
      entityDraft: { kind: 'strain', name: row.name, fields: { notes: row.notes } },
      source: { ID: row.key, Name: row.name },
      duplicateCandidates: [],
      proposedLinks: [],
      unresolvedLinks: [],
      errors: [],
      warnings: [],
    })),
    aggregateWarnings: [],
    canApply: true,
    oracle: { ok: true, source: 'master.xlsx', invariants: [] },
  };
  return { bytes: new Uint8Array(), revision: `sha256:${revision.repeat(64)}`, plan, rows: mapped };
}
function stored() {
  return parseSheetSyncConnection(files.get(connectionPath) ?? '');
}
beforeEach(() => {
  vi.resetAllMocks();
  files.clear();
  entities.clear();
  failCheckpoint = false;
  finalizationFailure = null;
  acknowledgements.clear();
  committedFiles.clear();
  mocks.authorization.mockResolvedValue('authorized');
  mocks.acknowledged.mockImplementation(
    async (_root: string, value: SheetSyncConnection) =>
      !value.finalization || acknowledgements.has(value.finalization.id)
  );
  mocks.acknowledgement.mockImplementation(async (_root: string, value: SheetSyncConnection) => {
    if (!value.finalization) throw new Error('Missing finalization');
    acknowledgements.add(value.finalization.id);
  });
  mocks.gitRepo.mockResolvedValue(false);
  mocks.gitStatus.mockImplementation(
    async () =>
      new Map(
        [...files.entries()]
          .filter(([path, content]) => committedFiles.get(path) !== content)
          .map(([path]) => [path.replace('/project/', ''), 'modified'])
      )
  );
  mocks.gitHead.mockResolvedValue('verified-test-commit');
  mocks.gitShow.mockImplementation(
    async (path: string, _commit: string, _root: string, token?: string) => {
      if (token !== 'project-lease')
        throw new Error('History verification must reuse the held project lease');
      return committedFiles.get(`/project/${path}`) ?? null;
    }
  );
  mocks.gitCommit.mockImplementation(async (_root: string, _message: string, paths: string[]) => {
    if (finalizationFailure === 'commit') {
      finalizationFailure = null;
      throw new Error('Injected commit failure');
    }
    for (const path of paths) {
      const content = files.get(`/project/${path}`);
      if (content !== undefined) committedFiles.set(`/project/${path}`, content);
    }
  });
  mocks.reconcile.mockImplementation(async () => {
    if (finalizationFailure === 'reconcile') {
      finalizationFailure = null;
      throw new Error('Injected reconcile failure');
    }
  });
  files.set(connectionPath, JSON.stringify(connection));
  mocks.fs.exists.mockImplementation(async (path: string) => files.has(path));
  mocks.fs.readTextFile.mockImplementation(async (path: string) => {
    const value = files.get(path);
    if (value === undefined) throw new Error('ENOENT');
    return value;
  });
  mocks.fs.writeWorkspaceTextFileAtomic.mockImplementation(
    async ({
      path,
      content,
      mode,
      expectedContentHash,
    }: {
      path: string;
      content: string;
      mode: string;
      expectedContentHash?: string;
    }) => {
      if (!path.startsWith('/project/')) throw new Error('A master sheet must never be written.');
      if (mode === 'replace' && (await sha256Hex(files.get(path) ?? '')) !== expectedContentHash)
        throw new Error('Stale checkpoint');
      if (
        failCheckpoint &&
        path === connectionPath &&
        JSON.parse(content).pending === null &&
        JSON.parse(content).checkpoints.length
      ) {
        failCheckpoint = false;
        throw new Error('Interrupted after artifact creation');
      }
      files.set(path, content);
      if (
        finalizationFailure === 'after-revision' &&
        path === connectionPath &&
        JSON.parse(content).revision !== connection.revision &&
        JSON.parse(content).pending === null
      ) {
        finalizationFailure = null;
        throw new Error('Injected after-revision failure');
      }
    }
  );
  mocks.query.mockImplementation(async () => [...entities.values()]);
  mocks.importSet.mockImplementation(async () => {
    if (finalizationFailure === 'import-set') {
      finalizationFailure = null;
      throw new Error('Injected import-set failure');
    }
    const path = '.waypoint/import-sets/connected-import-set/manifest.json';
    files.set(`/project/${path}`, JSON.stringify({ members: stored().checkpoints }));
    return { importSet: { id: connection.importSetId }, relativePaths: [path] };
  });
  mocks.readSource.mockResolvedValue(source([{ key: '001', name: 'Before', notes: 'Source' }]));
  mocks.create.mockImplementation(
    async ({
      row,
      intent,
    }: {
      row: SheetSyncSnapshot['rows'][number];
      intent: { entityId: string };
    }) => {
      expect(stored().pending?.operation.kind).toBe('create');
      if (!entities.has(intent.entityId))
        entities.set(intent.entityId, {
          id: intent.entityId,
          ...row.record,
          eventSeq: 1,
          tombstone: false,
          archivedAt: null,
        });
      files.set(
        `/project/records/${intent.entityId}.entity.json`,
        JSON.stringify(entities.get(intent.entityId))
      );
      return {
        key: row.key,
        entityId: intent.entityId,
        artifactRelativePath: `records/${intent.entityId}.entity.json`,
        source: row.record,
        applied: row.record,
      };
    }
  );
  mocks.update.mockImplementation(
    async (input: {
      id: string;
      operationId: string;
      expectedEventSeq: number;
      name: string;
      fields: Record<string, unknown>;
    }) => {
      const pending = stored().pending?.operation;
      expect(pending?.kind).toBe('update-record');
      if (pending?.kind === 'update-record') expect(pending.operationId).toBe(input.operationId);
      const current = entities.get(input.id);
      if (!current || current.eventSeq !== input.expectedEventSeq) throw new Error('Stale entity');
      const updated = {
        ...current,
        name: input.name,
        fields: input.fields,
        eventSeq: current.eventSeq + 1,
      };
      entities.set(input.id, updated);
      files.set(`/project/records/${input.id}.entity.json`, JSON.stringify(updated));
      return updated;
    }
  );
});
describe('living Excel pull transaction', () => {
  it('refuses an unsupported sync kind before reading the source or changing the project', async () => {
    await expect(
      createExcelSheetSyncConnection({
        workspaceRoot: '/workspace',
        source: {
          path: '/master.xlsx',
          sheetName: 'Records',
          keyColumn: 'id',
          forcedKind: 'unsupported-kind',
          columnMappings: [],
        },
        destinationRelativePath: 'Records',
      })
    ).rejects.toThrow();
    expect(mocks.readSource).not.toHaveBeenCalled();
    expect(mocks.fs.writeWorkspaceTextFileAtomic).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('recovers an interrupted artifact creation with the same ID before applying a newer sheet revision', async () => {
    failCheckpoint = true;
    await expect(
      pullExcelSheetConnection({ workspaceRoot: '/project', id: connection.id })
    ).rejects.toThrow('Interrupted');
    expect(entities.size).toBe(1);
    const id = [...entities.keys()][0];
    expect(stored().pending?.operation.kind).toBe('create');
    mocks.readSource.mockResolvedValue(
      source([{ key: '001', name: 'After', notes: 'New source' }], 'b')
    );
    const result = await pullExcelSheetConnection({ workspaceRoot: '/project', id: connection.id });
    expect(entities.size).toBe(1);
    expect(entities.get(id)?.name).toBe('After');
    expect(stored().checkpoints[0].entityId).toBe(id);
    expect(stored().pending).toBeNull();
    expect(result).toMatchObject({ created: 1, updated: 1 });
  });
  it('preserves local fields, reports simultaneous changes, and never deletes a missing row', async () => {
    await pullExcelSheetConnection({ workspaceRoot: '/project', id: connection.id });
    const entity = [...entities.values()][0];
    entity.fields.customLocalTag = 'Keep';
    mocks.readSource.mockResolvedValue(
      source([{ key: '001', name: 'Renamed', notes: 'Source' }], 'b')
    );
    await pullExcelSheetConnection({ workspaceRoot: '/project', id: connection.id });
    expect(entities.get(entity.id)?.fields.customLocalTag).toBe('Keep');
    const current = entities.get(entity.id);
    if (!current) throw new Error('Missing test entity');
    current.fields.notes = 'Local';
    current.eventSeq += 1;
    mocks.readSource.mockResolvedValue(
      source([{ key: '001', name: 'Renamed', notes: 'Remote' }], 'c')
    );
    const conflict = await pullExcelSheetConnection({
      workspaceRoot: '/project',
      id: connection.id,
    });
    expect(conflict?.conflicts).toEqual([{ key: '001', reason: 'both-edited' }]);
    expect(entities.get(entity.id)?.fields.notes).toBe('Local');
    mocks.readSource.mockResolvedValue(source([], 'd'));
    const missing = await pullExcelSheetConnection({
      workspaceRoot: '/project',
      id: connection.id,
    });
    expect(missing?.missingRows).toEqual(['001']);
    expect(entities.size).toBe(1);
    expect(stored().checkpoints).toHaveLength(1);
  });
  for (const phase of ['after-revision', 'import-set', 'reconcile', 'commit'] as const) {
    it(`retries incomplete ${phase} finalization on an unchanged source without duplicate records`, async () => {
      mocks.gitRepo.mockResolvedValue(true);
      finalizationFailure = phase;
      await expect(
        pullExcelSheetConnection({ workspaceRoot: '/project', id: connection.id })
      ).rejects.toThrow('Injected');
      expect(entities.size).toBe(1);
      const intent = stored().finalization;
      if (!intent) throw new Error('Missing durable publication intent');
      expect(acknowledgements.has(intent.id)).toBe(false);
      const firstEntityId = [...entities.keys()][0];
      await pullExcelSheetConnection({ workspaceRoot: '/project', id: connection.id });
      expect(entities.size).toBe(1);
      expect([...entities.keys()][0]).toBe(firstEntityId);
      expect(stored().finalization?.id).toBe(intent.id);
      expect(acknowledgements.has(intent.id)).toBe(true);
      const commits = mocks.gitCommit.mock.calls.length;
      const reconciles = mocks.reconcile.mock.calls.length;
      await pullExcelSheetConnection({ workspaceRoot: '/project', id: connection.id });
      expect(mocks.gitCommit.mock.calls.length).toBe(commits);
      expect(mocks.reconcile.mock.calls.length).toBe(reconciles);
    });
  }

  it('does not read an unapproved portable connection source or execute its pending work', async () => {
    mocks.authorization.mockResolvedValue('required');
    files.set(
      connectionPath,
      JSON.stringify({
        ...connection,
        pending: {
          revision: `sha256:${'a'.repeat(64)}`,
          snapshotHash: `sha256:${'a'.repeat(64)}`,
          snapshotRelativePath: `.waypoint/sheet-sync/snapshots/${'a'.repeat(64)}.json`,
          operation: {
            kind: 'create',
            rows: [{ owner: 'record', key: '001', entityId: 'foreign-target' }],
          },
        },
      })
    );
    await expect(
      pullExcelSheetConnection({ workspaceRoot: '/project', id: connection.id })
    ).rejects.toThrow('Choose the workbook');
    expect(mocks.readSource).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('preserves checkpoints when source access fails and performs no work while paused', async () => {
    const before = files.get(connectionPath);
    mocks.readSource.mockRejectedValue(new Error('Permission denied'));
    await expect(
      pullExcelSheetConnection({ workspaceRoot: '/project', id: connection.id })
    ).rejects.toThrow('Permission denied');
    expect(files.get(connectionPath)).toBe(before);
    expect(mocks.create).not.toHaveBeenCalled();
    files.set(connectionPath, JSON.stringify({ ...connection, enabled: false }));
    expect(
      await pullExcelSheetConnection({ workspaceRoot: '/project', id: connection.id })
    ).toBeNull();
    expect(mocks.readSource).toHaveBeenCalledTimes(1);
  });
});

describe('living Google pull through the shared artifact transaction', () => {
  it('creates stable row artifacts, retries finalization and applies later source edits without duplicate records', async () => {
    const google: SheetSyncConnection = {
      ...connection,
      source: {
        provider: 'google-sheets',
        spreadsheetId: 'source-id',
        sheetId: 17,
        keyColumn: 'ID',
        forcedKind: 'strain',
        columnMappings: [
          { sourceColumn: 'ID', mappingMode: 'source_only' },
          { sourceColumn: 'Name', mappingMode: 'mapped', mappedField: 'entity.name' },
          { sourceColumn: 'Notes', mappingMode: 'mapped', mappedField: 'fields.notes' },
          {
            sourceColumn: 'Genotype',
            mappingMode: 'mapped',
            mappedField: 'fields.genotypeCanonical',
          },
        ],
      },
    };
    files.set(connectionPath, JSON.stringify(google));
    mocks.googleGrant.mockResolvedValue('local-only-grant');
    const row = (values: string[]) =>
      values.map((display) => ({ kind: 'value', value: display, display }));
    mocks.googleWorksheet.mockResolvedValue({
      spreadsheetId: 'source-id',
      sheetId: 17,
      sheetTitle: 'Strains',
      revision: `sha256:${'c'.repeat(64)}`,
      rows: [
        row(['ID', 'Name', 'Notes', 'Genotype']),
        row(['001', 'First', 'Sheet note', 'wildtype']),
      ],
    });
    finalizationFailure = 'import-set';
    await expect(
      pullExcelSheetConnection({ workspaceRoot: '/project', id: google.id })
    ).rejects.toThrow('import-set');
    expect(entities.size).toBe(1);
    const id = [...entities.keys()][0];
    await pullExcelSheetConnection({ workspaceRoot: '/project', id: google.id });
    expect(entities.size).toBe(1);
    expect(stored().checkpoints[0].entityId).toBe(id);
    expect(mocks.readSource).not.toHaveBeenCalled();
    expect(mocks.googleWorksheet).toHaveBeenCalledWith({
      grantId: 'local-only-grant',
      spreadsheetId: 'source-id',
      sheetId: 17,
    });
    mocks.googleWorksheet.mockResolvedValue({
      spreadsheetId: 'source-id',
      sheetId: 17,
      sheetTitle: 'Renamed tab',
      revision: `sha256:${'d'.repeat(64)}`,
      rows: [
        row(['ID', 'Name', 'Notes', 'Genotype']),
        row(['001', 'Updated', 'Next note', 'wildtype']),
      ],
    });
    const result = await pullExcelSheetConnection({ workspaceRoot: '/project', id: google.id });
    expect(result?.updated).toBe(1);
    expect(entities.get(id)?.name).toBe('Updated');
    expect(entities.size).toBe(1);
    const connector = mocks.importSet.mock.calls.at(-1)?.[0].source.connector;
    expect(connector).toMatchObject({
      connectorType: 'google-sheets',
      externalDocumentId: 'source-id',
      externalSheetId: '17',
    });
    expect(JSON.stringify(stored())).not.toContain('local-only-grant');
  });
});

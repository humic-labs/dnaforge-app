// @vitest-environment node
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import {
  applyInventoryCommandBatch,
  applyInventoryScientificTransferV2,
  createInventoryState,
  inventoryNotebookSourceSha256,
  inventoryProtocolRunSourceSha256,
  inventoryScientificTransferPreviewV2,
  parseInventoryState,
  type InventoryScientificContextSource,
  type InventoryState,
} from '@waypoint/domain-services';
import {
  inventoryScientificWorksForContextReadSchema,
  inventoryScientificWorksForContextRequestSchema,
} from '../shared/inventory-scientific-read';
let db: Database.Database;
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => 'test' },
  ipcMain: { handle: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('./ipc/database', () => ({ getDb: () => db }));
import { openFileTestDb, openReadonlyFileTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { rememberOriginalDefaultProject } from './original-default-project';
import {
  createRegisteredProjectAuthority,
  withAgentProjectScope,
} from './registered-project-authority';
import { createNativeInventoryOwner } from './inventory-owner';

const principal = { kind: 'local-profile' as const, profileKey: 'a'.repeat(64) };
function fixture(): InventoryState {
  const initial = applyInventoryCommandBatch(
    createInventoryState(),
    {
      expectedRevision: 0,
      commands: [
        {
          kind: 'create-layout-storage',
          id: 'plate',
          name: 'Plate',
          layout: { kind: 'fixed-well', rows: 1, columns: 24 },
          placement: { kind: 'root' },
        },
        {
          kind: 'create-vessel',
          id: 'vial',
          name: 'Saved source',
          placement: { kind: 'unplaced' },
        },
        {
          kind: 'receive-stock',
          id: 'stock',
          vesselId: 'vial',
          materialId: 'material',
          quantity: { kind: 'known', value: '1000', unit: 'uL' },
          quality: 'usable',
        },
      ],
    },
    { at: 100, principal, authority: principal }
  );
  if (!initial.ok) throw Error(initial.message);
  let state = initial.state;
  for (let index = 0; index < 23; index++) {
    const projectId = index === 22 ? 'foreign-project' : 'read-project';
    const source: InventoryScientificContextSource =
      index === 21
        ? {
            schema: 'dnaforge.notebook-saved-source.v1',
            projectId,
            workspaceScope: projectId,
            pageId: `${projectId}::run`,
            fileObjectUuid: 'saved-notebook-file',
            title: 'Same title',
            content: { type: 'doc', content: [] },
          }
        : {
            schema: 'dnaforge.protocol-run-saved-source.v1',
            projectId,
            workspaceScope: projectId,
            runId: `${projectId}::run`,
            fileObjectUuid: 'saved-run-file',
            title: 'Same title',
            originalText: JSON.stringify({
              schema: 'dnaforge.protocol-run.v1',
              kind: 'protocol_run',
              id: 'run',
              title: 'Same title',
              status: 'in_progress',
              immutable: false,
              protocol: {
                sourceId: 'protocol',
                destinationId: `${projectId}::protocol`,
                name: 'Protocol',
                pinnedVersionId: 'source-v1',
                pinnedVersionHash: `sha256:${'a'.repeat(64)}`,
              },
              inputs: [],
              outputs: [],
              measurements: [],
              tables: [],
              links: [],
              startedAt: null,
              completedAt: null,
              amendments: [],
              provenance: { provider: 'dnaforge', immutableSource: false },
            }),
          };
    const context =
      source.schema === 'dnaforge.notebook-saved-source.v1'
        ? {
            kind: 'notebook-page' as const,
            entityId: source.pageId,
            sourceSha256: inventoryNotebookSourceSha256(source),
          }
        : {
            kind: 'protocol-run' as const,
            entityId: source.runId,
            sourceSha256: inventoryProtocolRunSourceSha256(source),
          };
    const input = {
      identity: { namespace: 'manual', workId: `work-${index}` },
      context,
      sourceStockId: 'stock',
      destinationVesselId: `well:plate#A${index + 1}`,
      quantity: { value: '10', unit: 'uL' as const },
      reason: 'Observed manual aliquot',
      target: { projectId, inventoryId: 'inventory', present: true, revision: state.revision },
      source,
    };
    const preview = inventoryScientificTransferPreviewV2(state, {
      ...input,
      asOf: 100,
      principal,
      authority: principal,
    });
    if (preview.kind !== 'ready') throw Error(JSON.stringify(preview));
    const applied = applyInventoryScientificTransferV2(
      state,
      { ...input, expectedPlanDigest: preview.planDigest },
      { at: 100, principal, authority: principal }
    );
    if (!applied.ok) throw Error(applied.message);
    state = applied.state;
  }
  return state;
}
it('reads bounded immutable pages through real project authority and one file-SQLite snapshot without source owners or writes', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dnaforge-scientific-read-'))),
    projectPath = join(root, 'project'),
    dbPath = join(root, 'catalog.sqlite');
  mkdirSync(projectPath);
  db = openFileTestDb(dbPath);
  try {
    ensureSchema(db, dbPath);
    db.prepare(
      "INSERT INTO workspaces(id,name,path,repo_uuid,access_mode,created_at) VALUES(41,'Read project',?,'read-project','writable',1)"
    ).run(projectPath);
    rememberOriginalDefaultProject(db, 41);
    const authority = createRegisteredProjectAuthority({
      db: () => db,
      managedRootDir: () => join(root, 'managed'),
    });
    const state = fixture();
    const owner = createNativeInventoryOwner({
      db: () => db,
      projectAuthority: authority,
      actor: () => 'native:read',
      profileKey: principal.profileKey,
    });
    owner.initialize();
    db.prepare(
      'INSERT INTO inventory_state(inventory_id,project_id,revision,state_json) VALUES(?,?,?,?)'
    ).run('inventory', 'read-project', state.revision, JSON.stringify(state));
    const raw = () =>
      JSON.stringify({
        state: db.prepare('SELECT * FROM inventory_state').all(),
        history: db.prepare('SELECT * FROM inventory_journal').all(),
      });
    const before = raw();
    const request = {
      project: 'read-project',
      inventoryId: 'inventory',
      context: { kind: 'protocol-run' as const, entityId: 'read-project::run' },
    };
    const first = inventoryScientificWorksForContextReadSchema.parse(
      owner.scientificWorksForContext(request)
    );
    expect(first.kind).toBe('ready');
    if (first.kind !== 'ready' || !first.nextCursor)
      throw Error('First page must have continuation.');
    expect(first.works).toHaveLength(20);
    expect(
      first.works.every((work) => work.at === 100 && work.context.projectId === 'read-project')
    ).toBe(true);
    const second = owner.scientificWorksForContext({ ...request, cursor: first.nextCursor });
    expect(second.kind).toBe('ready');
    if (second.kind !== 'ready') throw Error('Expected next page.');
    expect(second.works).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect([...first.works, ...second.works].map((work) => work.id)).toEqual(
      Object.values(state.scientificWorks)
        .filter(
          (work) =>
            work.context.kind === 'protocol-run' && work.context.projectId === 'read-project'
        )
        .map((work) => work.id)
        .sort()
    );
    expect(owner.scientificWorksForContext({ ...request, limit: 1 })).toMatchObject({
      kind: 'ready',
      works: [first.works[0]],
    });
    expect(
      owner.scientificWorksForContext({
        ...request,
        cursor: { ...first.nextCursor, querySha256: `sha256:${'0'.repeat(64)}` },
      })
    ).toMatchObject({
      kind: 'unavailable',
      code: 'INVENTORY_QUERY_CURSOR_INVALID',
      retryable: false,
    });
    expect(
      owner.scientificWorksForContext({
        ...request,
        cursor: { ...first.nextCursor, after: { ...first.nextCursor.after, at: 99 } },
      })
    ).toMatchObject({ kind: 'unavailable', code: 'INVENTORY_QUERY_CURSOR_INVALID' });
    expect(
      owner.scientificWorksForContext({
        ...request,
        cursor: { ...first.nextCursor, revision: state.revision - 1 },
      })
    ).toMatchObject({
      kind: 'unavailable',
      code: 'INVENTORY_QUERY_REVISION_CHANGED',
      retryable: true,
    });
    expect(
      owner.scientificWorksForContext({
        ...request,
        context: { kind: 'notebook-page', entityId: 'read-project::run' },
      })
    ).toMatchObject({
      kind: 'ready',
      works: [
        Object.values(state.scientificWorks).find((work) => work.context.kind === 'notebook-page'),
      ],
    });
    expect(
      owner.scientificWorksForContext({
        ...request,
        context: { ...request.context, entityId: 'read-project::missing-current-run' },
      })
    ).toMatchObject({ kind: 'ready', works: [] });
    expect(owner.scientificWorksForContext({ ...request, inventoryId: 'absent' })).toMatchObject({
      kind: 'inventory-absent',
    });
    expect(() =>
      owner.scientificWorksForContext({
        ...request,
        context: { ...request.context, entityId: 'foreign-project::run' },
      })
    ).toThrow('exact scientific record');
    expect(() =>
      withAgentProjectScope({ kind: 'project-roots', roots: [] }, () =>
        owner.scientificWorksForContext(request)
      )
    ).toThrow('unavailable');
    expect(
      inventoryScientificWorksForContextRequestSchema.safeParse({ ...request, limit: 51 }).success
    ).toBe(false);
    expect(
      inventoryScientificWorksForContextRequestSchema.safeParse({ ...request, source: {} }).success
    ).toBe(false);
    expect(
      inventoryScientificWorksForContextReadSchema.safeParse({ ...first, works: [{}] }).success
    ).toBe(false);
    const prepare = db.prepare.bind(db);
    let changedDuringRead = false;
    const prepareSpy = vi.spyOn(db, 'prepare').mockImplementation((sql) => {
      const statement = prepare(sql);
      if (sql !== 'SELECT * FROM inventory_state WHERE inventory_id = ?') return statement;
      return new Proxy(statement, {
        get(target, key) {
          if (key !== 'get') return Reflect.get(target, key);
          return (...args: unknown[]) => {
            const row = target.get(...args);
            if (!changedDuringRead) {
              changedDuringRead = true;
              prepare(
                "UPDATE workspaces SET path='/authority-changed-during-read' WHERE id=41"
              ).run();
            }
            return row;
          };
        },
      });
    });
    try {
      expect(() => owner.scientificWorksForContext(request)).toThrow('authority changed');
    } finally {
      prepareSpy.mockRestore();
    }
    expect(changedDuringRead).toBe(true);
    expect(raw() === before).toBe(true);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it.runIf(Boolean(process.env.INVENTORY_SCIENTIFIC_READ_ACTUAL_DB))(
  'reads the copied actual native profile without changing any state, receipt or saved Run bytes',
  () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'dnaforge-scientific-read-actual-'))),
      path = join(root, 'catalog.sqlite');
    copyFileSync(process.env.INVENTORY_SCIENTIFIC_READ_ACTUAL_DB!, path);
    db = openReadonlyFileTestDb(path);
    try {
      const raw = () =>
        JSON.stringify({
          state: db.prepare('SELECT * FROM inventory_state ORDER BY inventory_id').all(),
          history: db
            .prepare('SELECT * FROM inventory_journal ORDER BY inventory_id,revision')
            .all(),
        });
      const before = raw(),
        fileBefore = readFileSync(path);
      const runs = db
        .prepare(
          "SELECT f.path FROM catalog_entity_files f JOIN catalog_entities e ON e.id=f.entity_id WHERE e.type='protocol_run' AND f.status='current'"
        )
        .all() as { path: string }[];
      const runBytes = runs.map((run) => readFileSync(run.path));
      const rows = db.prepare('SELECT * FROM inventory_state ORDER BY inventory_id').all() as {
        inventory_id: string;
        project_id: string;
        state_json: string;
      }[];
      let observed = 0;
      for (const row of rows) {
        const state = parseInventoryState(JSON.parse(row.state_json));
        const project = db
          .prepare('SELECT path FROM workspaces WHERE repo_uuid=?')
          .get(row.project_id) as { path: string };
        const authority = createRegisteredProjectAuthority({
          db: () => db,
          managedRootDir: () => dirname(dirname(project.path)),
        });
        const owner = createNativeInventoryOwner({
          db: () => db,
          projectAuthority: authority,
          actor: () => 'native:read-only-oracle',
          profileKey: principal.profileKey,
        });
        for (const work of Object.values(state.scientificWorks)) {
          if (work.context.projectId !== row.project_id) continue;
          const result = inventoryScientificWorksForContextReadSchema.parse(
            owner.scientificWorksForContext({
              project: row.project_id,
              inventoryId: row.inventory_id,
              context: {
                kind: work.context.kind,
                entityId:
                  work.context.kind === 'notebook-page'
                    ? work.context.pageId
                    : work.context.entityId,
              },
            })
          );
          expect(result.kind).toBe('ready');
          if (result.kind !== 'ready') throw Error('Actual work must remain readable.');
          expect(result.works).toContainEqual(work);
          observed++;
        }
      }
      expect(observed).toBeGreaterThanOrEqual(2);
      expect(
        (db.prepare('SELECT count(*) AS count FROM inventory_journal').get() as { count: number })
          .count
      ).toBe(Number(process.env.INVENTORY_SCIENTIFIC_READ_ACTUAL_RECEIPTS));
      expect(raw() === before).toBe(true);
      expect(readFileSync(path).equals(fileBefore)).toBe(true);
      expect(runs.every((run, index) => readFileSync(run.path).equals(runBytes[index]))).toBe(true);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
);

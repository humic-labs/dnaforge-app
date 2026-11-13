import { seedOriginalProjectFixture } from './original-project-fixture';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '1.0.0'), exit: vi.fn() },
}));

import type Database from 'better-sqlite3';
import { ensureSchema } from '../schema';
import { createTestDb } from './test-db';
import {
  queryLimsRegistrySummariesInDb,
  registerLimsEntityInDb,
  seedLimsBuiltinsInDb,
} from '../lims';
import { getRegistryCandidateEntities } from '../lims-registry-projection';

let db: Database.Database;
let originalProjectId: number;

function createWorkspace(name: string, path: string): number {
  const info = db
    .prepare(`INSERT INTO workspaces (name, path, created_at) VALUES (?, ?, ?)`)
    .run(name, path, Date.now());
  return Number(info.lastInsertRowid);
}

function registerOligo(name: string, workspaceId?: number | null): string {
  const entity = registerLimsEntityInDb(db, {
    kind: 'oligo',
    name,
    fields: {
      sequence: { mode: 'inline', bases: 'GTAAAACGACGGCCAGT', topology: 'linear', length: 17 },
      use: 'primer',
    },
    ...(workspaceId === undefined ? {} : { workspaceId }),
  });
  return entity.id;
}

beforeEach(() => {
  db = createTestDb();
  ensureSchema(db, ':memory:');
  originalProjectId = seedOriginalProjectFixture(db).workspaceId;
  seedLimsBuiltinsInDb(db);
});

describe('one Registry across home projects', () => {
  it('returns the log watermark even when a name filter has no matches', () => {
    const id = registerOligo('watermark-example');
    const known = queryLimsRegistrySummariesInDb(db, { ids: [id] });
    const absent = queryLimsRegistrySummariesInDb(db, { nameLike: 'does-not-exist' });
    expect(absent.totalCount).toBe(0);
    expect(absent.eventSeq).toBeGreaterThanOrEqual(known.summaries[0].eventSeq!);
    expect(absent.eventSeq).toBe(known.eventSeq);
  });
  it('returns entities from explicit projects and the original default in one catalog', () => {
    const wsA = createWorkspace('Project A', '/tmp/ws-a');
    const wsB = createWorkspace('Project B', '/tmp/ws-b');

    registerOligo('in-workspace-a', wsA);
    registerOligo('in-workspace-b', wsB);
    registerOligo('in-original-project');

    const names = getRegistryCandidateEntities(db).map((e) => e.name);
    expect(names).toEqual(
      expect.arrayContaining(['in-workspace-a', 'in-workspace-b', 'in-original-project'])
    );
    expect(names).toHaveLength(3);
  });

  it('the global Registry summary includes both projects', () => {
    const wsA = createWorkspace('Project A', '/tmp/ws-a');
    const wsB = createWorkspace('Project B', '/tmp/ws-b');

    registerOligo('alpha', wsA);
    registerOligo('beta', wsB);

    const page = queryLimsRegistrySummariesInDb(db, { kind: 'oligo' });
    expect(page.summaries.map((s) => s.name).sort()).toEqual(['alpha', 'beta']);
  });

  it('limits the registry to an explicit id list, including an empty list', () => {
    const alpha = registerOligo('alpha');
    registerOligo('beta');

    expect(
      queryLimsRegistrySummariesInDb(db, { ids: [alpha] }).summaries.map((s) => s.name)
    ).toEqual(['alpha']);
    expect(queryLimsRegistrySummariesInDb(db, { ids: [] }).summaries).toEqual([]);
  });

  it('filters by containing project before paging while retaining the same entity identities', () => {
    const wsA = createWorkspace('Project A', '/tmp/ws-a');
    const wsB = createWorkspace('Project B', '/tmp/ws-b');
    const first = registerOligo('shared name', wsA);
    const second = registerOligo('shared name', wsB);
    const third = registerOligo('third', wsA);

    const page = queryLimsRegistrySummariesInDb(db, {
      workspaceIds: [wsA],
      sort: 'name_asc',
      limit: 1,
      offset: 1,
    });
    expect(page.totalCount).toBe(2);
    expect(page.summaries.map((entity) => entity.id)).toEqual([third]);
    expect(queryLimsRegistrySummariesInDb(db, { workspaceIds: [wsB] }).summaries).toEqual([
      expect.objectContaining({ id: second }),
    ]);
    expect(queryLimsRegistrySummariesInDb(db, { workspaceIds: [] }).summaries).toEqual([]);
    expect(
      queryLimsRegistrySummariesInDb(db, { workspaceIds: [wsA, wsB] }).summaries.map(
        (entity) => entity.id
      )
    ).toEqual(expect.arrayContaining([first, second, third]));
    const allRecords = queryLimsRegistrySummariesInDb(db);
    expect(allRecords.summaries.map((entity) => entity.id).sort()).toEqual(
      [first, second, third].sort()
    );
    expect(allRecords.totalCount).toBe(allRecords.summaries.length);
  });

  it('offers all eligible projects independently of search, page, or project filter and follows renames', () => {
    const wsA = createWorkspace('Same project name', '/tmp/ws-a');
    const wsB = createWorkspace('Same project name', '/tmp/ws-b');
    registerOligo('alpha', wsA);
    registerOligo('beta', wsB);
    db.prepare('UPDATE workspaces SET name = ? WHERE id = ?').run('Renamed project', wsA);

    const page = queryLimsRegistrySummariesInDb(db, {
      workspaceIds: [wsA],
      search: 'no matching records',
    });
    expect(page.totalCount).toBe(0);
    expect(page.availableProjects).toEqual([
      { workspaceId: wsA, name: 'Renamed project', count: 1 },
      { workspaceId: wsB, name: 'Same project name', count: 1 },
    ]);
    expect(queryLimsRegistrySummariesInDb(db, { workspaceIds: [wsA] }).summaries[0]?.name).toBe(
      'alpha'
    );
  });

  it('assigns an omitted import project to the verified original My Project', () => {
    const id = registerOligo('from-import');

    const row = db.prepare(`SELECT workspace_id FROM lims_entity WHERE id = ?`).get(id) as {
      workspace_id: number | null;
    };
    expect(row.workspace_id).toBe(originalProjectId);
  });
});

describe('entity names are NOT unique — dedup is advisory, not a constraint', () => {
  it('permits two entities of the same kind to share a name', () => {
    const first = registerOligo('pRS416');
    const second = registerOligo('pRS416');

    expect(second).not.toBe(first);
    const names = getRegistryCandidateEntities(db).map((e) => e.name);
    expect(names.filter((n) => n === 'pRS416')).toHaveLength(2);
  });

  it('permits the same name across different workspaces (no per-workspace uniqueness either)', () => {
    const wsA = createWorkspace('Project A', '/tmp/ws-a');
    const wsB = createWorkspace('Project B', '/tmp/ws-b');

    registerOligo('MG1655-F', wsA);
    registerOligo('MG1655-F', wsB);

    expect(getRegistryCandidateEntities(db)).toHaveLength(2);
  });

  it('assigns a globally-unique registryId even to same-named entities', () => {
    registerOligo('dup');
    registerOligo('dup');

    const ids = getRegistryCandidateEntities(db).map((e) => e.registryId);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => typeof id === 'string' && id.startsWith('o'))).toBe(true);
  });
});

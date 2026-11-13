import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { performance } from 'node:perf_hooks';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const state = vi.hoisted(() => ({
  db: null as Database.Database | null,
  sql: '',
  params: [] as unknown[],
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => '1.0.0' },
}));
vi.mock('../../platform', () => ({
  platform: () => ({
    db: {
      select: async (sql: string, params: unknown[]) => {
        state.sql = sql;
        state.params = params;
        return state.db!.prepare(sql).all(...params);
      },
    },
  }),
}));

import { ensureSchema } from '../schema';
import { createTestDb } from './test-db';
import {
  searchCatalogReferencesByName,
  searchMountedCatalogEntitiesByName,
} from '../../db/catalog-reference-search';
import { searchProjectReferencesByName } from '../../db/project-reference-search';

let db: Database.Database;

function addEntity(id: string, name: string, workspaceId = 1, status = 'active') {
  db.prepare(
    `INSERT INTO catalog_entities
       (id, name, type, locator, storage_type, status, workspace_id, created_at, updated_at)
     VALUES (?, ?, 'structure', ?, 'file', ?, ?, 1, ?)`
  ).run(id, name, `file://${id}`, status, workspaceId, Number(id.replace(/\D/g, '')) || 1);
  db.prepare(
    `INSERT INTO catalog_entity_files
       (id, entity_id, workspace_id, path, relative_path, file_kind, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pdb', 'current', 1, 1)`
  ).run(`file-${id}`, id, workspaceId, `/lab/${workspaceId}/${id}.pdb`, `${id}.pdb`);
}

async function sidebar(query: string) {
  return searchMountedCatalogEntitiesByName({
    query,
    workspaceRoots: ['/lab/1', '/lab/2', '/lab/3'],
  });
}

async function notebook(query: string) {
  return searchProjectReferencesByName({
    query,
    entityTypes: ['structure'],
    workspaceRoots: ['/lab/1', '/lab/2', '/lab/3'],
    preferredRoot: '/lab/2',
  });
}

beforeEach(() => {
  db = createTestDb();
  state.db = db;
  ensureSchema(db, ':memory:');
  db.prepare('INSERT INTO workspaces (id, name, path, created_at) VALUES (?, ?, ?, 1)').run(
    1,
    'Alpha',
    '/lab/1'
  );
  db.prepare('INSERT INTO workspaces (id, name, path, created_at) VALUES (?, ?, ?, 1)').run(
    2,
    'Beta',
    '/lab/2'
  );
  db.prepare(
    'INSERT INTO workspaces (id, name, path, created_at, archived_at) VALUES (3, ?, ?, 1, 2)'
  ).run('Archived', '/lab/3');
});

afterEach(() => db.close());

describe('catalog name search with real SQLite', () => {
  it.each([
    ['alpha', ['item-1', 'item-2']],
    ['ALPHA', ['item-1', 'item-2']],
    ['100%_match', ['item-3']],
    ['path\\name', ['item-4']],
    ['"quoted"', ['item-5']],
    ['OR NOT', ['item-6']],
    ['café', ['item-7']],
    ['CAFÉ', []],
    ['🧬ab', ['item-8']],
    ['pU', ['item-9']],
    ['x', ['item-10', 'item-6']],
    ['absent-name', []],
  ])('preserves literal substring results for %s', async (query, expected) => {
    const names = [
      'Alpha structure',
      'Beta alpha',
      '100%_match',
      'path\\name',
      'a "quoted" structure',
      'literal OR NOT expression',
      'café',
      '🧬ab sample',
      'pUC19',
      'x-ray',
    ];
    names.forEach((name, index) => addEntity(`item-${index + 1}`, name));
    addEntity('item-100', `Archived ${query}`, 3);
    addEntity('item-101', `Deleted ${query}`, 1, 'deleted');

    const fromSidebar = await sidebar(query);
    const fromNotebook = await notebook(query);
    expect(fromSidebar.map((row) => row.entityId).sort()).toEqual([...expected].sort());
    expect(fromNotebook.candidates.map((row) => row.entityId).sort()).toEqual([...expected].sort());
  });

  it('preserves preferred-project ranking, empty searches and truncation', async () => {
    addEntity('item-1', 'Alpha needle', 1);
    addEntity('item-2', 'Zeta needle', 2);
    const result = await notebook('needle');
    expect(result.candidates.map((row) => row.entityId)).toEqual(['item-2', 'item-1']);
    expect((await sidebar('')).map((row) => row.entityId)).toEqual(['item-1', 'item-2']);
    expect(
      await searchProjectReferencesByName({
        query: 'needle',
        entityTypes: ['structure'],
        workspaceRoots: ['/lab/1', '/lab/2'],
        limit: 1,
      })
    ).toMatchObject({ truncated: true, candidates: [{ entityId: 'item-2' }] });
  });

  it('uses the trigram index for sidebar, notebook and scoped reference candidates', async () => {
    addEntity('item-1', 'Atlas structure');
    for (const search of [
      () => sidebar('Atlas'),
      () => notebook('Atlas'),
      () =>
        searchCatalogReferencesByName({
          query: 'Atlas',
          entityType: 'structure',
          workspaceRoot: '/lab/1',
        }),
    ]) {
      await search();
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${state.sql}`).all(...state.params) as {
        detail: string;
      }[];
      expect(state.sql).toContain('catalog_entity_name_fts');
      expect(plan.map((row) => row.detail).join('\n')).toMatch(/VIRTUAL TABLE INDEX.*M/);
    }
  });

  it('backfills an existing catalog and keeps mutations and rollback synchronized', async () => {
    const triggers = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'catalog_entities'"
      )
      .all() as { name: string }[];
    for (const { name } of triggers.filter(({ name }) => name.includes('name_fts'))) {
      db.exec(`DROP TRIGGER "${name}"`);
    }
    db.exec('DROP TABLE IF EXISTS catalog_entity_name_fts');
    addEntity('item-1', 'Before migration');
    db.pragma('user_version = 43');
    ensureSchema(db, ':memory:');
    expect(
      db.prepare('SELECT rowid FROM catalog_entity_name_fts WHERE name MATCH ?').all('"migration"')
    ).toHaveLength(1);
    ensureSchema(db, ':memory:');
    expect((await sidebar('migration')).map((row) => row.entityId)).toEqual(['item-1']);

    db.prepare('UPDATE catalog_entities SET name = ? WHERE id = ?').run('Renamed target', 'item-1');
    expect(await sidebar('migration')).toEqual([]);
    expect((await sidebar('target')).map((row) => row.entityId)).toEqual(['item-1']);
    expect(() =>
      db.transaction(() => {
        db.prepare('UPDATE catalog_entities SET name = ? WHERE id = ?').run(
          'Rollback target',
          'item-1'
        );
        throw new Error('rollback');
      })()
    ).toThrow('rollback');
    expect(await sidebar('rollback')).toEqual([]);
    expect((await sidebar('renamed')).map((row) => row.entityId)).toEqual(['item-1']);
    db.prepare('DELETE FROM catalog_entity_files WHERE entity_id = ?').run('item-1');
    db.prepare('DELETE FROM catalog_entities WHERE id = ?').run('item-1');
    expect(
      db.prepare('SELECT rowid FROM catalog_entity_name_fts WHERE name MATCH ?').all('"target"')
    ).toEqual([]);
  });

  it('measures the actual queries on 200000 catalog items', async () => {
    db.exec(`
      WITH RECURSIVE item(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM item WHERE n < 200000)
      INSERT INTO catalog_entities
        (id, name, type, locator, storage_type, status, workspace_id, created_at, updated_at)
      SELECT 'item-' || n,
             CASE n WHEN 100000 THEN 'Selective needle' ELSE 'Common item ' || n END,
             'structure', 'file://item-' || n, 'file', 'active', n % 2 + 1, 1, n
      FROM item;
      INSERT INTO catalog_entity_files
        (id, entity_id, workspace_id, path, relative_path, file_kind, status, created_at, updated_at)
      SELECT 'file-' || id, id, workspace_id, '/lab/' || workspace_id || '/' || id || '.pdb',
             id || '.pdb', 'pdb', 'current', 1, 1
      FROM catalog_entities WHERE id LIKE 'item-%';
    `);
    const measurements = [];
    for (const query of ['Selective needle', 'no-such-catalog-item', 'Common']) {
      for (const [surface, search] of [
        ['sidebar', sidebar],
        ['notebook', notebook],
      ] as const) {
        const start = performance.now();
        const result = await search(query);
        const durationMs = performance.now() - start;
        const count = Array.isArray(result) ? result.length : result.candidates.length;
        measurements.push({ surface, query, durationMs, count });
      }
    }
    const receipt = { catalogItems: 200_000, measurements };
    if (process.env.FIXTURE_MEASUREMENT_PATH) {
      mkdirSync(dirname(process.env.FIXTURE_MEASUREMENT_PATH), { recursive: true });
      writeFileSync(process.env.FIXTURE_MEASUREMENT_PATH, JSON.stringify(receipt, null, 2));
    }
    console.log('[ catalog search]', JSON.stringify(receipt));
    expect(measurements.map((row) => row.count)).toEqual([1, 1, 0, 0, 100, 100]);
  }, 20_000);
});

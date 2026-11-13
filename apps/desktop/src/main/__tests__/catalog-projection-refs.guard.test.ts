import { describe, it, expect, vi, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from './test-db';

vi.mock('electron', () => ({
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(), getVersion: vi.fn(() => '1.0.0') },
}));
vi.mock('../analytics', () => ({ trackEvent: vi.fn() }));

import { ensureSchema } from '../schema';
import {
  NOTEBOOK_PROJECTION_ID_COLUMNS,
  NOTEBOOK_PROJECTION_LOCATOR_COLUMNS,
} from '../../shared/catalog-projection-refs';

let db: Database.Database | null = null;
afterEach(() => {
  db?.close();
  db = null;
});

function fkChildrenOfCatalogEntities(d: Database.Database): { table: string; column: string }[] {
  const tables = (
    d
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
      .all() as { name: string }[]
  ).map((r) => r.name);
  const children: { table: string; column: string }[] = [];
  for (const table of tables) {
    const fks = d.prepare(`PRAGMA foreign_key_list(${table})`).all() as {
      table: string;
      from: string;
      to: string | null;
    }[];
    for (const fk of fks) {
      if (fk.table === 'catalog_entities' && (fk.to === 'id' || fk.to === null)) {
        children.push({ table, column: fk.from });
      }
    }
  }
  return children;
}

const key = (r: { table: string; column: string }) => `${r.table}.${r.column}`;

describe('catalog projection-id SSOT ↔ live schema parity', () => {
  it('every FK child of catalog_entities(id) is declared hardRef in the SSOT (and vice-versa)', () => {
    db = createTestDb();
    ensureSchema(db, ':memory:');

    const liveChildren = fkChildrenOfCatalogEntities(db).map(key).sort();
    const declaredHardRefs = NOTEBOOK_PROJECTION_ID_COLUMNS.filter((c) => c.hardRef)
      .map(key)
      .sort();

    expect(
      liveChildren,
      'FK children of catalog_entities(id) must be declared hardRef in catalog-projection-refs.ts'
    ).toEqual(declaredHardRefs);

    expect(liveChildren).toContain('catalog_entity_files.entity_id');
    expect(liveChildren.length).toBeGreaterThanOrEqual(4);
  });

  it('declares the SOFT refs (pages.id + entity://page locators) that have no FK to scan', () => {
    const idKeys = NOTEBOOK_PROJECTION_ID_COLUMNS.map(key);
    expect(idKeys).toContain('pages.id');

    const locatorKeys = NOTEBOOK_PROJECTION_LOCATOR_COLUMNS.map(key);
    expect(locatorKeys).toContain('entity_references.locator');
    for (const c of NOTEBOOK_PROJECTION_LOCATOR_COLUMNS) {
      expect(c.prefix).toBe('entity://page/');
    }
  });
});

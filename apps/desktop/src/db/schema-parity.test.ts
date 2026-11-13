import { describe, it, expect, beforeAll, vi } from 'vitest';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { is } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { drizzle } from 'drizzle-orm/better-sqlite3';

vi.mock('electron', () => ({
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(), getVersion: vi.fn(() => '1.0.0') },
}));

import { ensureSchema } from '../main/schema';
import { createTestDb } from '../main/__tests__/test-db';
import type Database from 'better-sqlite3';
import * as drizzleSchema from './schema';
import { SQLITE_TABLE_DATA_STORES } from './data-stores-manifest';

const INTENTIONALLY_UNMAPPED: Record<string, string[]> = {};

let db: Database.Database;

beforeAll(() => {
  db = createTestDb();
  ensureSchema(db, ':memory:');
});

function sqlTableExists(table: string): boolean {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) !==
    undefined
  );
}

function sqlColumns(table: string): string[] {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => (row as { name: string }).name);
}

function appSqlTables(database = db): string[] {
  return database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all()
    .map((row) => (row as { name: string }).name);
}

function drizzleTables(): Array<{ sqlName: string; columns: string[] }> {
  return Object.values(drizzleSchema)
    .filter((v): v is SQLiteTable => is(v, SQLiteTable))
    .map((table) => {
      const config = getTableConfig(table);
      return {
        sqlName: config.name,
        columns: config.columns.map((c) => c.name),
      };
    });
}

function unclassifiedSqliteTables(
  tables: readonly string[],
  manifest: Record<string, unknown> = SQLITE_TABLE_DATA_STORES
): string[] {
  const classified = new Set(Object.keys(manifest));
  return tables.filter((table) => !classified.has(table));
}

describe('Drizzle mirror ↔ main/schema.ts parity', () => {
  it('exposes at least one mirrored table (sanity)', () => {
    expect(drizzleTables().length).toBeGreaterThan(0);
  });

  it('can query saved compute request identity through the renderer schema', () => {
    const jobs = drizzleSchema.computeJobs;
    expect(
      drizzle(db)
        .select({
          request: jobs.requestJson,
          requestHash: jobs.requestHash,
          inputFiles: jobs.inputFilesJson,
          idempotencyKey: jobs.idempotencyKey,
        })
        .from(jobs)
        .all()
    ).toEqual([]);
  });

  it('can query native prediction receipts through the renderer schema', () => {
    const requests = drizzleSchema.molecularCatalogPredictionRequests;
    expect(drizzle(db).select().from(requests).all()).toEqual([]);
  });

  it('every Drizzle table maps to a real SQL table', () => {
    const missing = drizzleTables()
      .map((t) => t.sqlName)
      .filter((name) => !sqlTableExists(name));
    expect(
      missing,
      `Drizzle declares table(s) the authoritative SQL never creates: ${missing.join(', ')}`
    ).toEqual([]);
  });

  it('every Drizzle column is backed by a real SQL column', () => {
    const violations: string[] = [];
    for (const t of drizzleTables()) {
      if (!sqlTableExists(t.sqlName)) continue;
      const sqlCols = new Set(sqlColumns(t.sqlName));
      for (const col of t.columns) {
        if (!sqlCols.has(col)) {
          violations.push(`${t.sqlName}.${col} (in Drizzle, not in SQL)`);
        }
      }
    }
    expect(
      violations,
      `Drizzle declares column(s) the SQL schema does not have — ` +
        `a query on these fails at runtime:\n  ${violations.join('\n  ')}`
    ).toEqual([]);
  });

  it('every SQL column on a mirrored table is present in Drizzle (or intentionally unmapped)', () => {
    const violations: string[] = [];
    for (const t of drizzleTables()) {
      if (!sqlTableExists(t.sqlName)) continue;
      const drizzleCols = new Set(t.columns);
      const allowed = new Set(INTENTIONALLY_UNMAPPED[t.sqlName] ?? []);
      for (const col of sqlColumns(t.sqlName)) {
        if (!drizzleCols.has(col) && !allowed.has(col)) {
          violations.push(`${t.sqlName}.${col} (in SQL, not in Drizzle)`);
        }
      }
    }
    expect(
      violations,
      `SQL has column(s) the Drizzle mirror is missing — the renderer cannot ` +
        `see them. Add to db/schema.ts, or to INTENTIONALLY_UNMAPPED with a ` +
        `reason:\n  ${violations.join('\n  ')}`
    ).toEqual([]);
  });
});

describe('data-store source-of-truth manifest guard', () => {
  it('classifies every app-owned SQLite table in the real schema', () => {
    const missing = unclassifiedSqliteTables(appSqlTables());
    expect(
      missing,
      `SQLite table(s) are missing from SQLITE_TABLE_DATA_STORES. Declare each table's ` +
        `classification/source-of-truth before merging:\n  ${missing.join('\n  ')}`
    ).toEqual([]);
  });

  it('has no stale SQLite-table manifest entries', () => {
    const tables = new Set(appSqlTables());
    const stale = Object.keys(SQLITE_TABLE_DATA_STORES).filter((table) => !tables.has(table));
    expect(
      stale,
      `SQLITE_TABLE_DATA_STORES classifies table(s) the real schema no longer creates:\n  ${stale.join(
        '\n  '
      )}`
    ).toEqual([]);
  });

  it('keeps manifest keys aligned with entry.table values', () => {
    const mismatches = Object.entries(SQLITE_TABLE_DATA_STORES)
      .filter(([key, entry]) => entry.table !== key)
      .map(([key, entry]) => `${key} -> ${entry.table}`);
    expect(
      mismatches,
      `SQLite manifest keys must equal their table names:\n  ${mismatches.join('\n  ')}`
    ).toEqual([]);
  });

  it('meta-test: detects an intentionally unclassified table fixture', () => {
    expect(unclassifiedSqliteTables(['settings', '__unclassified_guard_fixture'])).toEqual([
      '__unclassified_guard_fixture',
    ]);
  });
});

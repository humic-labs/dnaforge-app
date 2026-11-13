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
import { registerLimsEntityInDb, seedLimsBuiltinsInDb } from '../lims';
import { resolveImportLinkEndpoint } from '../lims-import';
import type { LimsImportLinkPreview } from '../../shared/lims';

let db: Database.Database;

function strain(name: string): string {
  return registerLimsEntityInDb(db, {
    kind: 'strain',
    name,
    fields: { genotypeCanonical: 'wild-type', species: 'E. coli' },
  }).id;
}

function linkTo(name: string): LimsImportLinkPreview {
  return {
    type: 'derives_from',
    toEntityLookup: { name, kind: 'strain' },
    payload: {},
  };
}

beforeEach(() => {
  db = createTestDb();
  ensureSchema(db, ':memory:');
  seedOriginalProjectFixture(db);
  seedLimsBuiltinsInDb(db);
});

describe('M9 — a by-name endpoint with ≥2 live candidates never resolves to a guess', () => {
  it('THROWS instead of silently picking the most-recently-updated namesake', () => {
    const first = strain('ACME-3');
    const second = strain('ACME-3');
    expect(first).not.toBe(second);

    expect(() => resolveImportLinkEndpoint(db, linkTo('ACME-3'), 'to', 'importer')).toThrow(
      /ambiguous/i
    );
  });

  it('the error names the reference and the candidate count (so a human can act)', () => {
    strain('pRS416-parent');
    strain('pRS416-parent');
    strain('pRS416-parent');

    expect(() => resolveImportLinkEndpoint(db, linkTo('pRS416-parent'), 'to', 'importer')).toThrow(
      /pRS416-parent[\s\S]*3|3[\s\S]*pRS416-parent/
    );
  });

  it('still resolves cleanly when exactly ONE live candidate exists', () => {
    const only = strain('MG1655');
    expect(resolveImportLinkEndpoint(db, linkTo('MG1655'), 'to', 'importer')).toBe(only);
  });

  it('an ARCHIVED namesake does not create false ambiguity (tombstoned rows are not candidates)', () => {
    const live = strain('W3110');
    const dead = strain('W3110');
    db.prepare(`UPDATE lims_entity SET tombstone = 1 WHERE id = ?`).run(dead);

    expect(resolveImportLinkEndpoint(db, linkTo('W3110'), 'to', 'importer')).toBe(live);
  });

  it('still throws not-found when there are ZERO candidates (unchanged behavior)', () => {
    expect(() => resolveImportLinkEndpoint(db, linkTo('nobody'), 'to', 'importer')).toThrow(
      /not found/i
    );
  });
});

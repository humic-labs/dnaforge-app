import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('electron', () => ({
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(), getVersion: vi.fn(() => '1.0.0') },
}));

import type Database from 'better-sqlite3';
import { createTestDb } from '../__tests__/test-db';
import { ensureSchema } from '../schema';
import { importIntoManagedWorkspaceRepo } from './import';

describe('folder import reports the sequence files it left unconverted ', () => {
  let db: Database.Database;
  let tmp: string;

  beforeEach(() => {
    db = createTestDb();
    ensureSchema(db, ':memory:');
    tmp = mkdtempSync(join(tmpdir(), 'wp-unconverted-'));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('names each refused file with its reason and omits the ones it converted', async () => {
    const source = join(tmp, 'project');
    mkdirSync(join(source, 'nested'), { recursive: true });
    writeFileSync(join(source, 'plasmid.fna'), '>plasmid\nACGTACGTACGTACGTACGTACGT\n');
    writeFileSync(join(source, 'nested', 'enzyme.fasta'), '>enzyme\nMKWVTFISLLFLFSSAYSRGVFRR\n');

    const result = await importIntoManagedWorkspaceRepo(source, {
      db,
      managedRootDir: join(tmp, 'managed'),
    });

    expect(result.unconvertedSequenceFiles).toEqual([
      { relPath: 'nested/enzyme.fasta', reason: expect.stringMatching(/protein/i) },
    ]);
  });

  it('leaves the field out when every sequence converted', async () => {
    const source = join(tmp, 'clean');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'plasmid.fna'), '>plasmid\nACGTACGTACGTACGTACGTACGT\n');

    const result = await importIntoManagedWorkspaceRepo(source, {
      db,
      managedRootDir: join(tmp, 'managed'),
    });

    expect(result.unconvertedSequenceFiles).toBeUndefined();
  });
});

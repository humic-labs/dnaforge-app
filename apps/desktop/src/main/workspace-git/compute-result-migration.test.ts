import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LEGACY_COMPUTE_MIGRATION_DEFERRED,
  migrateComputeResultFolders,
} from './compute-result-migration';

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'wp-compute-migration-'));
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

function jobFolder(provider: string, job: string, files: Record<string, string | Buffer>) {
  const directory = join(repo, 'compute', provider, job);
  mkdirSync(directory, { recursive: true });
  for (const [name, content] of Object.entries(files))
    writeFileSync(join(directory, name), content);
  return directory;
}

describe('legacy compute migration containment ', () => {
  it('defers the whole job without invoking removal or metadata publication', async () => {
    const contents = {
      'model.pdb': 'HEADER    PREDICTION\nEND\n',
      'designs.fasta': '>a\nMKT\n',
      'scores.json': '{"ptm":0.8}',
      'compute-job.json': JSON.stringify({ provider: 'boltz', remoteId: 'r1' }),
    };
    const folder = jobFolder('boltz', 'r1', contents);
    const removeSource = vi.fn();
    const relocate = vi.fn();
    const result = await migrateComputeResultFolders(repo, { removeSource, relocate });
    expect(result).toEqual({
      migrated: 0,
      skipped: [{ path: folder, reason: LEGACY_COMPUTE_MIGRATION_DEFERRED }],
    });
    expect(removeSource).not.toHaveBeenCalled();
    expect(relocate).not.toHaveBeenCalled();
    expect(readdirSync(repo)).toEqual(['compute']);
    expect(readdirSync(folder).sort()).toEqual(Object.keys(contents).sort());
    for (const [name, content] of Object.entries(contents))
      expect(readFileSync(join(folder, name), 'utf8')).toBe(content);
  });

  it('does not fabricate a job identity for a receipt-less result', async () => {
    const folder = jobFolder('tamarind', 'r2_test-mode', { 'ranked_0.cif': 'data_x\n#\n' });
    const relocate = vi.fn();
    expect(await migrateComputeResultFolders(repo, { removeSource: vi.fn(), relocate })).toEqual({
      migrated: 0,
      skipped: [{ path: folder, reason: LEGACY_COMPUTE_MIGRATION_DEFERRED }],
    });
    expect(readFileSync(join(folder, 'ranked_0.cif'), 'utf8')).toBe('data_x\n#\n');
    expect(relocate).not.toHaveBeenCalled();
  });

  it('never follows a compute folder that links outside the project', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'wp-compute-outside-'));
    try {
      mkdirSync(join(outside, 'boltz', 'r5'), { recursive: true });
      writeFileSync(join(outside, 'boltz', 'r5', 'model.pdb'), 'unchanged');
      symlinkSync(outside, join(repo, 'compute'));
      const removeSource = vi.fn();
      const result = await migrateComputeResultFolders(repo, {
        removeSource,
        relocate: vi.fn(),
      });
      expect(result).toEqual({ migrated: 0, skipped: [] });
      expect(removeSource).not.toHaveBeenCalled();
      expect(readFileSync(join(outside, 'boltz', 'r5', 'model.pdb'), 'utf8')).toBe('unchanged');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('preserves binary coordinates as the same file and exact bytes', async () => {
    const bytes = Buffer.from([0, 255, 4, 13, 10, 128]);
    const folder = jobFolder('boltz', 'r3', { 'model.bcif': bytes });
    await migrateComputeResultFolders(repo, {
      removeSource: vi.fn(),
      relocate: vi.fn(),
    });
    expect(readdirSync(repo)).toEqual(['compute']);
    expect(readdirSync(folder)).toEqual(['model.bcif']);
    expect(readFileSync(join(folder, 'model.bcif'))).toEqual(bytes);
  });

  it('returns the same deferral on retries without creating outputs', async () => {
    const folder = jobFolder('boltz', 'r4', { 'designs.fasta': '>a\nMKT\n' });
    const options = { removeSource: vi.fn(), relocate: vi.fn() };
    const first = await migrateComputeResultFolders(repo, options);
    const second = await migrateComputeResultFolders(repo, options);
    expect(second).toEqual(first);
    expect(readdirSync(repo)).toEqual(['compute']);
    expect(readdirSync(folder)).toEqual(['designs.fasta']);
    expect(options.removeSource).not.toHaveBeenCalled();
    expect(options.relocate).not.toHaveBeenCalled();
  });
});

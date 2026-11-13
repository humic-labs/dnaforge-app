import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateComputeResultFolders } from './compute-result-migration';

let scratch: string;
let repo: string;
let source: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'dna4158-compute-'));
  repo = join(scratch, 'project');
  source = join(repo, 'compute', 'boltz', 'retained-job');
  mkdirSync(source, { recursive: true });
  writeFileSync(
    join(source, 'compute-job.json'),
    JSON.stringify({
      schemaVersion: 1,
      provider: 'boltz',
      remoteId: 'retained-job',
    })
  );
  writeFileSync(join(source, 'result.fasta'), '>retained\nACGTACGT\n');
});

afterEach(() => rmSync(scratch, { recursive: true, force: true }));

function inventory(directory: string, prefix = ''): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(files, inventory(path, relative));
    else if (entry.isFile()) {
      files[relative] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  }
  return files;
}

describe('legacy compute member preservation ', () => {
  it('keeps large, binary and nested members in the active project', async () => {
    writeFileSync(join(source, 'large.txt'), 'x'.repeat(1024 * 1024 + 1));
    writeFileSync(join(source, 'binary.dat'), Buffer.from([1, 0, 2, 255]));
    mkdirSync(join(source, 'nested'));
    writeFileSync(join(source, 'nested', 'evidence.bin'), Buffer.from([4, 0, 5]));
    const before = inventory(source);
    await migrateComputeResultFolders(repo, {
      removeSource: async (path) => renameSync(path, join(scratch, 'trash')),
      relocate: () => 1,
    });
    const active = Object.values(inventory(repo));
    for (const member of ['large.txt', 'binary.dat', 'nested/evidence.bin']) {
      expect(active, `${member} must remain accessible outside Trash`).toContain(before[member]);
    }
  });

  it('preserves the original paths and bytes when metadata publication fails', async () => {
    const before = inventory(source);
    const result = await migrateComputeResultFolders(repo, {
      removeSource: async (path) => renameSync(path, join(scratch, 'trash')),
      relocate: async () => {
        throw new Error('metadata publication unavailable');
      },
    });
    expect(result.migrated).toBe(0);
    expect(result.skipped).toHaveLength(1);
    expect(existsSync(source), 'failed publication must retain the original source').toBe(true);
    expect(inventory(source)).toEqual(before);
  });

  it('does not discard unknown output when no matching job can retain its metadata', async () => {
    writeFileSync(join(source, 'scores.json'), '{"ptm":0.8}');
    const digest = inventory(source)['scores.json'];
    await migrateComputeResultFolders(repo, {
      removeSource: async (path) => renameSync(path, join(scratch, 'trash')),
      relocate: () => 0,
    });
    expect(Object.values(inventory(repo))).toContain(digest);
  });
});

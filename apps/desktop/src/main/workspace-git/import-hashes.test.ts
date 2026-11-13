import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashContentSha256, collectExistingFileHashes } from './import-hashes';

describe('import-hashes  dedup data layer)', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fixture-hashes-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('hashContentSha256 is stable and content-addressed', () => {
    expect(hashContentSha256('ACGT')).toBe(hashContentSha256(Buffer.from('ACGT')));
    expect(hashContentSha256('ACGT')).not.toBe(hashContentSha256('ACGG'));
  });

  it('gives byte-identical files the same hash under different names', async () => {
    await writeFile(join(root, 'reads.fastq'), '@x\nACGT\n+\n!!!!\n');
    await writeFile(join(root, 'reads_copy.fastq'), '@x\nACGT\n+\n!!!!\n');
    await writeFile(join(root, 'other.fastq'), '@y\nTTTT\n+\n!!!!\n');
    const files = await collectExistingFileHashes(root);
    const byName = Object.fromEntries(files.map((f) => [f.name, f.contentHash]));
    expect(byName['reads.fastq']).toBe(byName['reads_copy.fastq']);
    expect(byName['other.fastq']).not.toBe(byName['reads.fastq']);
  });

  it('walks nested folders and reports forward-slash workspace-relative paths', async () => {
    await mkdir(join(root, 'sub', 'deep'), { recursive: true });
    await writeFile(join(root, 'sub', 'deep', 'x.gb'), 'LOCUS x\n//\n');
    const files = await collectExistingFileHashes(root);
    const relPaths = files.map((f) => f.relPath);
    expect(relPaths).toContain('sub/deep/x.gb');
  });

  it('skips .git and does not follow symlinks (path-safety)', async () => {
    await mkdir(join(root, '.git'), { recursive: true });
    await writeFile(join(root, '.git', 'config'), 'gitstuff');
    await writeFile(join(root, 'real.gb'), 'LOCUS r\n//\n');
    await symlink(join(root, 'real.gb'), join(root, 'link.gb')).catch(() => {});
    const files = await collectExistingFileHashes(root);
    const names = files.map((f) => f.name);
    expect(names).toContain('real.gb');
    expect(names).not.toContain('config');
    expect(names).not.toContain('link.gb');
  });

  it('returns [] for an empty directory', async () => {
    expect(await collectExistingFileHashes(root)).toEqual([]);
  });
});

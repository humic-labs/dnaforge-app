import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { previewImportDedup } from './import-dedup-preview';

describe('previewImportDedup ', () => {
  let root: string;
  let src: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fixture-prev-root-'));
    src = await mkdtemp(join(tmpdir(), 'fixture-prev-src-'));
    await writeFile(join(root, 'reads.fastq'), '@x\nACGT\n+\n!!!!\n');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(src, { recursive: true, force: true });
  });

  it('flags identical content under a different name as skip-duplicate', async () => {
    await writeFile(join(src, 'reads_copy.fastq'), '@x\nACGT\n+\n!!!!\n');
    const [p] = await previewImportDedup([join(src, 'reads_copy.fastq')], root);
    expect(p.decision.action).toBe('skip-duplicate');
    expect(p.decision).toMatchObject({ existingRelPath: 'reads.fastq', matchedByName: false });
  });

  it('flags same name + different content as name-collision', async () => {
    await writeFile(join(src, 'reads.fastq'), '@y\nTTTT\n+\n!!!!\n');
    const [p] = await previewImportDedup([join(src, 'reads.fastq')], root);
    expect(p.decision.action).toBe('name-collision');
  });

  it('flags genuinely new content as import-new', async () => {
    await writeFile(join(src, 'novel.gb'), 'LOCUS novel\n//\n');
    const [p] = await previewImportDedup([join(src, 'novel.gb')], root);
    expect(p.decision.action).toBe('import-new');
  });

  it('handles multiple sources in order', async () => {
    await writeFile(join(src, 'a.gb'), 'LOCUS a\n');
    await writeFile(join(src, 'reads_copy.fastq'), '@x\nACGT\n+\n!!!!\n');
    const out = await previewImportDedup([join(src, 'a.gb'), join(src, 'reads_copy.fastq')], root);
    expect(out.map((o) => o.decision.action)).toEqual(['import-new', 'skip-duplicate']);
  });
});

import { promises as fs } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { convertTreeToPlasmidPackages } from './convert-tree-to-packages';
import {
  materializeImportedSequencePackages,
  recoverHeldConversionSource,
} from './sequence-package-import';

const DNA = '>clone\nACGTACGTACGTACGTACGTACGT\n';

describe('recovery of a conversion interrupted by a crash ', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'interrupted-conversion-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('restores the set-aside source and converts it when its name is free', async () => {
    const held = join(root, 'nested', '.clone.conversion-source-Ab12Cd');
    await mkdir(held, { recursive: true });
    await writeFile(join(held, 'clone.fna'), DNA);

    const result = await convertTreeToPlasmidPackages(root);

    expect(result.converted).toBe(1);
    expect(result.failures).toEqual([]);
    expect(await readdir(join(root, 'nested'))).toEqual(['clone']);
  });

  it('keeps both copies and reports the set-aside one when a newer file took its name', async () => {
    const held = join(root, '.clone.conversion-source-Ab12Cd');
    await mkdir(held);
    await writeFile(join(held, 'clone.fna'), DNA);
    await writeFile(join(root, 'clone.fna'), '>newer\nTTTTCCCCAAAAGGGGTTTTCCCC\n');

    const result = await convertTreeToPlasmidPackages(root);

    expect(await readFile(join(held, 'clone.fna'), 'utf8')).toBe(DNA);
    expect(result.failures).toEqual([
      {
        path: join(held, 'clone.fna'),
        message: expect.stringMatching(/newer file now has its name/),
      },
    ]);
  });

  it('never touches the set-aside source of a conversion still in progress', async () => {
    const path = join(root, 'live.fna');
    await writeFile(path, DNA);
    let duringConversion: Awaited<ReturnType<typeof recoverHeldConversionSource>> | undefined;

    await materializeImportedSequencePackages(path, {
      writeMeta: (metaPath, content) => fs.writeFile(metaPath, content, { flag: 'wx' }),
      rename: async (from, to) => {
        await fs.rename(from, to);
        if (to.includes('.conversion-source-'))
          duringConversion = await recoverHeldConversionSource(dirname(to));
      },
    });

    expect(duringConversion).toEqual({ kind: 'in-use' });
  });
});

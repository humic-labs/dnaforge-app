import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const materialize = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock('./sequence-package-import', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sequence-package-import')>();
  return {
    ...actual,
    materializeImportedSequencePackages: (
      ...args: Parameters<typeof actual.materializeImportedSequencePackages>
    ) => {
      materialize.calls.push(args[0]);
      return actual.materializeImportedSequencePackages(...args);
    },
  };
});

import { convertTreeToPlasmidPackages } from './convert-tree-to-packages';

const DNA = 'ATGACCATGATTACGGATTCACTGGCCGTCGTTTTACAACGTCGTGACTGGGAAAACCCTG';

describe('convertTreeToPlasmidPackages refusal memory', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'refusal-memory-'));
    materialize.calls.length = 0;
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reports an unchanged refused file again without re-reading it', async () => {
    const source = join(root, 'probe.fasta');
    await writeFile(source, '>probe\nATGTCCGGTGAA\n');

    const first = await convertTreeToPlasmidPackages(root);
    const second = await convertTreeToPlasmidPackages(root);

    expect(materialize.calls).toEqual([source]);
    expect(second.skippedDetails).toEqual([
      { path: source, reason: first.skippedDetails[0].reason, repeated: true },
    ]);
  });

  it('converts a refused file once it is fixed', async () => {
    const source = join(root, 'clone.fasta');
    await writeFile(source, '>clone\nATGTCCGGTGAA\n');
    await convertTreeToPlasmidPackages(root);

    await writeFile(source, `>clone\n${DNA}\n`);
    const fixed = await convertTreeToPlasmidPackages(root);

    expect(fixed.converted).toBe(1);
    expect(await stat(join(root, 'clone', '.forge', 'plasmid.json'))).toBeTruthy();
  });

  it('re-checks a refused file after it changes and reports the new reason', async () => {
    const source = join(root, 'mixed.fasta');
    await writeFile(source, '>mixed\nATGTCCGGTGAA\n');
    const first = await convertTreeToPlasmidPackages(root);

    await writeFile(source, '>mixed\n;note\nACGTACGTACGTACGTACGTACGT\n');
    const second = await convertTreeToPlasmidPackages(root);

    expect(materialize.calls).toEqual([source, source]);
    expect(second.skippedDetails[0].repeated).toBeUndefined();
    expect(second.skippedDetails[0].reason).not.toBe(first.skippedDetails[0].reason);
  });
});

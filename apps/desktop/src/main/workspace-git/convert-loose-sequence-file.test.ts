import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  convertLooseSequenceFile,
  convertTreeToPlasmidPackages,
  inspectLooseSequenceFile,
} from './convert-tree-to-packages';
import { previewImportedSequencePackages } from './sequence-package-import';

describe('convertLooseSequenceFile', () => {
  let root: string;
  const DNA = 'ATGACCATGATTACGGATTCACTGGCCGTCGTTTTACAACGTCGTGACTGGGAAAACCCTG';

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fixture-loose-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function file(relPath: string, content: string): Promise<string> {
    const full = join(root, relPath);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content, 'utf8');
    return full;
  }
  const exists = async (p: string) => !!(await stat(p).catch(() => null));
  const sha256 = async (p: string) =>
    createHash('sha256')
      .update(await readFile(p))
      .digest('hex');

  it('the heal converts a generic DNA .fasta by composition', async () => {
    const source = await file('data/clone-1-verified.fasta', `>clone-1-verified\n${DNA}\n`);

    const heal = await convertTreeToPlasmidPackages(root);

    expect(heal.converted).toBe(1);
    expect(await exists(source)).toBe(false);
    expect(await exists(join(root, 'data', 'clone-1-verified', 'clone-1-verified.gb'))).toBe(true);
  });

  it('a too-short generic .fasta the heal leaves loose converts once the user declares it DNA', async () => {
    const source = await file('data/probe.fasta', '>probe\nATGTCCGGTGAA\n');

    const heal = await convertTreeToPlasmidPackages(root);
    expect(heal.converted).toBe(0);
    expect(heal.skippedDetails).toEqual([
      expect.objectContaining({ path: source, reason: expect.stringContaining('Confirm') }),
    ]);
    expect(await previewImportedSequencePackages(source)).toMatchObject({
      kind: 'blocked',
      canConfirmDnaIdentity: true,
    });
    expect(await convertLooseSequenceFile(root, source)).toMatchObject({
      converted: false,
      packageRoots: [],
    });

    const converted = await convertLooseSequenceFile(root, source, {
      confirmedDnaSourceSha256: await sha256(source),
    });
    expect(converted).toEqual({
      converted: true,
      packageRoots: [join(root, 'data', 'probe')],
      reason: null,
    });
    expect(await exists(join(root, 'data', 'probe', '.forge', 'plasmid.json'))).toBe(true);
  });

  it('a converted file keeps the catalog identity it already had', async () => {
    await file('data/clone-1.fasta', `>clone-1\n${DNA}\n`);
    const ids = new Map([[join(root, 'data', 'clone-1.fasta'), 'existing-entity']]);

    await convertTreeToPlasmidPackages(root, { packageIdForPath: (path) => ids.get(path) });

    const meta = JSON.parse(
      await readFile(join(root, 'data', 'clone-1', '.forge', 'plasmid.json'), 'utf8')
    );
    expect(meta.id).toBe('existing-entity');
  });

  it('a file that splits into several packages gives each a new identity', async () => {
    const source = await file('data/pair.fasta', `>one\n${DNA}\n>two\n${DNA}A\n`);

    const converted = await convertLooseSequenceFile(root, source, {
      packageIdForPath: () => 'existing-entity',
    });

    const ids = await Promise.all(
      converted.packageRoots.map(
        async (packageRoot) =>
          JSON.parse(await readFile(join(packageRoot, '.forge', 'plasmid.json'), 'utf8')).id
      )
    );
    expect(ids).toHaveLength(2);
    expect(ids).not.toContain('existing-entity');
  });

  it('the heal leaves a primer set alone; an explicit conversion still splits it', async () => {
    const source = await file(
      'assemblies/test-1-accepted.primers.fasta',
      '>F2-fwd\nATGACCATGATTACGGATTCACTGG\n>F2-rev\nCAGGGTTTTCCCAGTCACGACGTTG\n'
    );

    const heal = await convertTreeToPlasmidPackages(root);
    expect(heal.converted).toBe(0);
    expect(heal.skippedDetails).toEqual([
      expect.objectContaining({ path: source, reason: expect.stringContaining('short oligos') }),
    ]);

    const converted = await convertLooseSequenceFile(root, source);
    expect(converted.packageRoots.map((path) => path.split('/').pop())).toEqual([
      'F2-fwd',
      'F2-rev',
    ]);
  });

  it('the heal does not split a file with more than 100 records', async () => {
    const records = Array.from({ length: 101 }, (_, index) => `>contig${index}\n${DNA}${DNA}\n`);
    const source = await file('assembly/contigs.fasta', records.join(''));

    const heal = await convertTreeToPlasmidPackages(root);

    expect(heal.converted).toBe(0);
    expect(heal.skippedDetails).toEqual([
      expect.objectContaining({ path: source, reason: expect.stringContaining('101 records') }),
    ]);
    expect(await exists(source)).toBe(true);
  });

  it('refuses a multi-FASTA that mixes DNA with protein and reports the counts', async () => {
    const source = await file(
      'mixed.fasta',
      `>gene\n${DNA}\n>product\nMALWMRLLPLLALLALWGPDPAAAFVNQHLCGSHLVEALYLVCGERGFFYTPKT\n`
    );

    const result = await convertLooseSequenceFile(root, source);

    expect(result.converted).toBe(false);
    expect(result.reason).toContain('mixes molecule types (1 DNA, 1 protein records)');
    expect(await exists(source)).toBe(true);
  });

  it('the heal converts an RNA .fasta into an RNA package', async () => {
    const rna = DNA.replace(/T/g, 'U');
    const source = await file('guide.fasta', `>guide\n${rna}\n`);

    const heal = await convertTreeToPlasmidPackages(root);

    expect(heal.converted).toBe(1);
    expect(await exists(source)).toBe(false);
    const product = await readFile(join(root, 'guide', 'guide.gb'), 'utf8');
    expect(product).toMatch(/^LOCUS\s+guide\s+\d+ bp\s+RNA\s/m);
    expect(product).not.toMatch(/^ +\d+ [acgt ]*t/m);
  });

  it('converts a read that a saved alignment uses like any other sequence', async () => {
    const dir = 'sequences/alignments/clone-verification';
    const source = await file(`${dir}/clone-1-verified.fasta`, `>clone-1-verified\n${DNA}\n`);
    await file(
      `${dir}/reference.gb.waypoint.json`,
      JSON.stringify({ sessions: [{ tracks: [{ queryPath: 'clone-1-verified.fasta' }] }] })
    );

    const heal = await convertTreeToPlasmidPackages(root);

    expect(heal.converted).toBe(1);
    expect(await exists(source)).toBe(false);
    expect(await exists(join(root, dir, 'clone-1-verified', '.forge', 'plasmid.json'))).toBe(true);
  });

  it('inspect reports what conversion would do without writing', async () => {
    const dna = await file('a.fasta', `>a\n${DNA}\n`);
    const short = await file('b.fasta', '>b\nATGTCCGGTGAA\n');
    const protein = await file('c.fasta', '>c\nMALWMRLLPLLALLALWGPDPAAAFVNQHLCGSH\n');
    const query = await file('d.fasta', `>d\n${DNA}\n`);
    await file('r.gb.waypoint.json', JSON.stringify({ alignments: [{ queryPath: 'd.fasta' }] }));

    expect(await inspectLooseSequenceFile(root, dna)).toEqual({
      state: 'convertible',
      reason: null,
    });
    expect(await inspectLooseSequenceFile(root, short)).toMatchObject({
      state: 'needs-dna-confirmation',
      sourceSha256: await sha256(short),
    });
    expect(await inspectLooseSequenceFile(root, protein)).toMatchObject({
      state: 'refused',
      reason: expect.stringContaining('protein'),
    });
    expect(await inspectLooseSequenceFile(root, query)).toEqual({
      state: 'convertible',
      reason: null,
    });
    for (const path of [dna, short, protein, query]) expect(await exists(path)).toBe(true);
  });

  it('a declaration for different bytes is refused, never applied to changed content', async () => {
    const source = await file('reference.fasta', `>ref\n${DNA}\n`);
    await expect(
      convertLooseSequenceFile(root, source, { confirmedDnaSourceSha256: 'a'.repeat(64) })
    ).rejects.toThrow();
    expect(await exists(source)).toBe(true);
  });

  it('names the stray character in a .dnas download instead of calling it unreadable', async () => {
    const source = await file(
      'S288C_YPRWdelta20_YPRWdelta20_genomic.dnas',
      `>YPRWdelta20 YPRWdelta20 SGDID:S000007214\nTGTTGGAATA\nCTGAAACGCAAGGATTG\`ATAATG\n`
    );

    const result = await convertLooseSequenceFile(root, source);
    expect(result.converted).toBe(false);
    expect(result.reason).toContain('Line 3: Invalid sequence character "`" at column 18');
    expect(await exists(source)).toBe(true);
  });

  it('leaves protein FASTA as a source', async () => {
    const source = await file('predicted_proteins.fasta', '>p\nMKIHHHHHHEEKLVIWIDKYGQ\n');
    const result = await convertLooseSequenceFile(root, source, {
      confirmedDnaSourceSha256: await sha256(source),
    });
    expect(result).toMatchObject({ converted: false, packageRoots: [] });
    expect(result.reason).toMatch(/not a DNA\/RNA sequence|protein/);
    expect(await exists(source)).toBe(true);
  });

  it('inspects a file in a folder whose name starts with two dots', async () => {
    const source = await file('..drafts/clone.fasta', `>clone\n${DNA}\n`);

    expect(await inspectLooseSequenceFile(root, source)).toMatchObject({ state: 'convertible' });
  });

  it('refuses a path outside the workspace', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'fixture-outside-'));
    try {
      const source = join(outside, 'x.dnas');
      await writeFile(source, `>x\n${DNA}\n`, 'utf8');
      await expect(convertLooseSequenceFile(root, source)).rejects.toThrow(
        'LOOSE_SEQUENCE_OUTSIDE_WORKSPACE'
      );
      expect(await exists(source)).toBe(true);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses a file reached through a symlinked directory that leaves the workspace', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'fixture-outside-'));
    try {
      const target = join(outside, 'x.dnas');
      await writeFile(target, `>x\n${DNA}\n`, 'utf8');
      await symlink(outside, join(root, 'linked'));
      await expect(convertLooseSequenceFile(root, join(root, 'linked', 'x.dnas'))).rejects.toThrow(
        'LOOSE_SEQUENCE_OUTSIDE_WORKSPACE'
      );
      expect(await exists(target)).toBe(true);
      expect(await exists(join(outside, 'x'))).toBe(false);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

// @vitest-environment node

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { materializeGenbankSources, splitGenbankText } from './genbank-reference-source';
import { resolveLocalReferenceSelection } from './local-reference-source-resolver';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

const SAMPLE = `LOCUS       TESTSEQ                 12 bp    DNA     linear
DEFINITION  test construct
ACCESSION   GCF_000000001.1
FEATURES             Location/Qualifiers
     source          1..12
                     /organism="Test organism"
     gene            1..6
     CDS             join(1..3,4..6)
     CDS             complement(join(7..9,
                     10..12))
ORIGIN
        1 acgtacgt acgt
//
`;

describe('GenBank custom reference sources', () => {
  it('keeps joins, complements, and a location wrapped onto the next line', () => {
    expect(splitGenbankText(SAMPLE)).toEqual([
      {
        seqId: 'TESTSEQ',
        organism: 'Test organism',
        accession: 'GCF_000000001.1',
        sequence: 'ACGTACGTACGT',
        features: [
          { type: 'gene', start: 1, end: 6, strand: '+' },
          { type: 'CDS', start: 1, end: 3, strand: '+', phase: 0 },
          { type: 'CDS', start: 4, end: 6, strand: '+', phase: 0 },
          { type: 'CDS', start: 7, end: 9, strand: '-', phase: 0 },
          { type: 'CDS', start: 10, end: 12, strand: '-', phase: 0 },
        ],
      },
    ]);
  });

  it('gives every coding segment the phase of its first whole codon', () => {
    const record = SAMPLE.replace(
      /     CDS             join\(1\.\.3,4\.\.6\)\n/u,
      '     CDS             join(1..4,5..6)\n                     /codon_start=2\n'
    ).replace(
      'complement(join(7..9,\n                     10..12))',
      'complement(join(7..8,9..12))'
    );
    expect(
      splitGenbankText(record)[0].features.filter((feature) => feature.type === 'CDS')
    ).toEqual([
      { type: 'CDS', start: 1, end: 4, strand: '+', phase: 1 },
      { type: 'CDS', start: 5, end: 6, strand: '+', phase: 0 },
      { type: 'CDS', start: 7, end: 8, strand: '-', phase: 2 },
      { type: 'CDS', start: 9, end: 12, strand: '-', phase: 0 },
    ]);
  });

  it('writes a FASTA and GFF3 pair the existing importer can read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genbank-source-'));
    temporaryRoots.push(root);
    const genbankPath = join(root, 'sample.gbff');
    await import('node:fs/promises').then(({ writeFile }) => writeFile(genbankPath, SAMPLE));
    const [fastaPath, gffPath] = await materializeGenbankSources(genbankPath, root);
    expect(await readFile(fastaPath, 'utf8')).toContain('>TESTSEQ');
    expect(await readFile(gffPath, 'utf8')).toContain('##gff-version 3');
    expect(await readFile(gffPath, 'utf8')).toContain('gene\t1\t6');
    expect(await readFile(gffPath, 'utf8')).toContain('CDS\t1\t3\t.\t+\t0\t');
    expect(await readFile(gffPath, 'utf8')).not.toContain('join(');
    const resolved = await resolveLocalReferenceSelection({
      selection: { path: genbankPath },
      stagingRoot: root,
    });
    expect(resolved.sourcePaths).toEqual([fastaPath, gffPath]);
  });
});

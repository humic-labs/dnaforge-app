// @vitest-environment node

import { gzipSync } from 'node:zlib';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { convertUcscGtfToGff3 } from './ucsc-gtf-to-gff3';

const CONTIGS = [
  { sourceSeqId: 'chr1', lengthBp: 12 },
  { sourceSeqId: 'chrUn_fixture', lengthBp: 5 },
] as const;

const GTF = [
  '# UCSC genePredToGtf fixture',
  'chr1\tncbiRefSeq\texon\t2\t8\t.\t+\t.\tgene_id "GENE 1"; transcript_id "TX.1"; exon_number "1"; gene_name "Fixture; Gene";',
  'chr1\tncbiRefSeq\tCDS\t4\t8\t.\t+\t0\tgene_id "GENE 1"; transcript_id "TX.1"; exon_number "1"; gene_name "Fixture; Gene";',
  '',
].join('\n');

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('UCSC GTF to admitted GFF3 conversion', () => {
  it('writes deterministic hierarchy and region coverage for the complete UCSC dictionary', async () => {
    const root = await temporaryRoot();
    const sourcePath = join(root, 'fixture.gtf.gz');
    const firstPath = join(root, 'first.gff3');
    const secondPath = join(root, 'second.gff3');
    await writeFile(sourcePath, gzipSync(GTF));

    const first = await convertUcscGtfToGff3({
      sourcePath,
      destinationPath: firstPath,
      contigs: CONTIGS,
    });
    const second = await convertUcscGtfToGff3({
      sourcePath,
      destinationPath: secondPath,
      contigs: CONTIGS,
    });

    expect(second).toEqual(first);
    expect(await readFile(secondPath)).toEqual(await readFile(firstPath));
    const output = await readFile(firstPath, 'utf8');
    expect(output).toMatch(/^##gff-version 3\n/u);
    expect(output).toContain('##sequence-region chr1 1 12');
    expect(output).toContain('##sequence-region chrUn_fixture 1 5');
    expect(output).toMatch(/chrUn_fixture\tUCSC\tregion\t1\t5\t\.\t\.\t\.\tID=/u);
    expect(output).toMatch(/chr1\tncbiRefSeq\tgene\t2\t8\t\.\t\+\t\.\tID=/u);
    expect(output).toMatch(/chr1\tncbiRefSeq\tmRNA\t2\t8\t\.\t\+\t\.\tID=.*;Parent=/u);
    expect(output).toMatch(/chr1\tncbiRefSeq\texon\t2\t8\t\.\t\+\t\.\tID=.*;Parent=/u);
    expect(output).toMatch(/chr1\tncbiRefSeq\tCDS\t4\t8\t\.\t\+\t0\tID=.*;Parent=/u);
    expect(output).toContain('gene_name=Fixture%3B%20Gene');
    expect(first).toMatchObject({
      sourceRows: 2,
      admittedSourceRows: 2,
      omittedSourceRows: 0,
      omittedSourceSeqIds: [],
      featureRows: 2,
      geneRows: 1,
      transcriptRows: 1,
    });
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(first.byteLength).toBe(Buffer.byteLength(output));
  });

  it('rejects GTF coordinates outside an admitted chromosome-size authority', async () => {
    const root = await temporaryRoot();
    const sourcePath = join(root, 'wrong.gtf');
    await writeFile(
      sourcePath,
      'chr1\trefGene\texon\t1\t13\t.\t+\t.\tgene_id "G"; transcript_id "T";\n'
    );

    await expect(
      convertUcscGtfToGff3({
        sourcePath,
        destinationPath: join(root, 'wrong.gff3'),
        contigs: CONTIGS,
      })
    ).rejects.toThrow(/exceed chr1 length 12/u);
  });

  it('rejects malformed coordinates before deciding whether the sequence is admitted', async () => {
    const root = await temporaryRoot();
    for (const [name, seqId, start, end] of [
      ['zero-start', 'chr1', '0', '2'],
      ['non-integer', 'chr1', '1.5', '2'],
      ['reversed', 'chrPatch', '3', '2'],
    ]) {
      const sourcePath = join(root, `${name}.gtf`);
      await writeFile(
        sourcePath,
        `${seqId}\trefGene\texon\t${start}\t${end}\t.\t+\t.\tgene_id "G"; transcript_id "T";\n`
      );

      await expect(
        convertUcscGtfToGff3({
          sourcePath,
          destinationPath: join(root, `${name}.gff3`),
          contigs: CONTIGS,
        })
      ).rejects.toThrow(/invalid coordinates/u);
    }
  });

  it('omits patch-sequence rows absent from the exact FASTA dictionary and records them', async () => {
    const root = await temporaryRoot();
    const sourcePath = join(root, 'patches.gtf');
    const destinationPath = join(root, 'patches.gff3');
    await writeFile(
      sourcePath,
      [
        'chrZ\trefGene\texon\t1\t2\t.\t+\t.\tgene_id "Z"; transcript_id "Z.1";',
        'chrPatch\trefGene\texon\t1\t2\t.\t+\t.\tgene_id "PATCH"; transcript_id "PATCH.1";',
        'chrPatch\trefGene\tCDS\t1\t2\t.\t+\t0\tgene_id "PATCH"; transcript_id "PATCH.1";',
        GTF,
      ].join('\n')
    );

    const receipt = await convertUcscGtfToGff3({
      sourcePath,
      destinationPath,
      contigs: CONTIGS,
    });

    expect(receipt).toMatchObject({
      sourceRows: 5,
      admittedSourceRows: 2,
      omittedSourceRows: 3,
      omittedSourceSeqIds: ['chrPatch', 'chrZ'],
    });
    expect(await readFile(destinationPath, 'utf8')).not.toContain('chrPatch');

    const allMissingSourcePath = join(root, 'all-missing.gtf');
    await writeFile(
      allMissingSourcePath,
      'chrPatch\trefGene\texon\t1\t2\t.\t+\t.\tgene_id "PATCH"; transcript_id "PATCH.1";\n'
    );
    await expect(
      convertUcscGtfToGff3({
        sourcePath: allMissingSourcePath,
        destinationPath: join(root, 'all-missing.gff3'),
        contigs: CONTIGS,
      })
    ).rejects.toThrow(/no feature rows on the admitted UCSC contigs/u);
  });

  it('rejects an omitted sequence ID that cannot be represented by the audit receipt', async () => {
    const root = await temporaryRoot();
    for (const [name, seqId] of [
      ['whitespace', 'chr Patch'],
      ['utf16-overflow', '😀'.repeat(200)],
    ]) {
      const sourcePath = join(root, `${name}.gtf`);
      await writeFile(
        sourcePath,
        [
          `${seqId}\trefGene\texon\t1\t2\t.\t+\t.\tgene_id "PATCH"; transcript_id "PATCH.1";`,
          GTF,
        ].join('\n')
      );

      await expect(
        convertUcscGtfToGff3({
          sourcePath,
          destinationPath: join(root, `${name}.gff3`),
          contigs: CONTIGS,
        })
      ).rejects.toThrow(/sequence ID/u);
    }
  });

  it('rejects malformed attributes and removes the incomplete destination', async () => {
    const root = await temporaryRoot();
    const sourcePath = join(root, 'malformed.gtf');
    const destinationPath = join(root, 'malformed.gff3');
    await writeFile(
      sourcePath,
      'chr1\trefGene\texon\t1\t2\t.\t+\t.\tgene_id "G"; transcript_id "unterminated;\n'
    );

    await expect(
      convertUcscGtfToGff3({ sourcePath, destinationPath, contigs: CONTIGS })
    ).rejects.toThrow(/attribute/u);
    await expect(readFile(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('enforces expanded-byte, line-byte, and feature-row limits', async () => {
    const root = await temporaryRoot();
    const sourcePath = join(root, 'bounded.gtf.gz');
    await writeFile(sourcePath, gzipSync(GTF));

    await expect(
      convertUcscGtfToGff3({
        sourcePath,
        destinationPath: join(root, 'expanded.gff3'),
        contigs: CONTIGS,
        limits: { maxExpandedBytes: 32 },
      })
    ).rejects.toThrow(/expanded byte bound/u);
    await expect(
      convertUcscGtfToGff3({
        sourcePath,
        destinationPath: join(root, 'line.gff3'),
        contigs: CONTIGS,
        limits: { maxLineBytes: 32 },
      })
    ).rejects.toThrow(/line byte bound/u);
    await expect(
      convertUcscGtfToGff3({
        sourcePath,
        destinationPath: join(root, 'rows.gff3'),
        contigs: CONTIGS,
        limits: { maxFeatureRows: 1 },
      })
    ).rejects.toThrow(/feature-row bound/u);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dnaforge-ucsc-gtf-'));
  temporaryRoots.push(root);
  return root;
}

import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import {
  inspectLocalReferenceSources,
  planLocalReferencePreparation,
  writeLocalReferencePreparationManifest,
} from './local-reference-source-plan';

const PROJECT_ROOT = resolve(process.cwd(), '../..');
const PUC19_FASTA = join(PROJECT_ROOT, 'test-fixtures/indexed/pUC19/pUC19.fa');
const PUC19_GFF3 = join(PROJECT_ROOT, 'test-fixtures/indexed/pUC19/pUC19.gff3.gz');

describe('local reference source planning', () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
    );
  });

  it('turns the raw pUC19 FASTA+GFF3 pair into a stable parser-compatible plan', async () => {
    const cacheRoot = await temporaryRoot();
    const sourceDirectoryBefore = await readdir(dirname(PUC19_FASTA));
    const manifestPath = join(cacheRoot, 'staging', 'reference-preparation.v2.json');

    const reversedPlan = await planLocalReferencePreparation({
      sourcePaths: [PUC19_GFF3, PUC19_FASTA],
      manifestPath,
    });
    const ordinaryPlan = await planLocalReferencePreparation({
      sourcePaths: [PUC19_FASTA, PUC19_GFF3],
      manifestPath,
    });

    expect(reversedPlan.inspection).toMatchObject({
      assemblyId: expect.stringMatching(/^local-[0-9a-f]{24}$/u),
      name: 'pUC19',
      organism: 'Cloning vector pUC19c',
      fasta: {
        kind: 'fasta',
        path: PUC19_FASTA,
        sha256: '7267c78e26eef9671a4fccaf3bf12ff56c27220c90135746164c943be48aad1f',
        gzipCompressed: false,
        contigs: [
          {
            sourceSeqId: 'puc19',
            lengthBp: 2686,
            normalizedSequenceSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
          },
        ],
      },
      gff3: {
        kind: 'gff3',
        path: PUC19_GFF3,
        sha256: 'dd7cae6d069314768be3e16f7b023d7ce38f40af4f85f035a6d6bb467a10a3a8',
        gzipCompressed: true,
        globalCircular: true,
      },
    });
    expect(ordinaryPlan.inspection.assemblyId).toBe(reversedPlan.inspection.assemblyId);
    expect(reversedPlan.manifest).toMatchObject({
      contract: 'dnaforge-reference-preparation.v2',
      assemblyIdentity: {
        contract: 'dnaforge-reference-assembly-identity.v2',
        sha256: reversedPlan.inspection.assemblyIdentitySha256,
      },
      assembly: {
        id: reversedPlan.inspection.assemblyId,
        name: 'pUC19',
        organism: 'Cloning vector pUC19c',
      },
      sources: {
        fasta: {
          path: PUC19_FASTA,
          sha256: reversedPlan.inspection.fasta.sha256,
        },
        annotations: {
          format: 'gff3',
          path: PUC19_GFF3,
          sha256: reversedPlan.inspection.gff3?.sha256,
        },
      },
      provenance: {
        provider: 'Local file import',
        datasetId: reversedPlan.inspection.assemblyId,
      },
      contigs: [
        {
          chrom: 'puc19',
          sourceSeqId: 'puc19',
          displayName: 'puc19',
          lengthBp: 2686,
          circular: true,
        },
      ],
    });
    expect(reversedPlan.loaded.entry.members).toEqual([
      expect.objectContaining({
        chrom: 'puc19',
        lengthBp: 2686,
        circular: true,
      }),
    ]);

    await writeLocalReferencePreparationManifest(reversedPlan);
    const written = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    expect(written).toEqual(reversedPlan.manifest);
    await expect(writeLocalReferencePreparationManifest(reversedPlan)).resolves.toBe(
      reversedPlan.loaded
    );
    expect(await readdir(dirname(PUC19_FASTA))).toEqual(sourceDirectoryBefore);
  });

  it('classifies gzip by bytes rather than names and accepts compressed FASTA plus plain GFF3', async () => {
    const root = await temporaryRoot();
    const fastaBytes = await readFile(PUC19_FASTA);
    const gff3Bytes = gunzipSync(await readFile(PUC19_GFF3));
    const compressedFastaWithOpaqueName = join(root, 'first-upload.data');
    const plainGff3WithOpaqueName = join(root, 'second-upload.data');
    await writeFile(compressedFastaWithOpaqueName, gzipSync(fastaBytes));
    await writeFile(plainGff3WithOpaqueName, gff3Bytes);

    const inspection = await inspectLocalReferenceSources([
      plainGff3WithOpaqueName,
      compressedFastaWithOpaqueName,
    ]);

    expect(inspection.fasta).toMatchObject({
      path: await realpath(compressedFastaWithOpaqueName),
      gzipCompressed: true,
      contigs: [{ sourceSeqId: 'puc19', lengthBp: 2686 }],
    });
    expect(inspection.gff3).toMatchObject({
      path: await realpath(plainGff3WithOpaqueName),
      gzipCompressed: false,
      globalCircular: true,
    });
    expect(inspection.fasta.sha256).toBe(
      createHash('sha256').update(gzipSync(fastaBytes)).digest('hex')
    );
    expect(inspection.gff3?.sha256).toBe(createHash('sha256').update(gff3Bytes).digest('hex'));
  });

  it('plans a real sequence-only reference without inventing annotation assets', async () => {
    const root = await temporaryRoot();
    const firstFasta = join(root, 'first.fa');
    const equivalentFasta = join(root, 'equivalent.fasta');
    await writeFile(firstFasta, '>chrA description\nac gt\n>chrB\ntt\naa\n');
    await writeFile(equivalentFasta, '>chrA\nACGT\n>chrB\nTTAA\n');

    const first = await planLocalReferencePreparation({
      sourcePaths: [firstFasta],
      manifestPath: join(root, 'cache-a', 'reference-preparation.v2.json'),
    });
    const equivalent = await planLocalReferencePreparation({
      sourcePaths: [equivalentFasta],
      manifestPath: join(root, 'cache-b', 'reference-preparation.v2.json'),
    });

    expect(first.inspection.fasta.sha256).not.toBe(equivalent.inspection.fasta.sha256);
    expect(first.inspection.assemblyId).toBe(equivalent.inspection.assemblyId);
    expect(first.manifest.sources).not.toHaveProperty('annotations');
    expect(first.loaded.source).not.toHaveProperty('gffPath');
    expect(first.loaded.entry.members).toEqual([
      expect.objectContaining({
        chrom: 'chrA',
        lengthBp: 4,
        manifest: {
          fastaPath: 'prepared/chrA/chrA.fa.gz',
          faiPath: 'prepared/chrA/chrA.fa.gz.fai',
        },
      }),
      expect.objectContaining({
        chrom: 'chrB',
        lengthBp: 4,
        manifest: {
          fastaPath: 'prepared/chrB/chrB.fa.gz',
          faiPath: 'prepared/chrB/chrB.fa.gz.fai',
        },
      }),
    ]);
  });

  it('lets a listing-derived identity outrank the file name without touching sequence identity', async () => {
    const root = await temporaryRoot();
    const fastaPath = join(root, 'sacCer3.fa');
    await writeFile(fastaPath, '>chrI\nACGT\n');
    const plain = await planLocalReferencePreparation({
      sourcePaths: [fastaPath],
      manifestPath: join(root, 'plain', 'reference-preparation.v2.json'),
    });
    const named = await planLocalReferencePreparation({
      sourcePaths: [fastaPath],
      manifestPath: join(root, 'named', 'reference-preparation.v2.json'),
      identity: {
        name: 'R64 (GCF_000146045.2)',
        organism: 'Saccharomyces cerevisiae',
        taxId: 559292,
        accession: 'GCF_000146045.2',
        description: 'UCSC GenArk assembly GCF_000146045.2.',
        provenance: {
          provider: 'UCSC GenArk',
          datasetId: 'GCF_000146045.2',
          sourceUrl: 'https://hgdownload.soe.ucsc.edu/hubs/GCF/000/146/045/GCF_000146045.2/hub.txt',
        },
      },
    });

    expect(plain.manifest.assembly).toMatchObject({
      name: 'sacCer3',
      organism: 'Imported reference',
      description: 'Custom reference imported from sacCer3.fa.',
    });
    expect(plain.manifest.provenance).toEqual({
      provider: 'Local file import',
      datasetId: plain.inspection.assemblyId,
      datasetVersion: expect.stringMatching(/^sequence-[0-9a-f]{16}$/u),
    });
    expect(named.manifest.assembly).toEqual({
      id: plain.manifest.assembly.id,
      name: 'R64 (GCF_000146045.2)',
      organism: 'Saccharomyces cerevisiae',
      taxId: 559292,
      accession: 'GCF_000146045.2',
      description: 'UCSC GenArk assembly GCF_000146045.2.',
    });
    expect(named.manifest.provenance).toEqual({
      provider: 'UCSC GenArk',
      datasetId: 'GCF_000146045.2',
      datasetVersion: plain.manifest.provenance.datasetVersion,
      sourceUrl: 'https://hgdownload.soe.ucsc.edu/hubs/GCF/000/146/045/GCF_000146045.2/hub.txt',
    });
    expect(named.loaded.entry).toMatchObject({
      id: plain.loaded.entry.id,
      name: 'R64 (GCF_000146045.2)',
      organism: 'Saccharomyces cerevisiae',
      assembly: 'GCF_000146045.2',
    });
  });

  it('plans from complete sequence-region directives while preserving raw source identity', async () => {
    const root = await temporaryRoot();
    const fastaPath = join(root, 'reference.data');
    const gff3Path = join(root, 'annotations.data');
    const fastaBytes = Buffer.from('>chr1\nACGTACGTACGT\n');
    const gff3Bytes = Buffer.from(
      [
        '##gff-version 3',
        '##sequence-region chr1 1 12',
        'chr1\ttest\tgene\t1\t12\t.\t+\t.\tID=gene-1',
        '',
      ].join('\n')
    );
    await writeFile(fastaPath, fastaBytes);
    await writeFile(gff3Path, gff3Bytes);

    const plan = await planLocalReferencePreparation({
      sourcePaths: [gff3Path, fastaPath],
      manifestPath: join(root, 'cache', 'reference-preparation.v2.json'),
    });

    expect(plan.manifest.contigs).toEqual([
      expect.objectContaining({
        chrom: 'chr1',
        sourceSeqId: 'chr1',
        displayName: 'chr1',
        lengthBp: 12,
        circular: false,
      }),
    ]);
    expect(plan.inspection.fasta.sha256).toBe(
      createHash('sha256').update(fastaBytes).digest('hex')
    );
    expect(plan.inspection.gff3?.sha256).toBe(createHash('sha256').update(gff3Bytes).digest('hex'));
    expect(plan.inspection.assemblyId).toBe(
      `local-${plan.inspection.assemblyIdentitySha256.slice(0, 24)}`
    );
  });

  it('plans from unique NCBI assembly region rows and ignores internal repeat regions', async () => {
    const root = await temporaryRoot();
    const fastaPath = join(root, 'reference.fa');
    const gff3Path = join(root, 'annotations.gff3');
    await writeFile(fastaPath, `>chr5\n${'A'.repeat(100)}\n`);
    await writeFile(
      gff3Path,
      [
        '##gff-version 3',
        'chr5\tRefSeq\tregion\t1\t100\t.\t+\t.\tID=chr5;gbkey=Src;genome=chromosome',
        'chr5\tRefSeq\tregion\t25\t30\t.\t+\t.\tID=repeat;gbkey=repeat_region',
        'chr5\tRefSeq\tgene\t1\t20\t.\t+\t.\tID=gene-1',
        '',
      ].join('\n')
    );

    const plan = await planLocalReferencePreparation({
      sourcePaths: [fastaPath, gff3Path],
      manifestPath: join(root, 'cache', 'reference-preparation.v2.json'),
    });

    expect(plan.manifest.contigs).toEqual([
      expect.objectContaining({
        chrom: 'chr5',
        sourceSeqId: 'chr5',
        lengthBp: 100,
      }),
    ]);
    await expect(inspectLocalReferenceSources([fastaPath, gff3Path])).resolves.toMatchObject({
      fasta: { contigs: [{ sourceSeqId: 'chr5', lengthBp: 100 }] },
    });
  });

  it('falls back to full FASTA inspection when assembly region rows are ambiguous', async () => {
    const root = await temporaryRoot();
    const fastaPath = join(root, 'reference.fa');
    const gff3Path = join(root, 'annotations.gff3');
    await writeFile(fastaPath, '>chr1\n');
    await writeFile(
      gff3Path,
      [
        '##gff-version 3',
        'chr1\tRefSeq\tregion\t1\t10\t.\t+\t.\tID=first;gbkey=Src',
        'chr1\tRefSeq\tregion\t1\t10\t.\t+\t.\tID=second;gbkey=Src',
        '',
      ].join('\n')
    );

    await expect(
      planLocalReferencePreparation({
        sourcePaths: [fastaPath, gff3Path],
        manifestPath: join(root, 'cache', 'reference-preparation.v2.json'),
      })
    ).rejects.toThrow('contains no bases');
  });

  it('falls back when sequence-region directives disagree with assembly region rows', async () => {
    const root = await temporaryRoot();
    const fastaPath = join(root, 'reference.fa');
    const gff3Path = join(root, 'annotations.gff3');
    await writeFile(fastaPath, '>chr1\n');
    await writeFile(
      gff3Path,
      [
        '##gff-version 3',
        '##sequence-region chr1 1 9',
        'chr1\tRefSeq\tregion\t1\t10\t.\t+\t.\tID=chr1;gbkey=Src',
        '',
      ].join('\n')
    );

    await expect(
      planLocalReferencePreparation({
        sourcePaths: [fastaPath, gff3Path],
        manifestPath: join(root, 'cache', 'reference-preparation.v2.json'),
      })
    ).rejects.toThrow('contains no bases');
  });

  it('rejects FASTA and GFF3 sequence sets that cannot satisfy assembly ingestion', async () => {
    const root = await temporaryRoot();
    const fastaPath = join(root, 'two-contigs.fa');
    const gff3Path = join(root, 'one-contig.gff3');
    await writeFile(fastaPath, '>chr1\nACGT\n>chr2\nTGCA\n');
    await writeFile(
      gff3Path,
      ['##gff-version 3', 'chr1\ttest\tgene\t1\t4\t.\t+\t.\tID=gene-1', ''].join('\n')
    );

    await expect(inspectLocalReferenceSources([gff3Path, fastaPath])).rejects.toThrow(
      'FASTA sequence IDs without GFF3 feature rows: "chr2"'
    );
  });

  it('fails clearly on an embedded FASTA section instead of treating it as external input', async () => {
    const root = await temporaryRoot();
    const fastaPath = join(root, 'reference.fa');
    const gff3Path = join(root, 'embedded.gff3');
    await writeFile(fastaPath, '>chr1\nACGT\n');
    await writeFile(
      gff3Path,
      [
        '##gff-version 3',
        'chr1\ttest\tgene\t1\t4\t.\t+\t.\tID=gene-1',
        '##FASTA',
        '>chr1',
        'ACGT',
        '',
      ].join('\n')
    );

    await expect(inspectLocalReferenceSources([fastaPath, gff3Path])).rejects.toThrow(
      'embedded ##FASTA section is not supported'
    );
  });

  it('rejects non-ASCII sequence symbols before computing a misleading identity', async () => {
    const root = await temporaryRoot();
    const fastaPath = join(root, 'invalid.fa');
    await writeFile(fastaPath, '>chr1\nACGé\n');

    await expect(inspectLocalReferenceSources([fastaPath])).rejects.toThrow(
      'FASTA sequence data must contain ASCII symbols'
    );
  });

  it('will not write generated metadata beside the selected source files', async () => {
    const sourceRoot = await temporaryRoot();
    const fastaPath = join(sourceRoot, 'pUC19.fa');
    const gff3Path = join(sourceRoot, 'pUC19.gff3.gz');
    await copyFile(PUC19_FASTA, fastaPath);
    await copyFile(PUC19_GFF3, gff3Path);
    const forbiddenManifestPath = join(sourceRoot, 'generated-reference-manifest.json');
    const plan = await planLocalReferencePreparation({
      sourcePaths: [fastaPath, gff3Path],
      manifestPath: forbiddenManifestPath,
    });

    await expect(writeLocalReferencePreparationManifest(plan)).rejects.toThrow(
      'must be written in the private reference cache'
    );
    await expect(readFile(forbiddenManifestPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  async function temporaryRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'dnaforge-local-reference-plan-'));
    temporaryRoots.push(root);
    return root;
  }
});

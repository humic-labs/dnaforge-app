import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import {
  unpackPrepackedAnnotationSearchIndexV1,
  unpackPrepackedProteinSearchIndexV1,
  type PrepackedAnnotationSearchIndexManifestV1,
  type PrepackedProteinSearchIndexManifestV1,
} from '@waypoint/genome-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runReferenceAssetPreparation } from './reference-preparation-engine';

const execFileAsync = promisify(execFile);
const ENABLED = process.env.WAYPOINT_REFERENCE_PREPARATION_INTEGRATION === '1';
const PROJECT_ROOT = resolve(process.cwd(), '../..');
const MANIFEST_PATH = join(PROJECT_ROOT, 'test-fixtures/reference-preparation/puc19.v1.json');
const INDEXER_PATH = join(PROJECT_ROOT, 'target/release/dna-indexer');

interface ReferenceAssetReceipt {
  readonly status: string;
  readonly workspaceRoot: string;
  readonly sourceGenerationRoot: string;
  readonly publication: {
    readonly publicationId: string;
    readonly sourceMaterializationFingerprint: string;
    readonly productLayout?: {
      readonly storage: string;
    };
  };
  readonly trackTypes: string[];
  readonly message?: string;
}

describe.skipIf(!ENABLED)('manifest-driven reference preparation lifecycle', () => {
  let cacheRoot = '';
  let preparationManifestPath = '';
  let firstReceipt: ReferenceAssetReceipt;

  beforeAll(async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), 'dnaforge-reference-preparation-integration-'));
    preparationManifestPath = await copyFixtureOutsideProject(cacheRoot);
    firstReceipt = await runReferenceAssets('ensure', cacheRoot, preparationManifestPath);
  }, 60_000);

  afterAll(async () => {
    if (cacheRoot) await rm(cacheRoot, { recursive: true, force: true });
  });

  it('publishes a self-describing, renderable, searchable reference generation', async () => {
    expect(firstReceipt.status).toBe('ready');
    expect(firstReceipt.trackTypes).toEqual(
      expect.arrayContaining(['primer_bind', 'promoter', 'protein_bind', 'rep_origin'])
    );
    expect(firstReceipt.publication.productLayout?.storage).toBe('publication-generation-root.v1');
    await expect(stat(join(firstReceipt.sourceGenerationRoot, '.waypoint'))).resolves.toBeTruthy();
    await expect(stat(join(firstReceipt.workspaceRoot, '.waypoint'))).rejects.toThrow();

    const definition = JSON.parse(
      await readFile(
        join(firstReceipt.sourceGenerationRoot, 'prepared-reference-definition.v1.json'),
        'utf8'
      )
    ) as Record<string, unknown>;
    expect(definition).toMatchObject({
      contract: 'dnaforge-prepared-reference-definition.v1',
      pipelineRevision: 1,
      id: 'puc19-local-fixture',
      members: [
        {
          chrom: 'puc19',
          sourceSeqId: 'puc19',
          lengthBp: 2686,
          circular: true,
        },
      ],
    });
    expect(JSON.stringify(definition)).not.toContain(PROJECT_ROOT);

    const files = await listFiles(firstReceipt.workspaceRoot);
    expect(
      files.filter((path) => path.endsWith('.annotation-scene.v6.bin')).length
    ).toBeGreaterThan(0);
    expect(files.filter((path) => path.endsWith('.rgba.br')).length).toBeGreaterThan(0);
    expect(files.filter((path) => path.endsWith('.annotation-product-set.v2.json'))).toHaveLength(
      2
    );

    const annotationCachePath = requireSingle(
      files.filter((path) => /annotation-search-.*\.v2\.json$/.test(path)),
      'annotation search cache'
    );
    const annotationCache = JSON.parse(await readFile(annotationCachePath, 'utf8')) as {
      payloadFile: string;
      searchManifest: PrepackedAnnotationSearchIndexManifestV1;
    };
    const annotationIndex = await unpackPrepackedAnnotationSearchIndexV1(
      annotationCache.searchManifest,
      await readBytes(join(dirname(annotationCachePath), annotationCache.payloadFile))
    );
    expect(annotationIndex.query('AmpR', 20)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'AmpR',
          featureType: 'mRNA',
          direction: 'forward',
        }),
      ])
    );

    const proteinCachePath = requireSingle(
      files.filter((path) => /protein-search-.*\.v1\.json$/.test(path)),
      'protein search cache'
    );
    const proteinCache = JSON.parse(await readFile(proteinCachePath, 'utf8')) as {
      payloadFile: string;
      searchManifest: PrepackedProteinSearchIndexManifestV1;
    };
    const proteinIndex = await unpackPrepackedProteinSearchIndexV1(
      proteinCache.searchManifest,
      await readBytes(join(dirname(proteinCachePath), proteinCache.payloadFile))
    );
    expect(proteinIndex.query('MTMITPSL', 20).matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'lacZ-alpha',
          featureType: 'mRNA',
          strand: 'forward',
        }),
      ])
    );
  });

  it('deep-verifies without republishing and reuses the immutable generation', async () => {
    const verified = await runReferenceAssets('verify', cacheRoot, preparationManifestPath);
    expect(verified.status).toBe('ready');
    expect(verified.publication).toEqual(firstReceipt.publication);

    const ensuredAgain = await runReferenceAssets('ensure', cacheRoot, preparationManifestPath);
    expect(ensuredAgain.status).toBe('ready');
    expect(ensuredAgain.publication).toEqual(firstReceipt.publication);
    expect(ensuredAgain.sourceGenerationRoot).toBe(firstReceipt.sourceGenerationRoot);
  });

  it('repairs an owned source-only publication in place instead of treating it as read-only', async () => {
    const repairCacheRoot = join(cacheRoot, 'interrupted-source-case');
    const prepared = await runReferenceAssets('ensure', repairCacheRoot, preparationManifestPath);
    expect(prepared.status).toBe('ready');
    const pointerPath = join(prepared.workspaceRoot, 'current-reference-assets.v1.json');
    const publication = JSON.parse(await readFile(pointerPath, 'utf8'));
    delete publication.productLayout;
    await writeFile(pointerPath, JSON.stringify(publication));
    const sourcePath = join(prepared.sourceGenerationRoot, 'prepared/puc19/puc19.fa.gz');
    const sourceBefore = await stat(sourcePath);

    const otherProfileRoot = join(repairCacheRoot, 'other-profile');
    const inherited = await runReferenceAssetPreparation({
      command: 'ensure',
      manifestPath: preparationManifestPath,
      projectRoot: PROJECT_ROOT,
      cacheRoot: repairCacheRoot,
      publicationRoot: otherProfileRoot,
      fallbackPublicationRoot: repairCacheRoot,
      themeMode: 'light',
      sourceBuildFingerprint: 'inherited-source-repair-test',
      indexerBinary: INDEXER_PATH,
      runCompilersDirectly: true,
    });
    expect(inherited.status).toBe('needs-refresh');
    await expect(
      stat(join(otherProfileRoot, 'puc19-local-fixture', 'current-reference-assets.v1.json'))
    ).rejects.toThrow();
    expect(JSON.parse(await readFile(pointerPath, 'utf8'))).toEqual(publication);

    const repaired = await runReferenceAssets(
      'ensure',
      repairCacheRoot,
      preparationManifestPath,
      true
    );

    expect(repaired.status, repaired.message).toBe('ready');
    expect(repaired.publication.publicationId).toBe(prepared.publication.publicationId);
    expect(repaired.sourceGenerationRoot).toBe(prepared.sourceGenerationRoot);
    expect(repaired.publication.productLayout?.storage).toBe('publication-generation-root.v1');
    const sourceAfter = await stat(sourcePath);
    expect({ ino: sourceAfter.ino, mtimeMs: sourceAfter.mtimeMs, size: sourceAfter.size }).toEqual({
      ino: sourceBefore.ino,
      mtimeMs: sourceBefore.mtimeMs,
      size: sourceBefore.size,
    });
  }, 60_000);

  it('treats source sequence mapping as immutable publication identity', async () => {
    const manifest = JSON.parse(await readFile(preparationManifestPath, 'utf8')) as {
      contigs: Array<Record<string, unknown>>;
    };
    manifest.contigs[0] = {
      ...manifest.contigs[0],
      sourceSeqId: 'different-source-sequence',
    };
    const remappedManifestPath = join(cacheRoot, 'remapped-reference.v1.json');
    await writeFile(remappedManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const stale = await runReferenceAssets('status', cacheRoot, remappedManifestPath, true);
    expect(stale.status).toBe('needs-refresh');
    expect(stale.message).toContain('definition does not match');
  });

  it('prepares an order-independent whole assembly and indexes annotations and phased proteins', async () => {
    const caseRoot = join(cacheRoot, 'multi-contig-case');
    const multiCacheRoot = join(caseRoot, 'cache');
    await mkdir(caseRoot);
    const multiContigManifest = await writeMultiContigFixture(caseRoot);
    const prepared = await runReferenceAssets('ensure', multiCacheRoot, multiContigManifest);
    expect(prepared.status).toBe('ready');

    const definition = JSON.parse(
      await readFile(
        join(prepared.sourceGenerationRoot, 'prepared-reference-definition.v1.json'),
        'utf8'
      )
    ) as {
      members: Array<{ chrom: string; sourceSeqId: string; lengthBp: number }>;
    };
    expect(definition.members).toEqual([
      expect.objectContaining({ chrom: 'chrB', sourceSeqId: 'source-B', lengthBp: 16 }),
      expect.objectContaining({ chrom: 'chrA', sourceSeqId: 'source-A', lengthBp: 15 }),
    ]);
    for (const [chrom, length] of [
      ['chrA', 15],
      ['chrB', 16],
    ] as const) {
      const preparedDir = join(prepared.sourceGenerationRoot, 'prepared', chrom);
      expect(await readFile(join(preparedDir, `${chrom}.fa.gz.fai`), 'utf8')).toMatch(
        new RegExp(`^${chrom}\\t${length}\\t`)
      );
      await stat(join(preparedDir, `${chrom}.gff3.gz.tbi`));
    }

    const files = await listFiles(prepared.workspaceRoot);
    const annotationCachePath = requireSingle(
      files.filter((path) => /annotation-search-.*\.v2\.json$/.test(path)),
      'multi-contig annotation search cache'
    );
    const annotationCache = JSON.parse(await readFile(annotationCachePath, 'utf8')) as {
      payloadFile: string;
      searchManifest: PrepackedAnnotationSearchIndexManifestV1;
    };
    const annotationIndex = await unpackPrepackedAnnotationSearchIndexV1(
      annotationCache.searchManifest,
      await readBytes(join(dirname(annotationCachePath), annotationCache.payloadFile))
    );
    expect(annotationIndex.query('Protein A', 20)).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'Protein A', start: 16, end: 31 })])
    );
    expect(annotationIndex.query('Protein B', 20)).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'Protein B', start: 0, end: 16 })])
    );

    const proteinCachePath = requireSingle(
      files.filter((path) => /protein-search-.*\.v1\.json$/.test(path)),
      'multi-contig protein search cache'
    );
    const proteinCache = JSON.parse(await readFile(proteinCachePath, 'utf8')) as {
      payloadFile: string;
      searchManifest: PrepackedProteinSearchIndexManifestV1;
    };
    const proteinIndex = await unpackPrepackedProteinSearchIndexV1(
      proteinCache.searchManifest,
      await readBytes(join(dirname(proteinCachePath), proteinCache.payloadFile))
    );
    expect(proteinIndex.query('MKWVT', 20).matches).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'Protein A', start: 16, end: 31 })])
    );
    expect(proteinIndex.query('MPELF', 20).matches).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'Protein B', start: 1, end: 16 })])
    );

    const ensuredAgain = await runReferenceAssets('ensure', multiCacheRoot, multiContigManifest);
    expect(ensuredAgain.publication).toEqual(prepared.publication);
    expect(ensuredAgain.sourceGenerationRoot).toBe(prepared.sourceGenerationRoot);
    const verified = await runReferenceAssets('verify', multiCacheRoot, multiContigManifest);
    expect(verified.publication).toEqual(prepared.publication);
  }, 60_000);

  it('rejects an extra source contig without changing the last good publication', async () => {
    const caseRoot = join(cacheRoot, 'extra-contig-case');
    const multiCacheRoot = join(caseRoot, 'cache');
    await mkdir(caseRoot);
    const manifestPath = await writeMultiContigFixture(caseRoot);
    const ready = await runReferenceAssets('ensure', multiCacheRoot, manifestPath);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      sources: { fasta: { path: string; sha256: string } };
    };
    const fastaPath = resolve(dirname(manifestPath), manifest.sources.fasta.path);
    const withExtra = `${await readFile(fastaPath, 'utf8')}>unexpected\nACGT\n`;
    await writeFile(fastaPath, withExtra);
    manifest.sources.fasta.sha256 = sha256(withExtra);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    await expect(runReferenceAssets('ensure', multiCacheRoot, manifestPath)).rejects.toThrow(
      /FASTA sequence unexpected is absent from the contig map/
    );
    const pointer = JSON.parse(
      await readFile(join(ready.workspaceRoot, 'current-reference-assets.v1.json'), 'utf8')
    ) as { publicationId: string };
    expect(pointer.publicationId).toBe(ready.publication.publicationId);
    expect(await readdir(join(ready.workspaceRoot, 'generations'))).toEqual([
      ready.publication.publicationId,
    ]);
  }, 60_000);
});

async function runReferenceAssets(
  command: 'ensure' | 'status' | 'verify',
  cacheRoot: string,
  manifestPath: string,
  allowNeedsRefresh = false
): Promise<ReferenceAssetReceipt> {
  await stat(INDEXER_PATH);
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      'pnpm',
      [
        'reference-assets',
        command,
        `--manifest=${manifestPath}`,
        `--cache-root=${cacheRoot}`,
        '--theme=light',
        '--json',
      ],
      {
        cwd: PROJECT_ROOT,
        env: { ...process.env, DNA_INDEXER_PATH: INDEXER_PATH },
        maxBuffer: 16 * 1024 * 1024,
        timeout: 60_000,
      }
    ));
  } catch (error) {
    const failed = error as Error & { code?: number; stdout?: string; stderr?: string };
    if (allowNeedsRefresh && failed.code === 2 && failed.stdout) {
      stdout = failed.stdout;
    } else {
      throw new Error([failed.message, failed.stdout, failed.stderr].filter(Boolean).join('\n'));
    }
  }
  const jsonLine = stdout
    .split(/\r?\n/)
    .reverse()
    .find((line) => line.startsWith('{'));
  if (!jsonLine) throw new Error(`reference-assets emitted no JSON receipt:\n${stdout}`);
  return JSON.parse(jsonLine) as ReferenceAssetReceipt;
}

async function copyFixtureOutsideProject(cacheRoot: string): Promise<string> {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8')) as {
    sources: {
      fasta: { path: string };
      annotations: { path: string };
    };
  };
  const sourceDir = dirname(MANIFEST_PATH);
  const inputDir = join(cacheRoot, 'raw-input');
  await mkdir(inputDir);
  await copyFile(resolve(sourceDir, manifest.sources.fasta.path), join(inputDir, 'puc19.fa'));
  await copyFile(
    resolve(sourceDir, manifest.sources.annotations.path),
    join(inputDir, 'puc19.gff3.gz')
  );
  manifest.sources.fasta.path = './raw-input/puc19.fa';
  manifest.sources.annotations.path = './raw-input/puc19.gff3.gz';
  const manifestPath = join(cacheRoot, 'puc19-reference.v1.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifestPath;
}

async function writeMultiContigFixture(root: string): Promise<string> {
  const fasta = '>source-A\nATGAAATGGGTTACC\n>source-B\nAATGCCCGAACTGTTT\n';
  const gff = [
    '##gff-version 3',
    '##sequence-region source-B 1 16',
    '##sequence-region source-A 1 15',
    'source-A\ttest\tgene\t1\t15\t.\t+\t.\tID=gene-A;Name=Gene A',
    'source-B\ttest\tCDS\t1\t16\t.\t+\t1\tID=cds-B;Parent=tx-B;Name=Protein B',
    'source-A\ttest\tmRNA\t1\t15\t.\t+\t.\tID=tx-A;Parent=gene-A;Name=Protein A',
    'source-B\ttest\tgene\t1\t16\t.\t+\t.\tID=gene-B;Name=Gene B',
    'source-A\ttest\tCDS\t1\t15\t.\t+\t0\tID=cds-A;Parent=tx-A;Name=Protein A',
    'source-B\ttest\tmRNA\t1\t16\t.\t+\t.\tID=tx-B;Parent=gene-B;Name=Protein B',
    '',
  ].join('\n');
  await writeFile(join(root, 'assembly.fa'), fasta);
  await writeFile(join(root, 'assembly.gff3'), gff);
  const manifest = {
    contract: 'dnaforge-reference-preparation.v1',
    assembly: {
      id: 'two-contig-local-fixture',
      name: 'Two-contig local preparation fixture',
      organism: 'synthetic DNA construct',
      description: 'Order-independent whole-assembly ingestion fixture.',
    },
    sources: {
      fasta: { path: './assembly.fa', sha256: sha256(fasta) },
      annotations: {
        format: 'gff3',
        path: './assembly.gff3',
        sha256: sha256(gff),
        provider: 'DNAForge test fixture',
        datasetId: 'two-contig',
        datasetVersion: '1',
      },
    },
    contigs: [
      {
        chrom: 'chrB',
        sourceSeqId: 'source-B',
        displayName: 'Chromosome B',
        lengthBp: 16,
        role: 'assembled-molecule',
        circular: false,
      },
      {
        chrom: 'chrA',
        sourceSeqId: 'source-A',
        displayName: 'Chromosome A',
        lengthBp: 15,
        role: 'assembled-molecule',
        circular: false,
      },
    ],
  };
  const manifestPath = join(root, 'reference.v1.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifestPath;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function readBytes(path: string): Promise<Uint8Array> {
  const bytes = await readFile(path);
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function requireSingle(paths: string[], label: string): string {
  if (paths.length !== 1) {
    throw new Error(`Expected one ${label}, received ${paths.length}: ${paths.join(', ')}`);
  }
  return paths[0];
}

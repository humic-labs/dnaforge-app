import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { LocalIndexedGenomeDataSource } from '@waypoint/genome-data/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { IndexedGenomeManifest } from '../../shared/indexed-genome';
import {
  planLocalReferencePreparation,
  writeLocalReferencePreparationManifest,
} from './local-reference-source-plan';
import { runReferenceAssetPreparation } from './reference-preparation-engine';
import {
  parsePreparedReferenceDefinition,
  preparedReferenceAssemblyEntry,
} from './reference-preparation-manifest';

const ENABLED = process.env.WAYPOINT_REFERENCE_PREPARATION_INTEGRATION === '1';
const PROJECT_ROOT = resolve(process.cwd(), '../..');
const INDEXER_PATH = join(PROJECT_ROOT, 'target/release/dna-indexer');
const FASTA = '>source-B\nAATGCCCGAACTGTTT\n>source-A\nATGAAATGGGTTACC\n';

describe.skipIf(!ENABLED)('sequence-only reference preparation', () => {
  let root = '';
  let cacheRoot = '';
  let manifestPath = '';
  let hostedManifestPath = '';
  let hostedFastaSha256 = '';
  let firstReceipt: Awaited<ReturnType<typeof runReferenceAssetPreparation>>;

  beforeAll(async () => {
    await stat(INDEXER_PATH);
    root = await mkdtemp(join(tmpdir(), 'dnaforge-sequence-only-reference-'));
    cacheRoot = join(root, 'cache');
    const sourceRoot = join(root, 'source');
    const fastaPath = join(sourceRoot, 'assembly.fa');
    manifestPath = join(cacheRoot, '.import-staging', 'reference-preparation.json');
    await Promise.all([
      mkdir(sourceRoot, { recursive: true }),
      mkdir(join(cacheRoot, '.import-staging'), { recursive: true }),
    ]);
    await writeFile(fastaPath, FASTA);
    const plan = await planLocalReferencePreparation({
      sourcePaths: [fastaPath],
      manifestPath,
    });
    await writeLocalReferencePreparationManifest(plan);
    const hostedManifest = {
      ...structuredClone(plan.manifest),
      assembly: {
        ...plan.manifest.assembly,
        id: 'hosted-sequence-fixture',
      },
    };
    hostedManifestPath = join(cacheRoot, '.import-staging', 'hosted-reference-preparation.json');
    hostedFastaSha256 = hostedManifest.sources.fasta.sha256;
    await writeFile(hostedManifestPath, `${JSON.stringify(hostedManifest, null, 2)}\n`);
    firstReceipt = await prepare('ensure');
  }, 60_000);

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('publishes real FASTA/FAI members without annotation placeholders', async () => {
    expect(firstReceipt.status).toBe('source-ready');
    expect(firstReceipt.publication).not.toBeNull();
    expect(firstReceipt.sourceGenerationRoot).not.toBeNull();
    const generationRoot = firstReceipt.sourceGenerationRoot!;
    const definition = parsePreparedReferenceDefinition(
      JSON.parse(
        await readFile(join(generationRoot, 'prepared-reference-definition.v1.json'), 'utf8')
      )
    );
    const entry = preparedReferenceAssemblyEntry(definition);

    expect(definition.contract).toBe('dnaforge-prepared-reference-definition.v3');
    expect(definition.source).not.toHaveProperty('gffSha256');
    expect(entry.members.map((member) => member.morphology)).toEqual([
      { kind: 'generic-contig', reason: 'ineligible-member' },
      { kind: 'generic-contig', reason: 'ineligible-member' },
    ]);
    expect(entry.members.map((member) => member.chrom)).toEqual(['source-B', 'source-A']);
    for (const member of entry.members) {
      expect(member.manifest).toBeDefined();
      expect(member.manifest).not.toHaveProperty('gffPath');
      expect(member.manifest).not.toHaveProperty('tbiPath');
      const directory = join(generationRoot, 'prepared', member.chrom);
      expect((await readdir(directory)).sort()).toEqual(
        [
          `${member.chrom}.fa.gz`,
          `${member.chrom}.fa.gz.fai`,
          `${member.chrom}.fa.gz.gzi`,
          'reference-source-materialization.v1.json',
        ].sort()
      );

      const manifest: IndexedGenomeManifest = {
        chrom: member.chrom,
        fastaPath: join(generationRoot, member.manifest!.fastaPath),
        faiPath: join(generationRoot, member.manifest!.faiPath),
        gffPath: null,
        tbiPath: null,
      };
      const source = new LocalIndexedGenomeDataSource(manifest, {
        checkFileMtimeOnRead: false,
      });
      try {
        const lengthBp = member.lengthBp;
        if (typeof lengthBp !== 'number') {
          throw new Error(`prepared member ${member.chrom} is missing lengthBp`);
        }
        await expect(source.getSequence(member.chrom, 0, lengthBp)).resolves.toHaveLength(lengthBp);
        await expect(source.getFeatures(member.chrom, 0, lengthBp, 0)).resolves.toEqual([]);
      } finally {
        await source.close();
      }
    }

    const allFiles = await listFiles(generationRoot);
    expect(allFiles.some((path) => /\.(?:gff3?|tbi)(?:\.gz)?$/u.test(path))).toBe(false);
  });

  it('reuses the immutable publication for ensure, status, and verify', async () => {
    for (const command of ['ensure', 'status', 'verify'] as const) {
      const receipt = await prepare(command);
      expect(receipt.status).toBe('source-ready');
      expect(receipt.publication).toEqual(firstReceipt.publication);
      expect(receipt.sourceGenerationRoot).toBe(firstReceipt.sourceGenerationRoot);
    }
  });

  it('publishes a catalog-bound hosted v2 manifest as a source-bound v3 definition', async () => {
    const receipt = await runReferenceAssetPreparation({
      command: 'ensure',
      assemblyId: 'hosted-sequence-fixture',
      manifestPath: hostedManifestPath,
      hostedManifestAdmission: {
        expectedCatalogId: 'hosted-sequence-fixture',
        expectedFastaSha256: hostedFastaSha256,
      },
      projectRoot: PROJECT_ROOT,
      cacheRoot,
      themeMode: 'light',
      sourceBuildFingerprint: 'hosted-sequence-integration',
      indexerBinary: INDEXER_PATH,
      runCompilersDirectly: true,
    });
    const definition = parsePreparedReferenceDefinition(
      JSON.parse(
        await readFile(
          join(receipt.sourceGenerationRoot!, 'prepared-reference-definition.v1.json'),
          'utf8'
        )
      )
    );
    expect(definition.contract).toBe('dnaforge-prepared-reference-definition.v3');
    if (definition.contract !== 'dnaforge-prepared-reference-definition.v3') {
      throw new Error('Expected a v3 hosted definition');
    }
    expect(definition).toMatchObject({
      id: 'hosted-sequence-fixture',
      semanticDigestSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      semantics: {
        assemblyIdentitySha256: definition.assemblyIdentity.sha256,
      },
    });
  });

  function prepare(
    command: 'ensure' | 'status' | 'verify'
  ): ReturnType<typeof runReferenceAssetPreparation> {
    return runReferenceAssetPreparation({
      command,
      assemblyId: 'unused-when-manifest-is-present',
      manifestPath,
      projectRoot: PROJECT_ROOT,
      cacheRoot,
      themeMode: 'light',
      sourceBuildFingerprint: 'sequence-only-integration',
      indexerBinary: INDEXER_PATH,
      runCompilersDirectly: true,
    });
  }
});

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

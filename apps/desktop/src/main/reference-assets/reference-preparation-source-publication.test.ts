import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ReferenceAssemblyEntry } from '../../features/sequence/reference-catalog';
import {
  PREPARED_REFERENCE_DEFINITION_FILE,
  PREPARED_REFERENCE_DEFINITION_V1,
  REFERENCE_PREPARATION_PIPELINE_REVISION,
  parsePreparedReferenceDefinition,
  preparedReferenceAssemblyEntry,
} from './reference-preparation-manifest';
import { inspectPreparedReferenceSourcePublication } from './reference-preparation-engine';
import { forkPreparedReferenceSourceGeneration } from './fork-prepared-reference-source';

const PROJECT_ROOT = resolve(process.cwd(), '../..');
const FIXTURE_ROOT = join(PROJECT_ROOT, 'test-fixtures/indexed/pUC19');
const ASSET_CACHE_KEY = 'focused-source-publication';
const FASTA_SHA256 = 'a'.repeat(64);
const GFF_SHA256 = 'b'.repeat(64);
const ENTRY: ReferenceAssemblyEntry = {
  id: ASSET_CACHE_KEY,
  name: 'Focused source publication',
  organism: 'synthetic DNA construct',
  description: 'Focused source-publication integrity fixture.',
  assetCacheKey: ASSET_CACHE_KEY,
  members: [
    {
      chrom: 'puc19',
      displayName: 'pUC19',
      lengthBp: 2_686,
      manifest: {
        fastaPath: 'prepared/puc19/puc19.fa',
        faiPath: 'prepared/puc19/puc19.fa.fai',
        gffPath: 'prepared/puc19/puc19.gff3.gz',
        tbiPath: 'prepared/puc19/puc19.gff3.gz.tbi',
      },
    },
  ],
};

describe('prepared reference source publication admission', () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
    );
  });

  it('admits an exact source-only publication and rejects missing bytes or altered receipts', async () => {
    const fixture = await createSourcePublicationFixture(temporaryRoots);
    const inspect = (entry = ENTRY) =>
      inspectPreparedReferenceSourcePublication({
        entry,
        cacheRoot: fixture.cacheRoot,
        expectedSource: {
          fastaSha256: FASTA_SHA256,
          gffSha256: GFF_SHA256,
        },
      });

    await expect(inspect()).resolves.toEqual({
      status: 'ready',
      publicationId: fixture.publicationId,
      sourceGenerationRoot: fixture.generationRoot,
    });

    const entryWithIdentity = preparedReferenceAssemblyEntry(
      parsePreparedReferenceDefinition(
        JSON.parse(
          await readFile(join(fixture.generationRoot, PREPARED_REFERENCE_DEFINITION_FILE), 'utf8')
        ),
        ASSET_CACHE_KEY
      )
    );
    await expect(inspect(entryWithIdentity)).resolves.toMatchObject({ status: 'ready' });
    const identity = entryWithIdentity.referenceIdentity;
    if (!identity) throw new Error('Prepared fixture must have verified reference identity.');
    await expect(
      inspect({
        ...entryWithIdentity,
        referenceIdentity: { ...identity, sequenceIdentity: 'c'.repeat(64) },
      })
    ).resolves.toMatchObject({
      status: 'needs-refresh',
      message: expect.stringContaining('definition does not match the admitted assembly entry'),
    });

    await writeFile(
      fixture.receiptPath,
      `${JSON.stringify({ ...fixture.receipt, indexerVersion: 'altered-version' })}\n`
    );
    await expect(inspect()).resolves.toMatchObject({
      status: 'needs-refresh',
      message: expect.stringContaining(
        'source materialization fingerprint does not match its pointer'
      ),
    });

    await writeFile(fixture.receiptPath, `${JSON.stringify(fixture.receipt)}\n`);
    await rm(fixture.outputFastaPath);
    await expect(inspect()).resolves.toMatchObject({
      status: 'needs-refresh',
      message: expect.stringContaining('prepared source is unavailable'),
    });
  });

  it('keeps a prepared source admitted when only chromosome drawing metadata changes', async () => {
    const fixture = await createSourcePublicationFixture(temporaryRoots);
    const entry: ReferenceAssemblyEntry = {
      ...ENTRY,
      members: ENTRY.members.map((member) => ({
        ...member,
        cytobandId: member.chrom,
        morphology: {
          kind: 'localized',
          interval: { startBp: 1_200, endBp: 1_400 },
          topology: 'internal',
        },
      })),
    };
    await expect(
      inspectPreparedReferenceSourcePublication({
        entry,
        cacheRoot: fixture.cacheRoot,
        expectedSource: { fastaSha256: FASTA_SHA256, gffSha256: GFF_SHA256 },
      })
    ).resolves.toMatchObject({ status: 'ready', publicationId: fixture.publicationId });

    await expect(
      inspectPreparedReferenceSourcePublication({
        entry: {
          ...entry,
          members: entry.members.map((member) => ({
            ...member,
            lengthBp: (member.lengthBp ?? 0) + 1,
          })),
        },
        cacheRoot: fixture.cacheRoot,
        expectedSource: { fastaSha256: FASTA_SHA256, gffSha256: GFF_SHA256 },
      })
    ).resolves.toMatchObject({
      status: 'needs-refresh',
      message: expect.stringContaining('definition does not match'),
    });
  });

  it.each(['local', 'portable'] as const)(
    'forks an inherited %s source into an independent generation without changing its owner',
    async (receiptKind) => {
      const fixture = await createSourcePublicationFixture(temporaryRoots);
      const sourcePaths = {
        fasta: fixture.outputFastaPath,
        fai: `${fixture.outputFastaPath}.fai`,
        gff: join(fixture.generationRoot, 'prepared/puc19/puc19.gff3.gz'),
        tbi: join(fixture.generationRoot, 'prepared/puc19/puc19.gff3.gz.tbi'),
      };
      if (receiptKind === 'portable') {
        const output = Object.fromEntries(
          await Promise.all(
            Object.entries(sourcePaths).map(async ([kind, path]) => {
              const bytes = await readFile(path);
              return [
                kind,
                {
                  sha256: createHash('sha256').update(bytes).digest('hex'),
                  byteLength: bytes.length,
                  continuity: await fileIdentity(path),
                },
              ];
            })
          )
        );
        await writeFile(
          fixture.receiptPath,
          JSON.stringify({
            contract: 'waypoint-reference-source-materialization.v2',
            chrom: 'puc19',
            pipelineRevision: 3,
            bundleFingerprint: 'f'.repeat(64),
            indexerContractToken: 'focused-portable-source',
            source: { fastaSha256: FASTA_SHA256, gffSha256: GFF_SHA256 },
            output,
          })
        );
      }
      const pointerPath = join(
        fixture.cacheRoot,
        ASSET_CACHE_KEY,
        'current-reference-assets.v1.json'
      );
      const originalPointer = await readFile(pointerPath, 'utf8');
      const originalReceipt = await readFile(fixture.receiptPath, 'utf8');
      const originalIdentities = await Promise.all(Object.values(sourcePaths).map(fileIdentity));
      const generationRoot = join(fixture.cacheRoot, ASSET_CACHE_KEY, 'generations/owned-fork');
      await mkdir(generationRoot);

      await forkPreparedReferenceSourceGeneration({
        entry: ENTRY,
        sourceGenerationRoot: fixture.generationRoot,
        destinationGenerationRoot: generationRoot,
      });

      const forkReceipt = JSON.parse(
        await readFile(
          join(generationRoot, 'prepared/puc19/reference-source-materialization.v1.json'),
          'utf8'
        )
      );
      const publicationRoot = join(fixture.cacheRoot, 'profile-publications');
      await mkdir(join(publicationRoot, ASSET_CACHE_KEY), { recursive: true });
      const sourceMaterializationFingerprint = createHash('sha256')
        .update(
          JSON.stringify({
            assetCacheKey: ASSET_CACHE_KEY,
            dnaIndexerSchema: 2,
            receipts: [forkReceipt],
          })
        )
        .digest('hex');
      await writeFile(
        join(publicationRoot, ASSET_CACHE_KEY, 'current-reference-assets.v1.json'),
        JSON.stringify({
          contract: 'reference-asset-publication.v1',
          assetCacheKey: ASSET_CACHE_KEY,
          publicationId: 'owned-fork',
          sourceMaterializationFingerprint,
          publishedAtMs: 1,
        })
      );
      await expect(
        inspectPreparedReferenceSourcePublication({
          entry: ENTRY,
          cacheRoot: fixture.cacheRoot,
          publicationRoot,
          fallbackPublicationRoot: fixture.cacheRoot,
          expectedSource: { fastaSha256: FASTA_SHA256, gffSha256: GFF_SHA256 },
        })
      ).resolves.toMatchObject({
        status: 'ready',
        publicationId: 'owned-fork',
        sourceGenerationRoot: generationRoot,
      });
      for (const [kind, path] of Object.entries(sourcePaths)) {
        const copied = join(generationRoot, path.slice(fixture.generationRoot.length + 1));
        expect(await readFile(copied)).toEqual(await readFile(path));
        expect((await stat(copied)).ino).not.toBe((await stat(path)).ino);
        const output = forkReceipt.output[kind];
        expect(receiptKind === 'portable' ? output.continuity : output).toEqual(
          await fileIdentity(copied)
        );
      }
      expect(await Promise.all(Object.values(sourcePaths).map(fileIdentity))).toEqual(
        originalIdentities
      );
      expect(await readFile(pointerPath, 'utf8')).toBe(originalPointer);
      expect(await readFile(fixture.receiptPath, 'utf8')).toBe(originalReceipt);
      await expect(
        forkPreparedReferenceSourceGeneration({
          entry: ENTRY,
          sourceGenerationRoot: fixture.generationRoot,
          destinationGenerationRoot: generationRoot,
        })
      ).rejects.toThrow();
    }
  );

  it('rejects stale inherited source receipts before copying their bytes', async () => {
    const fixture = await createSourcePublicationFixture(temporaryRoots);
    const receipt = JSON.parse(await readFile(fixture.receiptPath, 'utf8'));
    receipt.output.fasta.mtimeMs -= 1;
    await writeFile(fixture.receiptPath, JSON.stringify(receipt));
    const destinationGenerationRoot = join(
      fixture.cacheRoot,
      ASSET_CACHE_KEY,
      'generations/stale-fork'
    );
    await mkdir(destinationGenerationRoot);
    await expect(
      forkPreparedReferenceSourceGeneration({
        entry: ENTRY,
        sourceGenerationRoot: fixture.generationRoot,
        destinationGenerationRoot,
      })
    ).rejects.toThrow('inherited reference receipt is stale');
    await expect(
      stat(join(destinationGenerationRoot, 'prepared/puc19/puc19.fa'))
    ).rejects.toThrow();
  });
});

async function createSourcePublicationFixture(temporaryRoots: string[]): Promise<{
  cacheRoot: string;
  publicationId: string;
  generationRoot: string;
  receiptPath: string;
  outputFastaPath: string;
  receipt: Record<string, unknown>;
}> {
  const cacheRoot = await mkdtemp(join(tmpdir(), 'dnaforge-source-publication-'));
  temporaryRoots.push(cacheRoot);
  const publicationId = 'focused-publication';
  const generationRoot = join(cacheRoot, ASSET_CACHE_KEY, 'generations', publicationId);
  const outputRoot = join(generationRoot, 'prepared', 'puc19');
  await mkdir(outputRoot, { recursive: true });

  const outputPaths = {
    fasta: join(outputRoot, 'puc19.fa'),
    fai: join(outputRoot, 'puc19.fa.fai'),
    gff: join(outputRoot, 'puc19.gff3.gz'),
    tbi: join(outputRoot, 'puc19.gff3.gz.tbi'),
  };
  await Promise.all([
    copyFile(join(FIXTURE_ROOT, 'pUC19.fa'), outputPaths.fasta),
    copyFile(join(FIXTURE_ROOT, 'pUC19.fa.fai'), outputPaths.fai),
    copyFile(join(FIXTURE_ROOT, 'pUC19.gff3.gz'), outputPaths.gff),
    copyFile(join(FIXTURE_ROOT, 'pUC19.gff3.gz.tbi'), outputPaths.tbi),
  ]);

  const receipt = {
    contract: 'waypoint-reference-source-materialization-v1',
    chrom: 'puc19',
    indexerVersion: 'focused dna-indexer schema 2',
    source: {
      fasta: { size: 1, mtimeMs: 1, ctimeMs: 1 },
      gff: { size: 1, mtimeMs: 1, ctimeMs: 1 },
    },
    output: {
      fasta: await fileIdentity(outputPaths.fasta),
      fai: await fileIdentity(outputPaths.fai),
      gff: await fileIdentity(outputPaths.gff),
      tbi: await fileIdentity(outputPaths.tbi),
    },
  };
  const receiptPath = join(outputRoot, 'reference-source-materialization.v1.json');
  await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`);
  await writeFile(
    join(generationRoot, PREPARED_REFERENCE_DEFINITION_FILE),
    `${JSON.stringify({
      contract: PREPARED_REFERENCE_DEFINITION_V1,
      pipelineRevision: REFERENCE_PREPARATION_PIPELINE_REVISION,
      id: ENTRY.id,
      name: ENTRY.name,
      organism: ENTRY.organism,
      description: ENTRY.description,
      assetCacheKey: ENTRY.assetCacheKey,
      source: {
        fastaSha256: FASTA_SHA256,
        gffSha256: GFF_SHA256,
      },
      provenance: {
        provider: 'focused test',
        datasetId: 'focused',
        datasetVersion: '1',
      },
      members: [
        {
          chrom: 'puc19',
          displayName: 'pUC19',
          lengthBp: 2_686,
          sourceSeqId: 'puc19',
          manifest: ENTRY.members[0].manifest,
        },
      ],
    })}\n`
  );

  const sourceMaterializationFingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        assetCacheKey: ASSET_CACHE_KEY,
        dnaIndexerSchema: 2,
        receipts: [receipt],
      })
    )
    .digest('hex');
  await writeFile(
    join(cacheRoot, ASSET_CACHE_KEY, 'current-reference-assets.v1.json'),
    `${JSON.stringify({
      contract: 'reference-asset-publication.v1',
      assetCacheKey: ASSET_CACHE_KEY,
      publicationId,
      sourceMaterializationFingerprint,
      publishedAtMs: 1,
    })}\n`
  );
  return {
    cacheRoot,
    publicationId,
    generationRoot,
    receiptPath,
    outputFastaPath: outputPaths.fasta,
    receipt,
  };
}

async function fileIdentity(path: string): Promise<{
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}> {
  const metadata = await stat(path);
  return {
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
    ctimeMs: metadata.ctimeMs,
  };
}

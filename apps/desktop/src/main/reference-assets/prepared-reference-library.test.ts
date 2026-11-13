import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  REFERENCE_ASSET_PUBLICATION_FILE,
  REFERENCE_ASSET_PUBLICATION_V1,
} from '../../features/sequence/reference-asset-publication';
import {
  listPreparedReferenceAssemblyEntries,
  readPreparedReferenceProductRepairInput,
} from './prepared-reference-library';
import {
  PREPARED_REFERENCE_DEFINITION_FILE,
  PREPARED_REFERENCE_DEFINITION_V1,
  PREPARED_REFERENCE_DEFINITION_V2,
  REFERENCE_ASSEMBLY_IDENTITY_V2,
  REFERENCE_PREPARATION_PIPELINE_REVISION,
  REFERENCE_PREPARATION_PIPELINE_REVISION_V2,
  referenceAssemblyIdentitySha256V2,
} from './reference-preparation-manifest';

const temporaryRoots: string[] = [];

async function temporaryCacheRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dnaforge-prepared-library-'));
  temporaryRoots.push(root);
  return root;
}

function validDefinition(assetCacheKey: string, id = assetCacheKey): Record<string, unknown> {
  const chrom = 'plasmid';
  return {
    contract: PREPARED_REFERENCE_DEFINITION_V1,
    pipelineRevision: REFERENCE_PREPARATION_PIPELINE_REVISION,
    id,
    name: 'pUC19',
    organism: 'Synthetic construct',
    description: 'Prepared local reference.',
    assetCacheKey,
    source: {
      fastaSha256: 'a'.repeat(64),
      gffSha256: 'b'.repeat(64),
    },
    provenance: {
      provider: 'Local import',
      datasetId: 'pUC19',
      datasetVersion: '1',
    },
    members: [
      {
        chrom,
        displayName: 'pUC19',
        lengthBp: 2_686,
        role: 'other',
        circular: true,
        sourceSeqId: 'pUC19',
        manifest: {
          fastaPath: `prepared/${chrom}/${chrom}.fa`,
          faiPath: `prepared/${chrom}/${chrom}.fa.fai`,
          gffPath: `prepared/${chrom}/${chrom}.gff3.gz`,
          tbiPath: `prepared/${chrom}/${chrom}.gff3.gz.tbi`,
        },
      },
    ],
  };
}

function validSequenceOnlyDefinitionV2(): Record<string, unknown> {
  const normalizedSequenceSha256 = createHash('sha256').update('ACGT').digest('hex');
  const identityContigs = [
    {
      sourceSeqId: 'contig-1',
      lengthBp: 4,
      circular: false,
      normalizedSequenceSha256,
    },
  ];
  const assemblyIdentitySha256 = referenceAssemblyIdentitySha256V2(identityContigs);
  const id = `local-${assemblyIdentitySha256.slice(0, 24)}`;
  return {
    contract: PREPARED_REFERENCE_DEFINITION_V2,
    pipelineRevision: REFERENCE_PREPARATION_PIPELINE_REVISION_V2,
    id,
    name: 'Sequence only',
    organism: 'Imported reference',
    description: 'Prepared sequence-only local reference.',
    assetCacheKey: id,
    assemblyIdentity: {
      contract: REFERENCE_ASSEMBLY_IDENTITY_V2,
      sha256: assemblyIdentitySha256,
    },
    source: {
      fastaSha256: 'a'.repeat(64),
    },
    provenance: {
      provider: 'Local file import',
      datasetId: id,
      datasetVersion: `sequence-${assemblyIdentitySha256.slice(0, 16)}`,
    },
    members: [
      {
        chrom: 'contig-1',
        displayName: 'contig-1',
        lengthBp: 4,
        circular: false,
        sourceSeqId: 'contig-1',
        normalizedSequenceSha256,
        manifest: {
          fastaPath: 'prepared/contig-1/contig-1.fa',
          faiPath: 'prepared/contig-1/contig-1.fa.fai',
        },
      },
    ],
  };
}

async function writePublishedFamily(input: {
  readonly cacheRoot: string;
  readonly assetCacheKey: string;
  readonly definition?: unknown;
  readonly publicationId?: string;
}): Promise<void> {
  const publicationId = input.publicationId ?? 'published-generation';
  const familyRoot = join(input.cacheRoot, input.assetCacheKey);
  const generationRoot = join(familyRoot, 'generations', publicationId);
  await mkdir(generationRoot, { recursive: true });
  if (input.definition !== undefined) {
    await writeFile(
      join(generationRoot, PREPARED_REFERENCE_DEFINITION_FILE),
      `${JSON.stringify(input.definition)}\n`,
      'utf8'
    );
  }
  await writeFile(
    join(familyRoot, REFERENCE_ASSET_PUBLICATION_FILE),
    `${JSON.stringify({
      contract: REFERENCE_ASSET_PUBLICATION_V1,
      assetCacheKey: input.assetCacheKey,
      publicationId,
      sourceMaterializationFingerprint: 'c'.repeat(64),
      publishedAtMs: 1_753_490_000_000,
    })}\n`,
    'utf8'
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('prepared reference library', () => {
  it('lists a published v2 sequence-only reference without annotation assets', async () => {
    const cacheRoot = await temporaryCacheRoot();
    const definition = validSequenceOnlyDefinitionV2();
    const assetCacheKey = definition.assetCacheKey as string;
    await writePublishedFamily({
      cacheRoot,
      assetCacheKey,
      definition,
    });

    await expect(listPreparedReferenceAssemblyEntries(cacheRoot)).resolves.toEqual([
      expect.objectContaining({
        id: assetCacheKey,
        assetCacheKey,
        name: 'Sequence only',
        members: [
          expect.objectContaining({
            chrom: 'contig-1',
            lengthBp: 4,
            manifest: {
              fastaPath: 'prepared/contig-1/contig-1.fa',
              faiPath: 'prepared/contig-1/contig-1.fa.fai',
            },
          }),
        ],
      }),
    ]);
  });

  it('lists only strict definitions reached through an atomic current pointer', async () => {
    const cacheRoot = await temporaryCacheRoot();
    await writePublishedFamily({
      cacheRoot,
      assetCacheKey: 'puc19-local',
      definition: validDefinition('puc19-local'),
    });

    const unpublishedDefinitionPath = join(
      cacheRoot,
      'draft-reference',
      'generations',
      'unpublished-generation',
      PREPARED_REFERENCE_DEFINITION_FILE
    );
    await mkdir(join(unpublishedDefinitionPath, '..'), { recursive: true });
    await writeFile(
      unpublishedDefinitionPath,
      `${JSON.stringify(validDefinition('draft-reference'))}\n`,
      'utf8'
    );
    await writePublishedFamily({
      cacheRoot,
      assetCacheKey: 'missing-definition',
    });

    const pointerPath = join(cacheRoot, 'puc19-local', REFERENCE_ASSET_PUBLICATION_FILE);
    const pointerBefore = await readFile(pointerPath, 'utf8');
    const entries = await listPreparedReferenceAssemblyEntries(cacheRoot);

    expect(entries).toEqual([
      expect.objectContaining({
        id: 'puc19-local',
        assetCacheKey: 'puc19-local',
        name: 'pUC19',
        members: [
          expect.objectContaining({
            chrom: 'plasmid',
            lengthBp: 2_686,
            manifest: {
              fastaPath: 'prepared/plasmid/plasmid.fa',
              faiPath: 'prepared/plasmid/plasmid.fa.fai',
              gffPath: 'prepared/plasmid/plasmid.gff3.gz',
              tbiPath: 'prepared/plasmid/plasmid.gff3.gz.tbi',
            },
          }),
        ],
      }),
    ]);
    expect(entries[0]).not.toHaveProperty('source');
    expect(entries[0]).not.toHaveProperty('provenance');
    expect(entries[0]?.members[0]).not.toHaveProperty('sourceSeqId');
    await expect(
      readPreparedReferenceProductRepairInput(cacheRoot, 'puc19-local')
    ).resolves.toMatchObject({
      entry: expect.objectContaining({ id: 'puc19-local' }),
      expectedSource: {
        fastaSha256: 'a'.repeat(64),
        gffSha256: 'b'.repeat(64),
      },
    });
    expect(await readFile(pointerPath, 'utf8')).toBe(pointerBefore);
    expect(await readdir(join(cacheRoot, 'draft-reference'))).toEqual(['generations']);
  });

  it('omits malformed, path-escaping, mismatched, and unpublished cache entries', async () => {
    const cacheRoot = await temporaryCacheRoot();
    await writePublishedFamily({
      cacheRoot,
      assetCacheKey: 'valid-family',
      definition: validDefinition('valid-family'),
    });

    const escaped = structuredClone(validDefinition('escaped-path'));
    const escapedMembers = escaped.members as Array<Record<string, unknown>>;
    (escapedMembers[0].manifest as Record<string, unknown>).gffPath =
      '../../outside/reference.gff3.gz';
    await writePublishedFamily({
      cacheRoot,
      assetCacheKey: 'escaped-path',
      definition: escaped,
    });
    await writePublishedFamily({
      cacheRoot,
      assetCacheKey: 'mismatched-family',
      definition: validDefinition('different-family'),
    });
    await writePublishedFamily({
      cacheRoot,
      assetCacheKey: 'unknown-field',
      definition: { ...validDefinition('unknown-field'), sourcePath: '/raw/source.fa' },
    });

    const pointerEscapeRoot = join(cacheRoot, 'pointer-escape');
    await mkdir(join(pointerEscapeRoot, 'generations', 'unpublished'), { recursive: true });
    await writeFile(
      join(pointerEscapeRoot, 'generations', 'unpublished', PREPARED_REFERENCE_DEFINITION_FILE),
      `${JSON.stringify(validDefinition('pointer-escape'))}\n`,
      'utf8'
    );
    await writeFile(
      join(pointerEscapeRoot, REFERENCE_ASSET_PUBLICATION_FILE),
      `${JSON.stringify({
        contract: REFERENCE_ASSET_PUBLICATION_V1,
        assetCacheKey: 'pointer-escape',
        publicationId: '../unpublished',
        sourceMaterializationFingerprint: 'c'.repeat(64),
        publishedAtMs: 1_753_490_000_000,
      })}\n`,
      'utf8'
    );

    await expect(listPreparedReferenceAssemblyEntries(cacheRoot)).resolves.toEqual([
      expect.objectContaining({
        id: 'valid-family',
        assetCacheKey: 'valid-family',
      }),
    ]);
  });

  it('rejects every colliding assembly id instead of selecting by directory order', async () => {
    const cacheRoot = await temporaryCacheRoot();
    await writePublishedFamily({
      cacheRoot,
      assetCacheKey: 'family-a',
      definition: validDefinition('family-a', 'same-id'),
    });
    await writePublishedFamily({
      cacheRoot,
      assetCacheKey: 'family-b',
      definition: validDefinition('family-b', 'same-id'),
    });

    await expect(listPreparedReferenceAssemblyEntries(cacheRoot)).resolves.toEqual([]);
  });
});

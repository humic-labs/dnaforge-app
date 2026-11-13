import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildGenomeAssembly } from '../../features/sequence/reference-catalog';
import {
  assertReferenceSemanticGroupIntegrityV1,
  parsePreparedReferenceDefinition,
  parsePreparedReferenceDefinitionV1,
  parsePreparedReferenceDefinitionV3,
  parseHostedReferencePreparationManifestV2,
  parseReferencePreparationManifestV2,
  parseReferencePreparationManifestV1,
  preparedReferenceAssemblyEntry,
  preparedReferenceDefinition,
  preparedReferenceAssemblyEntryV1,
  preparedReferenceDefinitionV1,
  preparedReferenceDefinitionV3,
  PREPARED_REFERENCE_DEFINITION_V3,
  REFERENCE_ASSEMBLY_IDENTITY_V2,
  REFERENCE_PREPARATION_MANIFEST_V2,
  REFERENCE_PREPARATION_MANIFEST_V1,
  referenceAssemblyIdentitySha256V2,
  referenceSemanticsSha256V1,
} from './reference-preparation-manifest';

const MANIFEST_PATH = '/references/s288c/reference-preparation.json';

function validManifest(): Record<string, unknown> {
  return {
    contract: REFERENCE_PREPARATION_MANIFEST_V1,
    assembly: {
      id: 's288c-mini',
      name: 'S288C mini',
      organism: 'Saccharomyces cerevisiae',
      taxId: 559292,
      accession: 'R64-1-1',
      description: 'Small non-human preparation fixture.',
    },
    sources: {
      fasta: { path: './s288c.fa', sha256: 'b'.repeat(64) },
      annotations: {
        format: 'gff3',
        path: './s288c.gff3.gz',
        sha256: 'c'.repeat(64),
        provider: 'Saccharomyces Genome Database',
        datasetId: 'S288C',
        datasetVersion: 'R64-1-1',
        license: 'public-domain',
      },
    },
    contigs: [
      {
        chrom: 'chrIV',
        sourceSeqId: 'NC_001136.10',
        displayName: 'Chromosome IV',
        lengthBp: 1_531_933,
        role: 'assembled-molecule',
        aliases: { refseq: 'NC_001136.10', ucsc: 'chrIV' },
        circular: false,
      },
    ],
  };
}

function validSequenceOnlyManifestV2(): Record<string, unknown> {
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
  return {
    contract: REFERENCE_PREPARATION_MANIFEST_V2,
    assemblyIdentity: {
      contract: REFERENCE_ASSEMBLY_IDENTITY_V2,
      sha256: assemblyIdentitySha256,
    },
    assembly: {
      id: `local-${assemblyIdentitySha256.slice(0, 24)}`,
      name: 'Sequence only',
      organism: 'Imported reference',
      description: 'Sequence-only preparation fixture.',
    },
    sources: {
      fasta: { path: './sequence.fa', sha256: 'b'.repeat(64) },
    },
    provenance: {
      provider: 'Local file import',
      datasetId: `local-${assemblyIdentitySha256.slice(0, 24)}`,
      datasetVersion: `sequence-${assemblyIdentitySha256.slice(0, 16)}`,
    },
    contigs: [
      {
        chrom: 'contig-1',
        sourceSeqId: 'contig-1',
        displayName: 'contig-1',
        lengthBp: 4,
        circular: false,
        normalizedSequenceSha256,
      },
    ],
  };
}

describe('reference preparation manifest v1', () => {
  it('projects a non-human FASTA+GFF3 manifest onto the ordinary assembly path', () => {
    const loaded = parseReferencePreparationManifestV1(validManifest(), MANIFEST_PATH);

    expect(loaded.entry).toMatchObject({
      id: 's288c-mini',
      assetCacheKey: 's288c-mini',
      taxId: 559292,
      members: [
        {
          chrom: 'chrIV',
          lengthBp: 1_531_933,
          importSource: {
            fastaPath: resolve('/references/s288c/s288c.fa'),
            gffPath: resolve('/references/s288c/s288c.gff3.gz'),
            sourceSeqId: 'NC_001136.10',
          },
          manifest: {
            fastaPath: 'prepared/chrIV/chrIV.fa.gz',
            faiPath: 'prepared/chrIV/chrIV.fa.gz.fai',
            gffPath: 'prepared/chrIV/chrIV.gff3.gz',
            tbiPath: 'prepared/chrIV/chrIV.gff3.gz.tbi',
          },
        },
      ],
    });

    const assembly = buildGenomeAssembly(
      loaded.entry,
      (relativePath) => `/cache/generations/publication/${relativePath}`
    );
    expect(assembly).toMatchObject({
      assemblyId: 's288c-mini',
      taxId: 559292,
      chromosomes: [
        {
          chrom: 'chrIV',
          displayName: 'Chromosome IV',
          length: 1_531_933,
          role: 'assembled-molecule',
          aliases: { refseq: 'NC_001136.10', ucsc: 'chrIV' },
          cytobandId: undefined,
        },
      ],
    });
  });

  it('emits a self-describing prepared definition without raw source paths', () => {
    const loaded = parseReferencePreparationManifestV1(validManifest(), MANIFEST_PATH);
    const definition = preparedReferenceDefinitionV1(loaded, loaded.entry);

    expect(definition.contract).toBe('dnaforge-prepared-reference-definition.v1');
    expect(definition.pipelineRevision).toBe(1);
    expect(definition.members[0]).not.toHaveProperty('importSource');
    expect(definition.members[0]).toMatchObject({
      chrom: 'chrIV',
      sourceSeqId: 'NC_001136.10',
      lengthBp: 1_531_933,
      manifest: {
        fastaPath: 'prepared/chrIV/chrIV.fa.gz',
        gffPath: 'prepared/chrIV/chrIV.gff3.gz',
      },
    });

    const remapped = validManifest();
    (remapped.contigs as Record<string, unknown>[])[0].sourceSeqId = 'different-source-sequence';
    const remappedLoaded = parseReferencePreparationManifestV1(remapped, MANIFEST_PATH);
    expect(preparedReferenceDefinitionV1(remappedLoaded, remappedLoaded.entry)).not.toEqual(
      definition
    );
  });

  it('strictly parses a prepared definition into a sanitized openable entry', () => {
    const loaded = parseReferencePreparationManifestV1(validManifest(), MANIFEST_PATH);
    const serialized = JSON.parse(
      JSON.stringify(preparedReferenceDefinitionV1(loaded, loaded.entry))
    ) as unknown;
    const parsed = parsePreparedReferenceDefinitionV1(serialized, 's288c-mini');
    const entry = preparedReferenceAssemblyEntryV1(parsed);

    expect(entry).toMatchObject({
      id: 's288c-mini',
      assetCacheKey: 's288c-mini',
      name: 'S288C mini',
      members: [
        {
          chrom: 'chrIV',
          lengthBp: 1_531_933,
          manifest: {
            fastaPath: 'prepared/chrIV/chrIV.fa.gz',
            faiPath: 'prepared/chrIV/chrIV.fa.gz.fai',
            gffPath: 'prepared/chrIV/chrIV.gff3.gz',
            tbiPath: 'prepared/chrIV/chrIV.gff3.gz.tbi',
          },
        },
      ],
    });
    expect(entry).not.toHaveProperty('source');
    expect(entry).not.toHaveProperty('provenance');
    expect(entry.members[0]).not.toHaveProperty('sourceSeqId');
    expect(entry.members[0]).not.toHaveProperty('importSource');
  });

  it('carries a hub-derived reference back to its hub as a UCSC catalog target', () => {
    const manifest = validSequenceOnlyManifestV2();
    const assemblyId = (manifest.assembly as { id: string }).id;
    manifest.provenance = {
      provider: 'UCSC GenArk',
      datasetId: 'GCF_000146045.2',
      datasetVersion: 'sequence-0123456789abcdef',
      sourceUrl: 'https://hgdownload.soe.ucsc.edu/hubs/GCF/000/146/045/GCF_000146045.2/hub.txt',
    };
    const loaded = parseReferencePreparationManifestV2(manifest, MANIFEST_PATH);
    const serialized = JSON.parse(
      JSON.stringify(preparedReferenceDefinition(loaded, loaded.entry))
    ) as unknown;
    const entry = preparedReferenceAssemblyEntry(
      parsePreparedReferenceDefinition(serialized, assemblyId)
    );
    expect(entry.ucscTrackTarget).toEqual({
      genomeId: 'GCF_000146045.2',
      hubUrl: 'https://hgdownload.soe.ucsc.edu/hubs/GCF/000/146/045/GCF_000146045.2/hub.txt',
    });
    expect(buildGenomeAssembly(entry, (path) => path).ucscTrackTarget).toEqual(
      entry.ucscTrackTarget
    );

    const local = parseReferencePreparationManifestV2(validSequenceOnlyManifestV2(), MANIFEST_PATH);
    const localEntry = preparedReferenceAssemblyEntry(
      parsePreparedReferenceDefinition(
        JSON.parse(JSON.stringify(preparedReferenceDefinition(local, local.entry))) as unknown,
        assemblyId
      )
    );
    expect(localEntry).not.toHaveProperty('ucscTrackTarget');
    expect(buildGenomeAssembly(localEntry, (path) => path)).not.toHaveProperty('ucscTrackTarget');
  });

  it('requires CSI annotation indexes for contigs longer than the tabix 2^29 limit', () => {
    const loaded = parseReferencePreparationManifestV1(validManifest(), MANIFEST_PATH);
    const definition = JSON.parse(
      JSON.stringify(preparedReferenceDefinitionV1(loaded, loaded.entry))
    ) as Record<string, unknown>;
    const members = definition.members as Array<Record<string, unknown>>;
    members[0].lengthBp = 598_660_471;
    const manifest = members[0].manifest as Record<string, unknown>;
    expect(() => parsePreparedReferenceDefinitionV1(definition, 's288c-mini')).toThrow(
      /gff3\.gz\.csi/
    );
    manifest.tbiPath = 'prepared/chrIV/chrIV.gff3.gz.csi';
    expect(
      parsePreparedReferenceDefinitionV1(definition, 's288c-mini').members[0].manifest.tbiPath
    ).toBe('prepared/chrIV/chrIV.gff3.gz.csi');
  });

  it('rejects unknown fields and non-canonical prepared paths at the cache boundary', () => {
    const loaded = parseReferencePreparationManifestV1(validManifest(), MANIFEST_PATH);
    const definition = JSON.parse(
      JSON.stringify(preparedReferenceDefinitionV1(loaded, loaded.entry))
    ) as Record<string, unknown>;

    expect(() =>
      parsePreparedReferenceDefinitionV1(
        { ...definition, rawFastaPath: '/outside/source.fa' },
        's288c-mini'
      )
    ).toThrow('contains unsupported fields: rawFastaPath');

    const pathEscape = structuredClone(definition);
    const members = pathEscape.members as Array<Record<string, unknown>>;
    const manifest = members[0].manifest as Record<string, unknown>;
    manifest.fastaPath = '../../outside.fa';
    expect(() => parsePreparedReferenceDefinitionV1(pathEscape, 's288c-mini')).toThrow(
      'sequence paths must be prepared/chrIV/chrIV.fa[.gz] with the matching .fai.'
    );

    expect(() => parsePreparedReferenceDefinitionV1(definition, 'another-family')).toThrow(
      'must match cache family "another-family"'
    );
  });

  it('rejects duplicate canonical and source sequence identities before indexing', () => {
    const duplicate = validManifest();
    duplicate.contigs = [
      ...(duplicate.contigs as unknown[]),
      { ...(duplicate.contigs as Record<string, unknown>[])[0] },
    ];
    expect(() => parseReferencePreparationManifestV1(duplicate, MANIFEST_PATH)).toThrow(
      'duplicate contig "chrIV"'
    );

    const traversal = validManifest();
    (traversal.assembly as Record<string, unknown>).id = '../outside';
    expect(() => parseReferencePreparationManifestV1(traversal, MANIFEST_PATH)).toThrow(
      'cannot escape the reference cache'
    );
  });

  it('rejects malformed lengths, roles, aliases, and source digests', () => {
    const invalid = validManifest();
    invalid.contigs = [
      {
        ...(invalid.contigs as Record<string, unknown>[])[0],
        lengthBp: 0,
      },
    ];
    expect(() => parseReferencePreparationManifestV1(invalid, MANIFEST_PATH)).toThrow(
      'lengthBp must be a positive safe integer'
    );

    const invalidDigest = validManifest();
    const sources = invalidDigest.sources as Record<string, Record<string, unknown>>;
    sources.fasta = { path: './s288c.fa', sha256: 'not-a-digest' };
    expect(() => parseReferencePreparationManifestV1(invalidDigest, MANIFEST_PATH)).toThrow(
      'sources.fasta.sha256 has an invalid digest'
    );

    const unverifiedSequenceMd5 = validManifest();
    (unverifiedSequenceMd5.contigs as Record<string, unknown>[])[0].md5 = 'a'.repeat(32);
    expect(() => parseReferencePreparationManifestV1(unverifiedSequenceMd5, MANIFEST_PATH)).toThrow(
      'sequence MD5 verification is not implemented'
    );
  });
});

describe('reference preparation manifest v2', () => {
  it('admits a catalog-bound hosted identity without weakening the local identity rule', () => {
    const hosted = structuredClone(validSequenceOnlyManifestV2());
    (hosted.assembly as Record<string, unknown>).id = 'hosted-fixture';
    (hosted.sources as Record<string, unknown>).annotations = {
      format: 'gff3',
      path: './annotations.gff3.gz',
      sha256: 'c'.repeat(64),
    };

    expect(() => parseReferencePreparationManifestV2(hosted, MANIFEST_PATH)).toThrow(
      /manifest\.assembly\.id/u
    );
    expect(
      parseHostedReferencePreparationManifestV2(hosted, MANIFEST_PATH, {
        expectedCatalogId: 'hosted-fixture',
        expectedFastaSha256: 'b'.repeat(64),
        expectedGffSha256: 'c'.repeat(64),
      }).entry.id
    ).toBe('hosted-fixture');
    expect(() =>
      parseHostedReferencePreparationManifestV2(hosted, MANIFEST_PATH, {
        expectedCatalogId: 'hosted-fixture',
        expectedFastaSha256: 'd'.repeat(64),
        expectedGffSha256: 'c'.repeat(64),
      })
    ).toThrow(/source identity/u);
  });

  it('projects sequence-only input as FASTA/FAI with no fake annotation pair', () => {
    const loaded = parseReferencePreparationManifestV2(
      validSequenceOnlyManifestV2(),
      MANIFEST_PATH
    );

    expect(loaded.source).toEqual({
      fastaPath: resolve('/references/s288c/sequence.fa'),
      fastaSha256: 'b'.repeat(64),
    });
    expect(loaded.entry.members[0]).toMatchObject({
      chrom: 'contig-1',
      importSource: {
        fastaPath: resolve('/references/s288c/sequence.fa'),
        sourceSeqId: 'contig-1',
      },
      manifest: {
        fastaPath: 'prepared/contig-1/contig-1.fa.gz',
        faiPath: 'prepared/contig-1/contig-1.fa.gz.fai',
      },
    });
    expect(loaded.entry.members[0].importSource).not.toHaveProperty('gffPath');
    expect(loaded.entry.members[0].manifest).not.toHaveProperty('gffPath');
    expect(loaded.entry.members[0].manifest).not.toHaveProperty('tbiPath');

    const serialized = preparedReferenceDefinition(loaded, loaded.entry);
    expect(serialized).toMatchObject({
      contract: 'dnaforge-prepared-reference-definition.v2',
      pipelineRevision: 2,
      source: { fastaSha256: 'b'.repeat(64) },
      members: [
        {
          manifest: {
            fastaPath: 'prepared/contig-1/contig-1.fa.gz',
            faiPath: 'prepared/contig-1/contig-1.fa.gz.fai',
          },
        },
      ],
    });
    expect(serialized.source).not.toHaveProperty('gffSha256');
    expect(serialized.members[0].manifest).not.toHaveProperty('gffPath');

    const reparsed = parsePreparedReferenceDefinition(
      JSON.parse(JSON.stringify(serialized)),
      loaded.entry.assetCacheKey
    );
    expect(preparedReferenceAssemblyEntry(reparsed)).toEqual(
      expect.objectContaining({
        id: loaded.entry.id,
        members: [
          expect.objectContaining({
            manifest: {
              fastaPath: 'prepared/contig-1/contig-1.fa.gz',
              faiPath: 'prepared/contig-1/contig-1.fa.gz.fai',
            },
          }),
        ],
      })
    );
  });

  it('makes sequence identity independent of annotation bytes but sensitive to topology', () => {
    const sequenceOnly = validSequenceOnlyManifestV2();
    const annotated = structuredClone(sequenceOnly);
    (annotated.sources as Record<string, unknown>).annotations = {
      format: 'gff3',
      path: './annotations.gff3',
      sha256: 'c'.repeat(64),
    };
    const changedAnnotation = structuredClone(annotated);
    (
      (changedAnnotation.sources as Record<string, unknown>).annotations as Record<string, unknown>
    ).sha256 = 'd'.repeat(64);

    const withoutAnnotations = parseReferencePreparationManifestV2(sequenceOnly, MANIFEST_PATH);
    const withAnnotations = parseReferencePreparationManifestV2(annotated, MANIFEST_PATH);
    const withChangedAnnotations = parseReferencePreparationManifestV2(
      changedAnnotation,
      MANIFEST_PATH
    );
    expect(withAnnotations.entry.id).toBe(withoutAnnotations.entry.id);
    expect(withChangedAnnotations.entry.id).toBe(withoutAnnotations.entry.id);

    const changedTopology = structuredClone(sequenceOnly);
    const contigs = changedTopology.contigs as Array<Record<string, unknown>>;
    contigs[0].circular = true;
    expect(() => parseReferencePreparationManifestV2(changedTopology, MANIFEST_PATH)).toThrow(
      'does not match the ordered contig coordinate identity'
    );
  });

  it('rejects a partial annotation pair in a prepared definition', () => {
    const loaded = parseReferencePreparationManifestV2(
      validSequenceOnlyManifestV2(),
      MANIFEST_PATH
    );
    const definition = JSON.parse(
      JSON.stringify(preparedReferenceDefinition(loaded, loaded.entry))
    ) as Record<string, unknown>;
    const member = (definition.members as Array<Record<string, unknown>>)[0];
    (member.manifest as Record<string, unknown>).gffPath = 'prepared/contig-1/contig-1.gff3.gz';

    expect(() => parsePreparedReferenceDefinition(definition)).toThrow(
      'optional all-or-none GFF3/TBI pair'
    );
  });
});

describe('prepared reference definition v3 semantics', () => {
  it('requires chromosome-arm groups to be exact adjacent pairs', () => {
    const paired = [
      {
        chrom: 'chr2L',
        sourceSeqId: '2L',
        lengthBp: 10,
        moleculeClass: 'chromosome-arm' as const,
        chromosomeGroup: {
          id: 'chr2',
          segmentIndex: 0,
          orientation: 'telomere-to-centromere' as const,
        },
        properties: [],
        features: [],
        morphology: { kind: 'between-members' as const, groupId: 'chr2', side: 'right' as const },
        diagnostics: [],
      },
      {
        chrom: 'chr2R',
        sourceSeqId: '2R',
        lengthBp: 12,
        moleculeClass: 'chromosome-arm' as const,
        chromosomeGroup: {
          id: 'chr2',
          segmentIndex: 1,
          orientation: 'centromere-to-telomere' as const,
        },
        properties: [],
        features: [],
        morphology: { kind: 'between-members' as const, groupId: 'chr2', side: 'left' as const },
        diagnostics: [],
      },
    ];

    expect(() => assertReferenceSemanticGroupIntegrityV1(paired)).not.toThrow();
    expect(() => assertReferenceSemanticGroupIntegrityV1(paired.slice(0, 1))).toThrow(
      /complete adjacent pair/i
    );
    expect(() =>
      assertReferenceSemanticGroupIntegrityV1([
        paired[0],
        { ...paired[1], chromosomeGroup: { ...paired[1].chromosomeGroup, segmentIndex: 2 } },
      ])
    ).toThrow(/complete adjacent pair/i);
  });

  it('embeds, digests, strictly reparses, and projects provider-neutral morphology', () => {
    const loaded = parseReferencePreparationManifestV2(
      validSequenceOnlyManifestV2(),
      MANIFEST_PATH
    );
    const v2 = preparedReferenceDefinition(loaded, loaded.entry);
    if (v2.contract !== 'dnaforge-prepared-reference-definition.v2') {
      throw new Error('Expected v2 definition fixture');
    }
    const semantics = {
      contract: 'dnaforge-reference-semantics.v1' as const,
      assemblyIdentitySha256: v2.assemblyIdentity.sha256,
      vocabularyRevision: 1 as const,
      adjudicationRevision: 1 as const,
      evidence: [
        {
          id: 'fixture-reviewed-disposition',
          kind: 'reviewed-assertion' as const,
          provider: 'Fixture authority',
          assemblyAccession: 'fixture-v1',
          sourceUrl: 'https://example.test/reference/fixture-v1',
          adapterContract: 'fixture-adapter.v1',
        },
      ],
      members: [
        {
          chrom: 'contig-1',
          sourceSeqId: 'contig-1',
          lengthBp: 4,
          moleculeClass: 'generic-contig' as const,
          properties: [],
          features: [],
          morphology: {
            kind: 'generic-contig' as const,
            reason: 'unsupported-architecture' as const,
          },
          diagnostics: [],
        },
      ],
    };

    const first = preparedReferenceDefinitionV3(v2, semantics);
    const second = preparedReferenceDefinitionV3(v2, structuredClone(semantics));
    expect(first.contract).toBe(PREPARED_REFERENCE_DEFINITION_V3);
    expect(first.semanticDigestSha256).toBe(second.semanticDigestSha256);

    const parsed = parsePreparedReferenceDefinitionV3(
      JSON.parse(JSON.stringify(first)),
      v2.assetCacheKey
    );
    expect(preparedReferenceAssemblyEntry(parsed).members[0].morphology).toEqual({
      kind: 'generic-contig',
      reason: 'unsupported-architecture',
    });

    const schematicDefinition = preparedReferenceDefinitionV3(v2, {
      ...semantics,
      members: [
        {
          ...semantics.members[0],
          moleculeClass: 'whole-chromosome' as const,
          properties: [
            {
              type: 'centromere-architecture' as const,
              value: 'localized' as const,
              evidenceIds: ['fixture-reviewed-disposition'],
            },
          ],
          morphology: {
            kind: 'schematic' as const,
            centromereClass: 'acrocentric' as const,
            shortArmAt: 'start' as const,
          },
        },
      ],
    });
    const parsedSchematic = parsePreparedReferenceDefinitionV3(
      JSON.parse(JSON.stringify(schematicDefinition)),
      v2.assetCacheKey
    );
    expect(preparedReferenceAssemblyEntry(parsedSchematic).members[0].morphology).toEqual({
      kind: 'schematic',
      centromereClass: 'acrocentric',
      shortArmAt: 'start',
    });

    const unresolvedSemantics = {
      ...schematicDefinition.semantics,
      members: [
        {
          ...schematicDefinition.semantics.members[0],
          features: [],
          morphology: { kind: 'unlocalized-centromere' as const },
        },
      ],
    };
    const unresolvedDefinition = {
      ...schematicDefinition,
      semantics: unresolvedSemantics,
      semanticDigestSha256: referenceSemanticsSha256V1(unresolvedSemantics as never),
    };
    const parsedUnresolved = parsePreparedReferenceDefinitionV3(
      JSON.parse(JSON.stringify(unresolvedDefinition)),
      v2.assetCacheKey
    );
    expect(preparedReferenceAssemblyEntry(parsedUnresolved).members[0].morphology).toEqual({
      kind: 'unlocalized-centromere',
    });

    const boundaryDefinition = preparedReferenceDefinitionV3(v2, {
      ...semantics,
      members: [
        {
          ...semantics.members[0],
          moleculeClass: 'whole-chromosome' as const,
          properties: [
            {
              type: 'centromere-architecture' as const,
              value: 'localized' as const,
              evidenceIds: ['fixture-reviewed-disposition'],
            },
          ],
          features: [
            {
              type: 'centromere-boundary' as const,
              positionBp: 2,
              topology: 'internal' as const,
              evidenceIds: ['fixture-reviewed-disposition'],
            },
          ],
          morphology: {
            kind: 'localized-boundary' as const,
            positionBp: 2,
            topology: 'internal' as const,
          },
        },
      ],
    });
    const parsedBoundary = parsePreparedReferenceDefinitionV3(
      JSON.parse(JSON.stringify(boundaryDefinition)),
      v2.assetCacheKey
    );
    expect(preparedReferenceAssemblyEntry(parsedBoundary).members[0].morphology).toEqual({
      kind: 'localized-boundary',
      positionBp: 2,
      topology: 'internal',
    });

    const positionalSchematic = {
      ...schematicDefinition,
      semantics: {
        ...schematicDefinition.semantics,
        members: [
          {
            ...schematicDefinition.semantics.members[0],
            features: [
              {
                type: 'centromere-region' as const,
                interval: { startBp: 1, endBp: 2 },
                topology: 'internal' as const,
                evidenceIds: ['fixture-reviewed-disposition'],
              },
            ],
          },
        ],
      },
    };
    expect(() =>
      parsePreparedReferenceDefinitionV3(
        JSON.parse(JSON.stringify(positionalSchematic)),
        v2.assetCacheKey
      )
    ).toThrow(/schematic morphology must remain non-positional/i);

    const contradictorySchematic = {
      ...schematicDefinition,
      semantics: {
        ...schematicDefinition.semantics,
        members: [
          {
            ...schematicDefinition.semantics.members[0],
            properties: [
              ...schematicDefinition.semantics.members[0].properties,
              {
                type: 'centromere-architecture' as const,
                value: 'holocentric' as const,
                evidenceIds: ['fixture-reviewed-disposition'],
              },
            ],
          },
        ],
      },
    };
    expect(() =>
      parsePreparedReferenceDefinitionV3(
        JSON.parse(JSON.stringify(contradictorySchematic)),
        v2.assetCacheKey
      )
    ).toThrow(/requires exactly one localized architecture value/i);

    const changed = structuredClone(semantics);
    changed.evidence[0].adapterContract = 'fixture-adapter.v2';
    expect(preparedReferenceDefinitionV3(v2, changed).semanticDigestSha256).not.toBe(
      first.semanticDigestSha256
    );
  });

  it('rejects missing, stale, misbound, and open-ended semantic payloads', () => {
    const loaded = parseReferencePreparationManifestV2(
      validSequenceOnlyManifestV2(),
      MANIFEST_PATH
    );
    const v2 = preparedReferenceDefinition(loaded, loaded.entry);
    if (v2.contract !== 'dnaforge-prepared-reference-definition.v2') {
      throw new Error('Expected v2 definition fixture');
    }
    const base = {
      ...v2,
      contract: PREPARED_REFERENCE_DEFINITION_V3,
      pipelineRevision: 3,
      semanticDigestSha256: 'd'.repeat(64),
    } as Record<string, unknown>;
    expect(() => parsePreparedReferenceDefinitionV3(base)).toThrow(/semantics/i);

    const valid = preparedReferenceDefinitionV3(v2, {
      contract: 'dnaforge-reference-semantics.v1',
      assemblyIdentitySha256: v2.assemblyIdentity.sha256,
      vocabularyRevision: 1,
      adjudicationRevision: 1,
      evidence: [],
      members: [
        {
          chrom: 'contig-1',
          sourceSeqId: 'contig-1',
          lengthBp: 4,
          moleculeClass: 'generic-contig',
          properties: [],
          features: [],
          morphology: { kind: 'generic-contig', reason: 'missing-semantics' },
          diagnostics: [],
        },
      ],
    });

    const staleIdentity = structuredClone(valid) as unknown as Record<string, unknown>;
    (staleIdentity.semantics as Record<string, unknown>).assemblyIdentitySha256 = 'f'.repeat(64);
    expect(() => parsePreparedReferenceDefinitionV3(staleIdentity)).toThrow(/assembly identity/i);

    const misbound = structuredClone(valid) as unknown as Record<string, unknown>;
    const semanticMember = (
      (misbound.semantics as Record<string, unknown>).members as Array<Record<string, unknown>>
    )[0];
    semanticMember.sourceSeqId = 'another-contig';
    expect(() => parsePreparedReferenceDefinitionV3(misbound)).toThrow(/member binding/i);

    const openEnded = structuredClone(valid) as unknown as Record<string, unknown>;
    const morphology = (
      (openEnded.semantics as Record<string, unknown>).members as Array<Record<string, unknown>>
    )[0].morphology as Record<string, unknown>;
    morphology.kind = 'provider-specific-shape';
    expect(() => parsePreparedReferenceDefinitionV3(openEnded)).toThrow(/morphology/i);
  });
});

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  buildPartitionedTranscriptScene,
  buildPrepackedAnnotationInteractionIndexV2,
  packGpuReadyPartitionedTranscriptSceneBinaryV4,
  resealPartitionedTranscriptSceneBinaryDatasetContractV4,
  unpackPartitionedTranscriptSceneBinaryV4,
  validatePartitionedTranscriptSceneBinaryV4,
  type AnnotationScenePrimitiveV1,
} from '@waypoint/genome-renderer/pure';

import {
  assertPortableCatalogThemeRosterCoherence,
  assertPortableFullThemeProductCoherence,
  assertPortableSearchResultIdentity,
  portableAssetGenerationsByThemeV1,
  portableDatasetContractMatches,
  portableProductDatasetVersionV1,
  portableCompilerSemanticsIsAdmitted,
} from './portable-prepared-reference-view-authority';

describe('portable prepared-reference dataset admission', () => {
  it('admits and preserves renderable transcript geometry after machine-local source identity changes', async () => {
    const publishedDataset = {
      datasetId: 'waypoint:assembly-annotation:sacCer3',
      datasetVersion: 'resolved-annotation-v3:mapped-track-input.v1',
      sourceSha256: 'a'.repeat(64),
    };
    const installedDataset = {
      ...publishedDataset,
      sourceSha256: 'b'.repeat(64),
    };
    const primitive: AnnotationScenePrimitiveV1 = {
      startBp: 100,
      endBp: 200,
      featureIndex: 0,
      offsetCenter: -7,
      halfH: 7,
      color: 0x123456,
      alpha: 0.85,
      cdsFade: 0.85,
      dirSign: 1,
    };
    const scene = buildPartitionedTranscriptScene([primitive], 1_000);
    const interactionIndex = buildPrepackedAnnotationInteractionIndexV2(
      [
        {
          rendererId: 1,
          startBp: 100,
          endBp: 200,
          lane: 0,
          direction: 'forward',
          displayName: 'YAL001C',
          type: 'mRNA',
          transcriptId: 'YAL001C_mRNA',
          sourceId: 'YAL001C',
          canonicalIdentity: 'sacCer3|mRNA|YAL001C',
        },
      ],
      scene.sortedPrimitives
    );
    const packed = await packGpuReadyPartitionedTranscriptSceneBinaryV4({
      datasetContract: publishedDataset,
      assemblyContract: { assemblyId: 'sacCer3', assemblyLengthBp: 12_157_105 },
      families: [{ id: 'transcript-glyph-v2', kind: 'transcript', metadata: {} }],
      featureFamilyIndices: new Uint32Array([0]),
      scene,
      interactionIndex,
      policyProjection: {
        features: [
          {
            annotationType: 'mRNA',
            expandedLane: 0,
            expandedTrackLane: 0,
            canonicalLane: 0,
            canonicalTrackLane: 0,
          },
        ],
        expandedBandOrder: ['mRNA'],
        canonicalBandOrder: ['mRNA'],
      },
    });

    expect(portableDatasetContractMatches(installedDataset, publishedDataset)).toBe(true);
    const localManifest = await resealPartitionedTranscriptSceneBinaryDatasetContractV4(
      packed.manifest,
      installedDataset
    );
    await expect(
      validatePartitionedTranscriptSceneBinaryV4(localManifest, packed.payload)
    ).resolves.toBeDefined();
    const decoded = await unpackPartitionedTranscriptSceneBinaryV4(localManifest, packed.payload);

    expect(decoded.interactionIndex.featureCount).toBe(1);
    expect(Array.from(decoded.scene.featureIndices)).toEqual([0]);
    expect(decoded.scene.partitions).toEqual([expect.objectContaining({ instanceCount: 1 })]);
    expect(decoded.submissionBank.expanded.packedInstanceData.length).toBeGreaterThan(0);
    expect(decoded.submissionBank.canonical.packedInstanceData.length).toBeGreaterThan(0);
  });

  it('still rejects a different dataset or compiler-visible dataset version', () => {
    const installed = {
      datasetId: 'waypoint:assembly-annotation:sacCer3',
      datasetVersion: 'resolved-annotation-v3:mapped-track-input.v1',
      sourceSha256: 'a'.repeat(64),
    };

    expect(
      portableDatasetContractMatches(installed, {
        ...installed,
        datasetId: 'waypoint:assembly-annotation:GRCh38',
      })
    ).toBe(false);
    expect(
      portableDatasetContractMatches(installed, {
        ...installed,
        datasetVersion: 'resolved-annotation-v4:mapped-track-input.v2',
      })
    ).toBe(false);
  });
});

describe('portable prepared-reference full admission', () => {
  it('admits legacy search semantics only through an explicit compatibility receipt', () => {
    expect(portableCompilerSemanticsIsAdmitted('current', 'current', 'legacy', false)).toBe(true);
    expect(portableCompilerSemanticsIsAdmitted('legacy', 'current', 'legacy', false)).toBe(false);
    expect(portableCompilerSemanticsIsAdmitted('legacy', 'current', 'legacy', true)).toBe(true);
    expect(portableCompilerSemanticsIsAdmitted('arbitrary', 'current', 'legacy', true)).toBe(false);
  });

  it('admits indexes published under an earlier track identity without an opt-in', () => {
    expect(
      portableCompilerSemanticsIsAdmitted('older', 'current', 'legacy', false, [
        'previous',
        'older',
      ])
    ).toBe(true);
    expect(
      portableCompilerSemanticsIsAdmitted('legacy', 'current', 'legacy', false, ['previous'])
    ).toBe(false);
    expect(
      portableCompilerSemanticsIsAdmitted('arbitrary', 'current', 'legacy', true, ['previous'])
    ).toBe(false);
  });

  it('binds every portable search identity to the visual or transcript-internal roster', () => {
    const allowed = new Set(['mRNA', 'CDS']);
    const identity = (trackId: string) => ({
      annotationTrackId: trackId,
      canonicalIdentity: JSON.stringify([
        'annotation.v2',
        'genome',
        'source',
        'transcript',
        trackId,
        'mRNA',
        10,
        20,
        'forward',
      ]),
    });

    expect(() => assertPortableSearchResultIdentity(identity('mRNA'), allowed)).not.toThrow();
    expect(() => assertPortableSearchResultIdentity(identity('CDS'), allowed)).not.toThrow();
    expect(() => assertPortableSearchResultIdentity(identity('enhancer'), allowed)).toThrow(
      'not owned by the admitted annotation roster'
    );
    expect(() =>
      assertPortableSearchResultIdentity(
        {
          annotationTrackId: 'mRNA',
          canonicalIdentity: JSON.stringify([
            'annotation.v2',
            'genome',
            'source',
            'transcript',
            'lncRNA',
            'mRNA',
            10,
            20,
            'forward',
          ]),
        },
        allowed
      )
    ).toThrow('not owned by the admitted annotation roster');
  });

  it('rejects a staged catalog before admission when a theme or placement identity diverges', () => {
    const entry = (themeMode: 'dark' | 'light', trackType = 'mRNA') => ({
      themeMode,
      trackType,
      placementFingerprint: `ap1:${'1'.repeat(24)}`,
      sceneContractSha256: 'a'.repeat(64),
    });
    expect(() =>
      assertPortableCatalogThemeRosterCoherence({ entries: [entry('light')] })
    ).not.toThrow();
    expect(() => assertPortableCatalogThemeRosterCoherence({ entries: [entry('dark')] })).toThrow(
      'catalog theme track rosters do not match'
    );
    expect(() =>
      assertPortableCatalogThemeRosterCoherence({
        entries: [entry('light'), entry('dark'), entry('dark', 'lnc_RNA')],
      })
    ).toThrow('catalog theme track rosters do not match');
    expect(() =>
      assertPortableCatalogThemeRosterCoherence({
        entries: [
          {
            themeMode: 'light',
            trackType: 'mRNA',
            placementFingerprint: `ap1:${'1'.repeat(24)}`,
            sceneContractSha256: 'a'.repeat(64),
          },
          {
            themeMode: 'dark',
            trackType: 'mRNA',
            placementFingerprint: `ap1:${'2'.repeat(24)}`,
            sceneContractSha256: 'a'.repeat(64),
          },
        ],
      })
    ).toThrow('catalog placements do not match');
  });

  it('rejects a catalog where dark and light bind different interaction authorities', () => {
    const shared = {
      trackType: 'mRNA',
      placementFingerprint: `ap1:${'1'.repeat(24)}`,
      sceneContractSha256: 'a'.repeat(64),
      compiledBroadInteractionPayloadObjectId: 'compact-mRNA',
    };
    expect(() =>
      assertPortableCatalogThemeRosterCoherence({
        entries: [
          {
            ...shared,
            themeMode: 'light',
            compiledBroadInteractionPayloadSha256: 'b'.repeat(64),
          },
          {
            ...shared,
            themeMode: 'dark',
            compiledBroadInteractionPayloadSha256: 'c'.repeat(64),
          },
        ],
      })
    ).toThrow('theme interaction authorities do not match for mRNA');
  });

  it('admits a light-only product family without a dark generation', () => {
    const fixture = fullThemeProductFixture();
    const lightOnlyProducts = new Map(
      [...fixture.productsByTheme].filter(([theme]) => theme === 'light')
    );
    const lightOnlyCatalog = {
      entries: fixture.catalog.entries.filter((entry) => entry.themeMode === 'light'),
    } as Parameters<typeof assertPortableFullThemeProductCoherence>[0];
    expect(() =>
      assertPortableFullThemeProductCoherence(lightOnlyCatalog, lightOnlyProducts)
    ).not.toThrow();
    expect(portableProductDatasetVersionV1(lightOnlyProducts)).toBe(
      'resolved-annotation-v3:mapped-track-input.v1'
    );
    const generations = portableAssetGenerationsByThemeV1(lightOnlyProducts);
    expect(generations.light.themeMode).toBe('light');
    expect('dark' in generations).toBe(false);
    expect(() =>
      assertPortableFullThemeProductCoherence(lightOnlyCatalog, fixture.productsByTheme)
    ).toThrow('theme track rosters do not match');
  });

  it('admits only one exact light/dark product identity and complete catalog roster', () => {
    const fixture = fullThemeProductFixture();

    expect(() =>
      assertPortableFullThemeProductCoherence(fixture.catalog, fixture.productsByTheme)
    ).not.toThrow();
    expect(portableProductDatasetVersionV1(fixture.productsByTheme)).toBe(
      'resolved-annotation-v3:mapped-track-input.v1'
    );
    expect(portableAssetGenerationsByThemeV1(fixture.productsByTheme)).toEqual({
      light: {
        contract: 'assembly-reference-asset-generation.v1',
        sourceFingerprint: 'c'.repeat(24),
        inventoryFingerprint: 'd'.repeat(64),
        themeMode: 'light',
      },
      dark: {
        contract: 'assembly-reference-asset-generation.v1',
        sourceFingerprint: 'c'.repeat(24),
        inventoryFingerprint: 'e'.repeat(64),
        themeMode: 'dark',
      },
    });
  });

  it('rejects a dark product built from a different dataset contract', () => {
    const fixture = fullThemeProductFixture();
    const productsByTheme = new Map(fixture.productsByTheme);
    const dark = productsByTheme.get('dark')!;
    productsByTheme.set('dark', {
      ...dark,
      datasetContract: {
        ...dark.datasetContract,
        sourceSha256: 'b'.repeat(64),
      },
    });

    expect(() => assertPortableFullThemeProductCoherence(fixture.catalog, productsByTheme)).toThrow(
      'theme dataset contracts do not match'
    );
  });

  it('rejects a dark product whose ordered track roster differs from its catalog', () => {
    const fixture = fullThemeProductFixture();
    const productsByTheme = new Map(fixture.productsByTheme);
    const dark = productsByTheme.get('dark')!;
    productsByTheme.set('dark', {
      ...dark,
      trackTypes: ['enhancer', 'protein_coding_gene'],
    });

    expect(() => assertPortableFullThemeProductCoherence(fixture.catalog, productsByTheme)).toThrow(
      'theme track rosters do not match'
    );
  });
});

function fullThemeProductFixture() {
  const datasetContract = {
    datasetId: 'waypoint:assembly-annotation:sacCer3',
    datasetVersion: 'resolved-annotation-v3:mapped-track-input.v1',
    sourceSha256: 'a'.repeat(64),
  };
  const scope = {
    kind: 'complete-assembly' as const,
    placements: [{ chrom: 'chrI', length: 100, annotationCoverage: 'sourced' as const }],
  };
  const placementFingerprint = `ap1:${createHash('sha256')
    .update(
      ['placement:ordered-linear-assembly-placement-v1', 'total:100', '0|chrI|0|100|100'].join('\n')
    )
    .digest('hex')
    .slice(0, 24)}`;
  const trackTypes: readonly string[] = ['enhancer', 'mRNA'];
  const productsByTheme = new Map([
    [
      'light',
      {
        sourceFingerprint: 'c'.repeat(24),
        inventoryFingerprint: 'd'.repeat(64),
        datasetContract,
        scope,
        trackTypes,
      },
    ] as const,
    [
      'dark',
      {
        sourceFingerprint: 'c'.repeat(24),
        inventoryFingerprint: 'e'.repeat(64),
        datasetContract,
        scope,
        trackTypes,
      },
    ] as const,
  ]);
  const catalog = {
    entries: (['dark', 'light'] as const).flatMap((themeMode) =>
      trackTypes.map((trackType) => ({
        themeMode,
        trackType,
        placementFingerprint,
        sceneContractSha256: 'f'.repeat(64),
      }))
    ),
  };
  return { catalog, productsByTheme };
}

import type { IndexedGenomeManifest, ResolvedTranscript } from '@waypoint/genome-data';
import {
  annotationCanonicalIdentityV2,
  type AnnotationPresentationPage,
  type Feature,
} from '@waypoint/genome-renderer/pure';
import { beforeAll, describe, expect, it } from 'vitest';

import { buildAnnotationIndex } from '../genome-annotation-index';

type SearchIdentityModule = typeof import('./indexed-genome-annotation-search-identity');
type LegacyAdapterModule = typeof import('./indexed-genome-legacy-adapter');
type SceneStateModule = typeof import('./indexed-genome-viewer-scene-state');
type GlyphMapperModule = typeof import('../../../shared/indexed-genome-annotation-feature-mapper');

let searchIdentity: SearchIdentityModule;
let legacyAdapter: LegacyAdapterModule;
let sceneState: SceneStateModule;
let glyphMapper: GlyphMapperModule;

beforeAll(async () => {
  HTMLCanvasElement.prototype.getContext = (() => ({
    fillRect: () => undefined,
    globalCompositeOperation: 'source-over',
    getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }),
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  [searchIdentity, legacyAdapter, sceneState, glyphMapper] = await Promise.all([
    import('./indexed-genome-annotation-search-identity'),
    import('./indexed-genome-legacy-adapter'),
    import('./indexed-genome-viewer-scene-state'),
    import('../../../shared/indexed-genome-annotation-feature-mapper'),
  ]);
});

const MANIFEST: IndexedGenomeManifest = {
  chrom: 'chr11',
  fastaPath: '/indexed/chr11.fa',
  faiPath: '/indexed/chr11.fa.fai',
  gffPath: '/indexed/chr11.gff3.gz',
  tbiPath: '/indexed/chr11.gff3.gz.tbi',
  length: 135_086_622,
};

describe('single-chromosome annotation search renderer identity', () => {
  it('matches the renderer for a subclassed lncRNA with child-widened bounds', () => {
    const transcript: ResolvedTranscript = {
      chrom: 'chr11',
      source: 'RefSeq',
      type: 'ncRNA',
      start: 200,
      end: 300,
      score: null,
      strand: '-',
      phase: null,
      attributes: {
        ID: ['rna-NR_131224.2'],
        Name: ['NR_131224.2'],
        ncRNA_class: ['lncRNA'],
      },
      raw: '',
      fileOffset: 42,
      transcriptId: 'rna-NR_131224.2',
      exons: [{ start: 196, end: 301 }],
      cds: [],
    };
    const carrier = legacyAdapter.transcriptCarrierFeatureForRendererIdentity(transcript);
    const genomeIdentity = sceneState.sourceFingerprintForManifest(MANIFEST);
    const searchFeature = searchIdentity.materializeSingleChromosomeAnnotationSearchFeature(
      carrier,
      genomeIdentity
    );
    const rendered = legacyAdapter.applyDensityControls(
      [carrier],
      MANIFEST.chrom,
      MANIFEST.length!,
      new Set(['lncRNA']),
      null
    );
    const [glyph] = legacyAdapter.annotationGlyphPayloadFromRendererFeatures(rendered).glyphs;
    if (!glyph) throw new Error('renderer identity fixture did not produce a glyph');
    const rendererFeature = glyphMapper.rendererFeatureCandidateFromAnnotationGlyph({
      genomeIdentity,
      genomeName: MANIFEST.chrom,
      color: 0,
      glyph,
    });

    expect(glyph).toMatchObject({
      type: 'ncRNA',
      trackId: 'lncRNA',
      startBp: 195,
      endBp: 301,
    });
    expect(searchFeature).toMatchObject({
      type: 'ncRNA',
      annotationTrackId: 'lncRNA',
      direction: 'reverse',
      start: 195,
      end: 301,
      canonicalIdentity: rendererFeature.canonicalIdentity,
    });
    expect(buildAnnotationIndex([searchFeature]).query('NR_131224.2')).toEqual([
      expect.objectContaining({
        featureIndex: 0,
        featureType: 'ncRNA',
        annotationTrackId: 'lncRNA',
        direction: 'reverse',
        start: 195,
        end: 301,
        canonicalIdentity: rendererFeature.canonicalIdentity,
      }),
    ]);
    expect(
      searchIdentity.resolveSingleChromosomeAnnotationSearchFocusCarrier({
        features: [carrier],
        featureIndex: 0,
        genomeIdentity,
        focus: {
          trackId: 'lncRNA',
          canonicalIdentity: rendererFeature.canonicalIdentity!,
        },
      })
    ).toBe(carrier);
    expect(
      searchIdentity.resolveSingleChromosomeAnnotationSearchFocusCarrier({
        features: [carrier],
        featureIndex: 0,
        genomeIdentity,
        focus: {
          trackId: 'mRNA',
          canonicalIdentity: rendererFeature.canonicalIdentity!,
        },
      })
    ).toBeNull();
    expect(
      searchIdentity.resolveSingleChromosomeAnnotationSearchFocusCarrier({
        features: [carrier],
        featureIndex: 0,
        genomeIdentity,
        focus: {
          trackId: 'lncRNA',
          canonicalIdentity: `${rendererFeature.canonicalIdentity}:stale`,
        },
      })
    ).toBeNull();
    expect(
      searchIdentity.resolveSingleChromosomeAnnotationSearchFocusCarrier({
        features: [carrier],
        featureIndex: 1,
        genomeIdentity,
        focus: {
          trackId: 'lncRNA',
          canonicalIdentity: rendererFeature.canonicalIdentity!,
        },
      })
    ).toBeNull();
  });

  it('resolves one exact assembly page carrier and fails closed on ambiguity', () => {
    const genomeIdentity = `assembly-annotation-source-sha256.v1:${'a'.repeat(64)}`;
    const focus: Feature = {
      id: 11,
      type: 'ncRNA',
      annotationTrackId: 'lncRNA',
      annotationTrackLane: 0,
      annotationTrackLaneCapacity: 1,
      start: 369_302_556,
      end: 369_308_225,
      direction: 'forward',
      displayName: 'NR_131224.2',
      color: 0,
      lane: 7,
    };
    const canonicalIdentity = annotationCanonicalIdentityV2({
      genomeIdentity,
      sourceId: focus.id.toString(36),
      transcriptId: focus.transcriptId ?? null,
      trackId: focus.annotationTrackId!,
      type: focus.type,
      startBp: focus.start,
      endBp: focus.end,
      direction: focus.direction,
    });
    const page = (pageKey: string, features: Feature[]): AnnotationPresentationPage => ({
      contract: 'annotation-presentation-page.v1',
      pageKey,
      chromosomeId: 'chr11',
      trackId: 'lncRNA',
      trackOrder: 2,
      laneCapacity: 1,
      ownerStartBp: 369_000_000,
      ownerEndBp: 369_524_288,
      maxFeatureEndBp: 369_524_288,
      contentRevision: `${pageKey}:revision`,
      features,
    });

    expect(
      searchIdentity.resolveAssemblyAnnotationSearchFocusFeature({
        pages: [page('owner', [focus])],
        genomeIdentity,
        focus: {
          trackId: 'lncRNA',
          canonicalIdentity,
        },
      })
    ).toMatchObject({ ...focus, canonicalIdentity });
    expect(
      searchIdentity.resolveAssemblyAnnotationSearchFocusFeature({
        pages: [page('owner-a', [focus]), page('owner-b', [{ ...focus }])],
        genomeIdentity,
        focus: {
          trackId: 'lncRNA',
          canonicalIdentity,
        },
      })
    ).toBeNull();
    expect(
      searchIdentity.resolveAssemblyAnnotationSearchFocusFeature({
        pages: [page('owner-a', [focus]), page('owner-b', [focus])],
        genomeIdentity,
        focus: {
          trackId: 'lncRNA',
          canonicalIdentity,
        },
      })
    ).toBeNull();
    expect(
      searchIdentity.resolveAssemblyAnnotationSearchFocusFeature({
        pages: [page('owner', [focus])],
        genomeIdentity: `assembly-annotation-source-sha256.v1:${'b'.repeat(64)}`,
        focus: { trackId: 'lncRNA', canonicalIdentity },
      })
    ).toBeNull();
    expect(
      searchIdentity.resolveAssemblyAnnotationSearchFocusFeature({
        pages: [page('owner', [focus])],
        genomeIdentity,
        focus: { trackId: 'mRNA', canonicalIdentity },
      })
    ).toBeNull();
    expect(
      searchIdentity.resolveAssemblyAnnotationSearchFocusFeature({
        pages: [page('owner', [focus])],
        genomeIdentity,
        focus: { trackId: 'lncRNA', canonicalIdentity: `${canonicalIdentity}:stale` },
      })
    ).toBeNull();
    expect(
      searchIdentity.resolveAssemblyAnnotationSearchFocusFeature({
        pages: [],
        genomeIdentity,
        focus: { trackId: 'lncRNA', canonicalIdentity },
      })
    ).toBeNull();
  });
});

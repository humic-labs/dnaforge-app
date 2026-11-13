// @vitest-environment jsdom

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Application, Container } from 'pixi.js';
import type {
  AnnotationPresentationSnapshot,
  AnnotationResidentPagePublication,
  Feature,
  Genome,
  RenderState,
} from '../../types';
import { IndexedPixiLinearRenderer } from './indexed-linear-renderer';

const SOURCE = 'grch38-source-v1';
const LENGTH = 3_088_269_832;
const GRCH38_CHR11_OFFSET_BP = 1_808_681_051;

const GRCH38_HBB_CDS_SEGMENTS = [
  {
    startBp: 5_225_597,
    bases:
      'TTAGTGATACTTGTGGGCCAGGGCATTAGCCACACCAGCCACCACTTTCTGATAGGCAGCCTGCACTGGTGGGGTGAATTCTTTGCCAAAGTGATGGGCCAGCACACAGACCAGCACGTTGCCCAGGAG',
  },
  {
    startBp: 5_226_576,
    bases:
      'CCTGAAGTTCTCAGGATCCACGTGCAGCTTGTCACAGTGCAGCTCACTCAGTGTGGCAAAGGTGCCCTTGAGGTTGTCCAGGTGAGCCAGGCCATCACTAAAGGCACCGAGCACTTTCTTGCCATGAGCCTTCACCTTAGGGTTGCCCATAACAGCATCAGGAGTGGACAGATCCCCAAAGGACTCAAAGAACCTCTGGGTCCAAGGGTAGACCACCAGCAGC',
  },
  {
    startBp: 5_226_929,
    bases:
      'CTGCCCAGGGCCTCACCACCAACTTCATCCACGTTCACCTTGCCCCACAGGGCAGTAACGGCAGACTTCTCCTCAGGAGTCAGATGCACCAT',
  },
] as const;

function realHbbSequenceWindow(startBp: number, endBp: number): string {
  const bases = Array.from({ length: endBp - startBp }, () => 'N');
  for (const segment of GRCH38_HBB_CDS_SEGMENTS) {
    const offset = GRCH38_CHR11_OFFSET_BP + segment.startBp - startBp;
    for (let index = 0; index < segment.bases.length; index += 1) {
      bases[offset + index] = segment.bases[index];
    }
  }
  return bases.join('');
}

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = ((contextId: string) => {
    if (contextId !== '2d') return null;
    return {
      font: '',
      measureText: (text: string) => ({ width: text.length * 6 }),
    } as unknown as CanvasRenderingContext2D;
  }) as typeof HTMLCanvasElement.prototype.getContext;
});

function shell(): Genome {
  return {
    name: 'GRCh38 human',
    sourceIdentity: SOURCE,
    length: LENGTH,
    circular: false,
    features: [],
    sequenceAvailable: true,
  };
}

function features(count: number): Feature[] {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    type: 'mRNA',
    start: 1_000_000 + index * 1_000,
    end: 1_000_500 + index * 1_000,
    direction: 'forward',
    displayName: `TX-${index + 1}`,
    color: 0x3b82f6,
    lane: index % 12,
  }));
}

function snapshot(generation: number, count: number): AnnotationPresentationSnapshot {
  return {
    contract: 'annotation-presentation-snapshot.v1',
    sourceIdentity: SOURCE,
    genomeLengthBp: LENGTH,
    policyKey: 'canonical:lanes=12:layers=mRNA:glyph=v2',
    generation,
    features: features(count),
    requestedLayerTypes: ['mRNA'],
    layout: { maxAnnotationLane: 11, maxCdsLane: -1 },
    exactCoverage: [{ startBp: 1_000_000, endBp: 3_000_000 }],
  };
}

function state(): RenderState {
  return {
    morph: 0,
    viewOffset: 0.5,
    zoom: 1,
    width: 800,
    height: 300,
    selectedIds: new Set(),
    hoveredId: null,
    viewportRange: null,
    highlightRange: null,
    cursorPosition: null,
    hoveredCutSiteId: null,
    perfPanelVisible: false,
  };
}

function smallSnapshot(
  sourceIdentity: string,
  generation: number,
  sourceFeatures: ReadonlyArray<Feature>,
  layout: AnnotationPresentationSnapshot['layout'] = {
    maxAnnotationLane: -1,
    maxCdsLane: 0,
  }
): AnnotationPresentationSnapshot {
  return {
    contract: 'annotation-presentation-snapshot.v1',
    sourceIdentity,
    genomeLengthBp: 3_000,
    policyKey: 'small-codon-sidecar:v1',
    generation,
    features: sourceFeatures,
    requestedLayerTypes: [...new Set(sourceFeatures.map((feature) => feature.type))],
    layout,
    exactCoverage: [{ startBp: 0, endBp: 500 }],
  };
}

describe('PixiLinearRenderer annotation-only snapshot isolation', () => {
  it('applies 62 -> 40 -> 28 with full-load delta 0 and unrelated subsystem delta 0', async () => {
    const target = window as unknown as {
      __webglGenomeLoadCount?: number;
      __webglAnnotationSnapshotApplyCount?: number;
      __webglAnnotationSnapshotApplyLog?: unknown[];
    };
    target.__webglGenomeLoadCount = 0;
    target.__webglAnnotationSnapshotApplyCount = 0;
    target.__webglAnnotationSnapshotApplyLog = [];

    const renderer = new IndexedPixiLinearRenderer();
    const renderState = state();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;
    await renderer.init(app, shell(), () => renderState);
    const internals = renderer as unknown as {
      genome: Genome;
      primerOverlay: { loadGenome: (genome: Genome) => void };
      orfTrack: { loadGenome: (genome: Genome) => void };
      codonTrack: { reset: () => void };
      cutSites: unknown[];
      codonCache: Map<unknown, unknown>;
      _maxAnnotationLane: number;
      _maxCdsLane: number;
    };
    const primerLoad = vi.spyOn(internals.primerOverlay, 'loadGenome');
    const orfLoad = vi.spyOn(internals.orfTrack, 'loadGenome');
    const codonReset = vi.spyOn(internals.codonTrack, 'reset');
    const shellRef = internals.genome;
    const cutSitesRef = internals.cutSites;
    const codonCacheRef = internals.codonCache;
    codonCacheRef.set('sentinel', 'preserved');
    const fullLoadBaseline = target.__webglGenomeLoadCount;
    const cameraBefore = {
      viewOffset: renderState.viewOffset,
      zoom: renderState.zoom,
      viewportRange: renderState.viewportRange,
    };

    expect(renderer.setAnnotationPresentationSnapshot(snapshot(1, 62)).status).toBe('applied');
    expect(renderer.setAnnotationPresentationSnapshot(snapshot(2, 40)).status).toBe('applied');
    expect(renderer.setAnnotationPresentationSnapshot(snapshot(3, 28)).status).toBe('applied');

    expect(target.__webglGenomeLoadCount).toBe(fullLoadBaseline);
    expect(target.__webglAnnotationSnapshotApplyCount).toBe(3);
    expect(primerLoad).not.toHaveBeenCalled();
    expect(orfLoad).not.toHaveBeenCalled();
    expect(codonReset).not.toHaveBeenCalled();
    expect(internals.genome).toBe(shellRef);
    expect(internals.cutSites).toBe(cutSitesRef);
    expect(internals.codonCache).toBe(codonCacheRef);
    expect(internals.codonCache.get('sentinel')).toBe('preserved');
    expect({
      viewOffset: renderState.viewOffset,
      zoom: renderState.zoom,
      viewportRange: renderState.viewportRange,
    }).toEqual(cameraBefore);
    expect(internals._maxAnnotationLane).toBe(11);
    expect(internals._maxCdsLane).toBe(-1);
    expect(
      (renderer.getRendererDebugSnapshot() as { annotationOverlay: { featureCount: number } })
        .annotationOverlay.featureCount
    ).toBe(28);
  });

  it('uses a sidecar CDS as the high-zoom codon carrier without adding it to the shell', async () => {
    const sourceIdentity = 'small-indexed-source';
    const genomeShell: Genome = {
      name: 'small indexed shell',
      sourceIdentity,
      length: 3_000,
      circular: false,
      features: [],
      sequence: 'ATG'.repeat(1_000),
    };
    const renderState = {
      ...state(),
      viewOffset: 75 / genomeShell.length,
      zoom: 20,
    };
    const renderer = new IndexedPixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;
    await renderer.init(app, genomeShell, () => renderState);
    const fullLoadBaseline = (window as unknown as { __webglGenomeLoadCount?: number })
      .__webglGenomeLoadCount;
    const cds: Feature = {
      id: 9001,
      type: 'CDS',
      start: 100,
      end: 130,
      direction: 'forward',
      displayName: 'sidecar CDS',
      color: 0x22c55e,
      lane: 0,
      cdsLane: 0,
    };
    const sidecar: AnnotationPresentationSnapshot = {
      contract: 'annotation-presentation-snapshot.v1',
      sourceIdentity,
      genomeLengthBp: genomeShell.length,
      policyKey: 'cds-sidecar:v1',
      generation: 1,
      features: [cds],
      requestedLayerTypes: ['CDS'],
      layout: { maxAnnotationLane: -1, maxCdsLane: 0 },
      exactCoverage: [{ startBp: 0, endBp: 500 }],
    };
    expect(renderer.setAnnotationPresentationSnapshot(sidecar).status).toBe('applied');
    const internals = renderer as unknown as {
      annotationFeatures: ReadonlyArray<Feature>;
      codonTrack: { renderCodons: (...args: unknown[]) => void };
      genome: Genome;
    };
    const renderCodons = vi.spyOn(internals.codonTrack, 'renderCodons');

    renderer.render(renderState);

    expect(renderCodons).toHaveBeenCalled();
    expect(renderCodons.mock.calls[0]?.[0]).toMatchObject({ id: cds.id, start: 100, end: 130 });
    expect(internals.annotationFeatures).not.toBe(sidecar.features);
    expect(internals.annotationFeatures[0]).not.toBe(cds);
    expect(internals.genome).toBe(genomeShell);
    expect(genomeShell.features).toEqual([]);
    expect((window as unknown as { __webglGenomeLoadCount?: number }).__webglGenomeLoadCount).toBe(
      fullLoadBaseline
    );
  });

  it('keeps an exact CDS carrier when another requested track is legitimately empty', async () => {
    const sourceIdentity = 'resident-page-codon-source';
    const genomeShell: Genome = {
      name: 'resident page codon shell',
      sourceIdentity,
      length: 3_000,
      circular: false,
      features: [],
      annotationLayerTypes: ['mRNA', 'centromere'],
      annotationLayout: { maxAnnotationLane: 11, maxCdsLane: -1 },
      sequenceAvailable: true,
      sequenceWindow: { startBp: 0, bases: 'ATG'.repeat(200) },
    };
    const renderState = { ...state(), viewOffset: 75 / genomeShell.length, zoom: 0.5 };
    const renderer = new IndexedPixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;
    await renderer.init(app, genomeShell, () => renderState);
    const transcript: Feature = {
      id: 9101,
      type: 'mRNA',
      start: 90,
      end: 180,
      direction: 'forward',
      displayName: 'resident page transcript',
      color: 0x8b5cf6,
      lane: 0,
      annotationTrackId: 'mRNA',
      annotationTrackLane: 0,
      annotationTrackLaneCapacity: 12,
      cds: [{ start: 100, end: 129 }],
      canonicalIdentity: 'resident-page-transcript-9101',
    };
    const publication: AnnotationResidentPagePublication = {
      contract: 'annotation-resident-page-publication.v1',
      sourceIdentity,
      genomeLengthBp: genomeShell.length,
      policyKey: 'source-pages:mRNA',
      generation: 1,
      requestedLayerTypes: ['mRNA', 'centromere'],
      exactCoverage: [{ startBp: 0, endBp: genomeShell.length }],
      pages: [
        {
          contract: 'annotation-presentation-page.v1',
          pageKey: 'mRNA:0-3000',
          chromosomeId: 'chr-test',
          trackId: 'mRNA',
          trackOrder: 0,
          laneCapacity: 12,
          ownerStartBp: 0,
          ownerEndBp: genomeShell.length,
          maxFeatureEndBp: genomeShell.length,
          contentRevision: 'resident-page-codon-v1',
          features: [transcript],
        },
      ],
    };
    expect(renderer.ingestAnnotationResidentPages(publication).status).toBe('applied');
    const internals = renderer as unknown as {
      annotationFeatures: ReadonlyArray<Feature>;
      annotationOverlay: {
        selectResidentAnnotationFeaturesForViewport: (
          startBp: number,
          endBp: number
        ) => {
          status: 'unavailable' | 'ready' | 'incomplete';
          key: string | null;
          features: ReadonlyArray<Feature>;
        };
      };
      codonTrack: {
        renderCodons: (...args: unknown[]) => void;
        hitCache: ReadonlyArray<{
          featureId: number;
          strand: 1 | -1;
          start: number;
          end: number;
          pts: number[];
          xMin: number;
          xMax: number;
          yMin: number;
          yMax: number;
        }>;
        getDebugSnapshot: () => {
          hitCount: number;
          letterCount: number;
          letterSample: string[];
          unknownLetterCount: number;
          annotationSearchFocusTargetCodonCellCount: number;
          annotationSearchFocusDimmedCodonCellCount: number;
        };
      };
      genome: Genome;
    };
    const renderCodons = vi.spyOn(internals.codonTrack, 'renderCodons');
    const expectMethionineCodonsVisible = (): void => {
      const codonDebug = internals.codonTrack.getDebugSnapshot();
      expect(codonDebug.hitCount).toBe(10);
      expect(codonDebug.letterCount).toBe(10);
      expect(codonDebug.letterSample).toEqual(Array.from({ length: 10 }, () => 'M'));
      expect(codonDebug.unknownLetterCount).toBe(0);
      expect(codonDebug.annotationSearchFocusTargetCodonCellCount).toBe(10);
      expect(codonDebug.annotationSearchFocusDimmedCodonCellCount).toBe(0);
      expect(internals.codonTrack.hitCache).toHaveLength(10);
      expect(internals.codonTrack.hitCache[0]).toMatchObject({
        featureId: transcript.id,
        strand: 1,
        start: 99,
        end: 101,
      });
      expect(internals.codonTrack.hitCache[9]).toMatchObject({
        featureId: transcript.id,
        strand: 1,
        start: 126,
        end: 128,
      });
      for (const hit of internals.codonTrack.hitCache) {
        expect(hit.pts.length).toBeGreaterThanOrEqual(6);
        expect(hit.pts.every(Number.isFinite)).toBe(true);
        expect([hit.xMin, hit.xMax, hit.yMin, hit.yMax].every(Number.isFinite)).toBe(true);
        expect(hit.xMax).toBeGreaterThan(hit.xMin);
        expect(hit.yMax).toBeGreaterThan(hit.yMin);
      }
    };

    renderer.render(renderState);
    expect(renderCodons).not.toHaveBeenCalled();
    expect(internals.codonTrack.getDebugSnapshot()).toMatchObject({
      hitCount: 0,
      letterCount: 0,
      letterSample: [],
      unknownLetterCount: 0,
    });
    expect(
      renderer.getRendererDebugSnapshot() as {
        annotationOverlay: { residentAnnotationViewportSelectionQueries: number };
      }
    ).toMatchObject({
      annotationOverlay: { residentAnnotationViewportSelectionQueries: 1 },
    });

    renderState.annotationSearchFocus = {
      trackId: 'mRNA',
      canonicalIdentity: transcript.canonicalIdentity!,
    };
    renderState.zoom = 20;
    renderer.render(renderState);

    expect(renderCodons).toHaveBeenCalled();
    expect(renderCodons.mock.calls[0]?.[0]).toMatchObject({
      id: transcript.id,
      type: 'mRNA',
    });
    expect(internals.annotationFeatures).toEqual([transcript]);
    expect(internals.genome).toBe(genomeShell);
    expect(genomeShell.features).toEqual([]);
    expect(
      renderer.getRendererDebugSnapshot() as {
        annotationCodonCarrierCount: number;
        translationLaneCount: number;
        annotationOverlay: {
          residentAnnotationViewportSelectionQueries: number;
          residentAnnotationViewportSelectedPageCount: number;
          residentAnnotationViewportSelectedFeatureCount: number;
        };
      }
    ).toMatchObject({
      annotationCodonCarrierCount: 1,
      translationLaneCount: 1,
      annotationOverlay: {
        residentAnnotationViewportSelectionQueries: 1,
        residentAnnotationViewportSelectedPageCount: 1,
        residentAnnotationViewportSelectedFeatureCount: 1,
      },
    });
    expectMethionineCodonsVisible();

    renderState.viewOffset += 3 / genomeShell.length;
    renderer.render(renderState);
    expect(
      renderer.getRendererDebugSnapshot() as {
        annotationOverlay: { residentAnnotationViewportSelectionQueries: number };
      }
    ).toMatchObject({
      annotationOverlay: { residentAnnotationViewportSelectionQueries: 1 },
    });
    expectMethionineCodonsVisible();

    const residentSelection = vi
      .spyOn(internals.annotationOverlay, 'selectResidentAnnotationFeaturesForViewport')
      .mockReturnValue({ status: 'incomplete', key: 'pending-next-corridor', features: [] });
    renderState.viewOffset += 3 / genomeShell.length;
    renderer.render(renderState);
    expect(internals.annotationFeatures).toEqual([transcript]);
    expect(
      renderer.getRendererDebugSnapshot() as { annotationCodonCarrierCount: number }
    ).toMatchObject({ annotationCodonCarrierCount: 1 });
    expectMethionineCodonsVisible();

    residentSelection.mockRestore();
    renderState.viewOffset += 3 / genomeShell.length;
    renderer.render(renderState);
    expect(internals.annotationFeatures).toEqual([transcript]);
    expectMethionineCodonsVisible();
  });

  it('keeps the real GRCh38 HBB body immutable while an exact carrier page supplies reverse-strand chevrons and amino acids', async () => {
    const chr11Bp = (chromosomeBp: number): number => GRCH38_CHR11_OFFSET_BP + chromosomeBp;
    const sequenceWindowStartBp = chr11Bp(5_225_300);
    const sequenceWindowEndBp = chr11Bp(5_227_200);
    const hbbGene: Feature = {
      id: 10_001,
      type: 'gene',
      start: chr11Bp(5_225_463),
      end: chr11Bp(5_227_071),
      direction: 'reverse',
      displayName: 'HBB',
      color: 0x2563eb,
      lane: 0,
      annotationTrackId: 'gene',
      annotationTrackLane: 0,
      annotationTrackLaneCapacity: 1,
      canonicalIdentity: 'grch38:NC_000011.10:GeneID:3043',
    };
    const hbbBodyTranscript: Feature = {
      id: 10_002,
      type: 'mRNA',
      start: chr11Bp(5_225_463),
      end: chr11Bp(5_227_071),
      direction: 'reverse',
      displayName: 'NM_000518.5',
      color: 0x3b82f6,
      lane: 1,
      annotationTrackId: 'mRNA',
      annotationTrackLane: 0,
      annotationTrackLaneCapacity: 1,
      transcriptId: 'NM_000518.5',
      canonicalIdentity: 'grch38:NC_000011.10:NM_000518.5',
      exons: [
        { start: chr11Bp(5_225_464), end: chr11Bp(5_225_726) },
        { start: chr11Bp(5_226_577), end: chr11Bp(5_226_799) },
        { start: chr11Bp(5_226_930), end: chr11Bp(5_227_071) },
      ],
    };
    const hbbRegulatoryBody: Feature = {
      id: 10_003,
      type: 'regulatory',
      start: chr11Bp(5_225_340),
      end: chr11Bp(5_225_840),
      direction: 'forward',
      displayName: "HBB 3' hypersensitive site",
      color: 0xf59e0b,
      lane: 2,
      annotationTrackId: 'regulatory',
      annotationTrackLane: 0,
      annotationTrackLaneCapacity: 1,
      canonicalIdentity: 'grch38:NC_000011.10:GeneID:110006319',
    };
    const exactHbbCarrier: Feature = {
      ...hbbBodyTranscript,
      id: 10_004,
      annotationTrackLaneCapacity: 32,
      cds: [
        { start: chr11Bp(5_225_598), end: chr11Bp(5_225_726) },
        { start: chr11Bp(5_226_577), end: chr11Bp(5_226_799) },
        { start: chr11Bp(5_226_930), end: chr11Bp(5_227_021) },
      ],
      qualifiers: { codon_start: '1', protein_id: 'NP_000509.1' },
    };
    const sourceIdentity = SOURCE;
    const bodyCoverage = [{ startBp: 0, endBp: LENGTH }];
    const genomeShell: Genome = {
      name: 'GRCh38.p14',
      sourceIdentity,
      length: LENGTH,
      circular: false,
      features: [hbbGene, hbbBodyTranscript, hbbRegulatoryBody],
      annotationLayerTypes: ['gene', 'mRNA', 'regulatory'],
      annotationLayout: { maxAnnotationLane: 2, maxCdsLane: -1 },
      annotationExactCoverage: bodyCoverage,
      sequenceAvailable: true,
      sequenceWindow: {
        startBp: sequenceWindowStartBp,
        bases: realHbbSequenceWindow(sequenceWindowStartBp, sequenceWindowEndBp),
      },
    };
    const renderState: RenderState = {
      ...state(),
      viewOffset: chr11Bp(5_226_987) / genomeShell.length,
      zoom: 20_000_000,
    };
    const renderer = new IndexedPixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;
    await renderer.init(app, genomeShell, () => renderState);
    const internals = renderer as unknown as {
      _maxAnnotationLane: number;
      _maxCdsLane: number;
      annotationFeatures: ReadonlyArray<Feature>;
      annotationOverlay: {
        maxAnnotationLane: number;
        maxCdsLane: number;
        getLayoutStateForTest: () => {
          annotationRequestedLayerTypes: string[];
          annotationExactCoverage: ReadonlyArray<{ startBp: number; endBp: number }> | null;
        };
        getAnnotationPresentationFeatures: () => ReadonlyArray<Feature>;
        getDebugSnapshot: () => { featureCount: number };
      };
      codonTrack: {
        hitCache: ReadonlyArray<{
          featureId: number;
          strand: 1 | -1;
          start: number;
          end: number;
          pts: number[];
          xMin: number;
          xMax: number;
          yMin: number;
          yMax: number;
        }>;
        getDebugSnapshot: () => {
          hitCount: number;
          letterCount: number;
          letterSample: string[];
          unknownLetterCount: number;
        };
      };
    };
    const bodyFeatures = internals.annotationOverlay.getAnnotationPresentationFeatures();
    const layout = internals.annotationOverlay.getLayoutStateForTest();
    const bodyRoster = layout.annotationRequestedLayerTypes;
    const exactBodyCoverage = layout.annotationExactCoverage;
    expect(exactBodyCoverage).toEqual(bodyCoverage);
    const bodyLaneEnvelope = {
      rendererAnnotation: internals._maxAnnotationLane,
      rendererCds: internals._maxCdsLane,
      overlayAnnotation: internals.annotationOverlay.maxAnnotationLane,
      overlayCds: internals.annotationOverlay.maxCdsLane,
    };

    const carrierPublication: AnnotationResidentPagePublication = {
      contract: 'annotation-codon-carrier-page-publication.v1',
      sourceIdentity,
      genomeLengthBp: genomeShell.length,
      policyKey: 'exact-codon-carriers:mRNA',
      generation: 0,
      requestedLayerTypes: ['mRNA'],
      exactCoverage: [{ startBp: sequenceWindowStartBp, endBp: sequenceWindowEndBp }],
      pages: [
        {
          contract: 'annotation-presentation-page.v1',
          pageKey: 'NC_000011.10:mRNA:HBB',
          chromosomeId: 'NC_000011.10',
          trackId: 'mRNA',
          trackOrder: 1,
          laneCapacity: 32,
          ownerStartBp: sequenceWindowStartBp,
          ownerEndBp: sequenceWindowEndBp,
          maxFeatureEndBp: sequenceWindowEndBp,
          contentRevision: 'GRCh38.p14:NM_000518.5',
          features: [exactHbbCarrier],
        },
      ],
    };
    expect(renderer.ingestAnnotationResidentPages(carrierPublication).status).toBe('applied');

    expect(internals.annotationOverlay.getAnnotationPresentationFeatures()).toBe(bodyFeatures);
    expect(internals.annotationOverlay.getDebugSnapshot().featureCount).toBe(3);
    expect(layout.annotationRequestedLayerTypes).toBe(bodyRoster);
    expect(layout.annotationExactCoverage).toBe(exactBodyCoverage);
    expect({
      rendererAnnotation: internals._maxAnnotationLane,
      rendererCds: internals._maxCdsLane,
      overlayAnnotation: internals.annotationOverlay.maxAnnotationLane,
      overlayCds: internals.annotationOverlay.maxCdsLane,
    }).toEqual(bodyLaneEnvelope);

    renderer.render(renderState);

    expect(internals.annotationOverlay.getAnnotationPresentationFeatures()).toBe(bodyFeatures);
    expect(bodyFeatures).toEqual([hbbGene, hbbBodyTranscript, hbbRegulatoryBody]);
    expect(layout.annotationRequestedLayerTypes).toBe(bodyRoster);
    expect(layout.annotationExactCoverage).toBe(exactBodyCoverage);
    expect({
      rendererAnnotation: internals._maxAnnotationLane,
      rendererCds: internals._maxCdsLane,
      overlayAnnotation: internals.annotationOverlay.maxAnnotationLane,
      overlayCds: internals.annotationOverlay.maxCdsLane,
    }).toEqual(bodyLaneEnvelope);

    expect(internals.annotationFeatures).toEqual([exactHbbCarrier]);
    const codonDebug = internals.codonTrack.getDebugSnapshot();
    expect(codonDebug.unknownLetterCount).toBe(0);
    expect(codonDebug.letterCount).toBe(codonDebug.hitCount);
    expect(codonDebug.letterSample.join('')).toBe('MVHLTPEEKSAVTALW');
    expect(internals.codonTrack.hitCache).toHaveLength(16);
    expect(internals.codonTrack.hitCache[0]).toMatchObject({
      featureId: exactHbbCarrier.id,
      strand: -1,
      start: chr11Bp(5_227_018),
      end: chr11Bp(5_227_020),
    });
    for (const hit of internals.codonTrack.hitCache) {
      expect(hit.featureId).toBe(exactHbbCarrier.id);
      expect(hit.strand).toBe(-1);
      expect(hit.pts.length).toBeGreaterThanOrEqual(6);
      expect(hit.pts.every(Number.isFinite)).toBe(true);
      expect([hit.xMin, hit.xMax, hit.yMin, hit.yMax].every(Number.isFinite)).toBe(true);
      expect(hit.xMax).toBeGreaterThan(hit.xMin);
      expect(hit.yMax).toBeGreaterThan(hit.yMin);
    }
  });

  it('renders an overlapping exact search target after its gray AA-layer sibling', async () => {
    const sourceIdentity = 'resident-focus-order-source';
    const genomeShell: Genome = {
      name: 'resident focus order shell',
      sourceIdentity,
      length: 3_000,
      circular: false,
      features: [],
      annotationLayerTypes: ['mRNA'],
      annotationLayout: { maxAnnotationLane: 1, maxCdsLane: -1 },
      sequenceAvailable: true,
      sequenceWindow: { startBp: 0, bases: 'ATG'.repeat(200) },
    };
    const target: Feature = {
      id: 9201,
      type: 'mRNA',
      annotationTrackId: 'mRNA',
      annotationTrackLane: 0,
      annotationTrackLaneCapacity: 2,
      start: 90,
      end: 180,
      direction: 'forward',
      displayName: 'exact focus target',
      color: 0x8b5cf6,
      lane: 0,
      transcriptId: 'NM_TARGET.1',
      cds: [{ start: 100, end: 129 }],
      canonicalIdentity: 'canonical-focus-target',
    };
    const laterSibling: Feature = {
      ...target,
      id: 9202,
      annotationTrackLane: 1,
      displayName: 'later overlapping sibling',
      lane: 1,
      transcriptId: 'NM_SIBLING.1',
      canonicalIdentity: 'canonical-focus-sibling',
    };
    const renderState: RenderState = {
      ...state(),
      viewOffset: 75 / genomeShell.length,
      zoom: 20,
      annotationSearchFocus: {
        trackId: 'mRNA',
        canonicalIdentity: target.canonicalIdentity!,
      },
    };
    const renderer = new IndexedPixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;
    await renderer.init(app, genomeShell, () => renderState);
    expect(
      renderer.ingestAnnotationResidentPages({
        contract: 'annotation-resident-page-publication.v1',
        sourceIdentity,
        genomeLengthBp: genomeShell.length,
        policyKey: 'source-pages:mRNA',
        generation: 1,
        requestedLayerTypes: ['mRNA'],
        exactCoverage: [{ startBp: 0, endBp: genomeShell.length }],
        pages: [
          {
            contract: 'annotation-presentation-page.v1',
            pageKey: 'mRNA:focus-order',
            chromosomeId: 'chr-test',
            trackId: 'mRNA',
            trackOrder: 0,
            laneCapacity: 2,
            ownerStartBp: 0,
            ownerEndBp: genomeShell.length,
            maxFeatureEndBp: genomeShell.length,
            contentRevision: 'focus-order-v1',
            features: [target, laterSibling],
          },
        ],
      }).status
    ).toBe('applied');
    const internals = renderer as unknown as {
      codonTrack: {
        renderCodons: (...args: unknown[]) => void;
        getDebugSnapshot: () => {
          letterCount: number;
          annotationSearchFocusTargetCodonCellCount: number;
          annotationSearchFocusDimmedCodonCellCount: number;
        };
        letterPool: Array<{ style: { fill: unknown } }>;
      };
    };
    const renderCodons = vi.spyOn(internals.codonTrack, 'renderCodons');

    renderer.render(renderState);

    expect(renderCodons.mock.calls.map((call) => (call[0] as Feature).canonicalIdentity)).toEqual([
      laterSibling.canonicalIdentity,
      target.canonicalIdentity,
    ]);
    expect(internals.codonTrack.getDebugSnapshot()).toMatchObject({
      letterCount: 20,
      annotationSearchFocusTargetCodonCellCount: 10,
      annotationSearchFocusDimmedCodonCellCount: 10,
    });
    expect(
      internals.codonTrack.letterPool
        .slice(0, 10)
        .every((text) => Number(text.style.fill) === 0x6b7280)
    ).toBe(true);
    expect(
      internals.codonTrack.letterPool
        .slice(10, 20)
        .every((text) => Number(text.style.fill) !== 0x6b7280)
    ).toBe(true);
  });

  it('renders a policy-hidden flat focus carrier target-last without joining body state or caches', async () => {
    const visibleCanonical: Feature = {
      id: 9301,
      type: 'mRNA',
      annotationTrackId: 'mRNA',
      annotationTrackLane: 0,
      annotationTrackLaneCapacity: 1,
      start: 90,
      end: 180,
      direction: 'forward',
      displayName: 'visible canonical isoform',
      color: 0x8b5cf6,
      lane: 0,
      transcriptId: 'NM_VISIBLE.1',
      cds: [{ start: 100, end: 129 }],
      canonicalIdentity: 'canonical-visible-isoform',
    };
    const policyHiddenTarget: Feature = {
      ...visibleCanonical,
      id: 9302,
      displayName: 'policy hidden selected isoform',
      transcriptId: 'NM_HIDDEN.1',
      canonicalIdentity: 'canonical-hidden-isoform',
    };
    const genome: Genome = {
      name: 'flat policy-capped chromosome',
      length: 3_000,
      circular: false,
      features: [visibleCanonical],
      annotationLayerTypes: ['mRNA'],
      annotationLayout: { maxAnnotationLane: 0, maxCdsLane: -1 },
      sequence: 'ATG'.repeat(1_000),
    };
    const renderState: RenderState = {
      ...state(),
      viewOffset: 75 / genome.length,
      zoom: 20,
      annotationSearchFocus: {
        trackId: 'mRNA',
        canonicalIdentity: policyHiddenTarget.canonicalIdentity!,
      },
      annotationSearchFocusFeature: policyHiddenTarget,
    };
    const renderer = new IndexedPixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;
    await renderer.init(app, genome, () => renderState);
    const internals = renderer as unknown as {
      annotationFeatures: ReadonlyArray<Feature>;
      annotationCodonCarrierSignatures: Map<number, string>;
      codonCache: Map<number, unknown>;
      transientAnnotationSearchCodonCache: {
        trackId: string;
        canonicalIdentity: string;
        carrierSignature: string;
        entry: unknown;
      } | null;
      codonTrack: {
        renderCodons: (...args: unknown[]) => void;
        getDebugSnapshot: () => {
          annotationSearchFocusTargetCodonCellCount: number;
          annotationSearchFocusDimmedCodonCellCount: number;
        };
      };
    };
    const durableAnnotationFeatures = internals.annotationFeatures;
    const durableCarrierSignatures = internals.annotationCodonCarrierSignatures;
    const renderCodons = vi.spyOn(internals.codonTrack, 'renderCodons');

    renderer.render(renderState);

    expect(renderCodons.mock.calls.map((call) => (call[0] as Feature).canonicalIdentity)).toEqual([
      visibleCanonical.canonicalIdentity,
      policyHiddenTarget.canonicalIdentity,
    ]);
    expect(internals.codonTrack.getDebugSnapshot()).toMatchObject({
      annotationSearchFocusTargetCodonCellCount: 10,
      annotationSearchFocusDimmedCodonCellCount: 10,
    });
    expect(internals.annotationFeatures).toBe(durableAnnotationFeatures);
    expect(internals.annotationFeatures).toEqual([visibleCanonical]);
    expect(internals.annotationCodonCarrierSignatures).toBe(durableCarrierSignatures);
    expect(internals.annotationCodonCarrierSignatures.has(policyHiddenTarget.id)).toBe(false);
    expect(internals.codonCache.has(visibleCanonical.id)).toBe(true);
    expect(internals.codonCache.has(policyHiddenTarget.id)).toBe(false);
    expect(internals.transientAnnotationSearchCodonCache).toMatchObject({
      trackId: 'mRNA',
      canonicalIdentity: policyHiddenTarget.canonicalIdentity,
    });
    const transientEntry = internals.transientAnnotationSearchCodonCache?.entry;
    renderer.render(renderState);
    expect(internals.transientAnnotationSearchCodonCache?.entry).toBe(transientEntry);
    expect(
      renderer.getRendererDebugSnapshot() as {
        annotationCodonCarrierCount: number;
        translationLaneCount: number;
      }
    ).toMatchObject({
      annotationCodonCarrierCount: 1,
      translationLaneCount: 1,
    });

    renderCodons.mockClear();
    renderState.annotationSearchFocus = null;
    renderer.render(renderState);

    expect(renderCodons.mock.calls.map((call) => (call[0] as Feature).canonicalIdentity)).toEqual([
      visibleCanonical.canonicalIdentity,
    ]);
    expect(internals.annotationFeatures).toBe(durableAnnotationFeatures);
    expect(internals.codonCache.has(policyHiddenTarget.id)).toBe(false);
    expect(internals.transientAnnotationSearchCodonCache).toBeNull();

    renderCodons.mockClear();
    renderState.annotationSearchFocus = {
      trackId: 'mRNA',
      canonicalIdentity: visibleCanonical.canonicalIdentity!,
    };
    renderState.annotationSearchFocusFeature = visibleCanonical;
    renderer.render(renderState);

    expect(renderCodons.mock.calls.map((call) => (call[0] as Feature).canonicalIdentity)).toEqual([
      visibleCanonical.canonicalIdentity,
    ]);
  });

  it('keeps resident selection and durable body identity stable across hidden-track focus changes', async () => {
    const sourceIdentity = 'hidden-focus-resident-source';
    const durable: Feature = {
      id: 9351,
      type: 'mRNA',
      annotationTrackId: 'mRNA',
      annotationTrackLane: 0,
      annotationTrackLaneCapacity: 1,
      start: 90,
      end: 180,
      direction: 'forward',
      displayName: 'durable resident transcript',
      color: 0x3b82f6,
      lane: 0,
      canonicalIdentity: 'canonical-durable-resident-transcript',
    };
    const hiddenA: Feature = {
      ...durable,
      id: 9352,
      type: 'ncRNA',
      annotationTrackId: 'lncRNA',
      displayName: 'hidden result A',
      canonicalIdentity: 'canonical-hidden-result-a',
      lane: 77,
    };
    const hiddenB: Feature = {
      ...hiddenA,
      id: 9353,
      start: 210,
      end: 280,
      displayName: 'hidden result B',
      canonicalIdentity: 'canonical-hidden-result-b',
      lane: 88,
    };
    const genome: Genome = {
      name: 'hidden-focus-resident-shell',
      sourceIdentity,
      length: 3_000,
      circular: false,
      features: [],
      annotationLayerTypes: ['mRNA'],
      annotationLayout: { maxAnnotationLane: 0, maxCdsLane: -1 },
      sequence: 'A'.repeat(3_000),
    };
    const renderState: RenderState = {
      ...state(),
      height: 500,
      viewOffset: 150 / genome.length,
      zoom: 10,
      annotationSearchFocus: null,
      annotationSearchFocusFeature: null,
    };
    const renderer = new IndexedPixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;
    await renderer.init(app, genome, () => renderState);
    expect(
      renderer.ingestAnnotationResidentPages({
        contract: 'annotation-resident-page-publication.v1',
        sourceIdentity,
        genomeLengthBp: genome.length,
        policyKey: 'source-pages:mRNA',
        generation: 1,
        requestedLayerTypes: ['mRNA'],
        exactCoverage: [{ startBp: 0, endBp: genome.length }],
        pages: [
          {
            contract: 'annotation-presentation-page.v1',
            pageKey: 'mRNA:0-3000',
            chromosomeId: 'chr-test',
            trackId: 'mRNA',
            trackOrder: 0,
            laneCapacity: 1,
            ownerStartBp: 0,
            ownerEndBp: genome.length,
            maxFeatureEndBp: genome.length,
            contentRevision: 'resident-hidden-focus-v1',
            features: [durable],
          },
        ],
      }).status
    ).toBe('applied');
    const internals = renderer as unknown as {
      annotationFeatures: ReadonlyArray<Feature>;
      annotationResidentFeatureSelectionKey: string | null;
      annotationOverlay: {
        getResidentPageControllerForTest: () => {
          residentAnnotationViewportSelectionCache: {
            sourceKey: string;
            records: unknown;
            features: ReadonlyArray<Feature>;
          } | null;
        };
        getDebugSnapshot: () => {
          residentAnnotationViewportSelectionQueries: number;
        };
      };
    };

    renderer.render(renderState);
    const durableBody = internals.annotationFeatures;
    const durableSelectionKey = internals.annotationResidentFeatureSelectionKey;
    const durableSelectionCache =
      internals.annotationOverlay.getResidentPageControllerForTest()
        .residentAnnotationViewportSelectionCache;
    const durableQueryCount =
      internals.annotationOverlay.getDebugSnapshot().residentAnnotationViewportSelectionQueries;
    expect(durableBody).toEqual([durable]);
    expect(durableSelectionKey).not.toBeNull();
    expect(durableSelectionCache?.records).toBeTruthy();
    expect(durableSelectionCache?.features).toEqual([durable]);

    const assertDurableResidentSelection = () => {
      const cache =
        internals.annotationOverlay.getResidentPageControllerForTest()
          .residentAnnotationViewportSelectionCache;
      expect(internals.annotationFeatures).toBe(durableBody);
      expect(internals.annotationResidentFeatureSelectionKey).toBe(durableSelectionKey);
      expect(cache?.sourceKey).toBe(durableSelectionCache?.sourceKey);
      expect(cache?.records).toBe(durableSelectionCache?.records);
      expect(cache?.features).toEqual([durable]);
      expect(
        internals.annotationOverlay.getDebugSnapshot().residentAnnotationViewportSelectionQueries
      ).toBe(durableQueryCount);
    };

    for (const hidden of [hiddenA, hiddenB]) {
      renderState.annotationSearchFocus = {
        trackId: 'lncRNA',
        canonicalIdentity: hidden.canonicalIdentity!,
      };
      renderState.annotationSearchFocusFeature = hidden;
      renderer.render(renderState);
      assertDurableResidentSelection();
    }

    renderState.annotationSearchFocus = null;
    renderState.annotationSearchFocusFeature = null;
    renderer.render(renderState);
    assertDurableResidentSelection();
  });

  it('projects a hidden-track carrier into one isolated transient band without changing durable lanes', async () => {
    const durable: Feature = {
      id: 9401,
      type: 'mRNA',
      annotationTrackId: 'mRNA',
      annotationTrackLane: 0,
      annotationTrackLaneCapacity: 1,
      start: 90,
      end: 180,
      direction: 'forward',
      displayName: 'durable transcript',
      color: 0x3b82f6,
      lane: 0,
      canonicalIdentity: 'canonical-durable-transcript',
    };
    const hidden: Feature = {
      id: 9402,
      type: 'ncRNA',
      annotationTrackId: 'lncRNA',
      annotationTrackLane: 17,
      annotationTrackLaneCapacity: 32,
      start: 200,
      end: 260,
      direction: 'reverse',
      displayName: 'hidden transcript',
      color: 0x8b5cf6,
      lane: 99,
      canonicalIdentity: 'canonical-hidden-transcript',
      exons: [{ start: 201, end: 260 }],
      cds: [],
    };
    const genome: Genome = {
      name: 'hidden-track-transient-band',
      length: 3_000,
      circular: false,
      features: [durable],
      annotationLayerTypes: ['mRNA'],
      annotationLayout: { maxAnnotationLane: 0, maxCdsLane: -1 },
      sequence: 'A'.repeat(3_000),
    };
    const renderState: RenderState = {
      ...state(),
      height: 500,
      viewOffset: 150 / genome.length,
      zoom: 10,
      annotationSearchFocus: {
        trackId: 'lncRNA',
        canonicalIdentity: hidden.canonicalIdentity!,
      },
      annotationSearchFocusFeature: hidden,
    };
    const renderer = new IndexedPixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;
    await renderer.init(app, genome, () => renderState);
    const internals = renderer as unknown as {
      _maxAnnotationLane: number;
      annotationFeatures: ReadonlyArray<Feature>;
      annotationOverlay: {
        maxAnnotationLane: number;
        getLayoutStateForTest: () => {
          _contract: {
            lanes: ReadonlyArray<{ role: string; laneIndex: number }>;
          } | null;
        };
        getDebugSnapshot: () => {
          annotationSearchFocusMaskDrawCount: number;
          annotationSearchFocusPrimitiveDrawCount: number;
        };
      };
    };
    const body = internals.annotationFeatures;

    renderer.render(renderState);

    expect(
      internals.annotationOverlay
        .getLayoutStateForTest()
        ._contract!.lanes.filter(({ role }) => role === 'annotation')
        .map(({ laneIndex }) => laneIndex)
    ).toEqual([0, 1, 2]);
    expect(internals.annotationOverlay.getDebugSnapshot()).toMatchObject({
      annotationSearchFocusMaskDrawCount: 1,
      annotationSearchFocusPrimitiveDrawCount: expect.any(Number),
    });
    expect(
      internals.annotationOverlay.getDebugSnapshot().annotationSearchFocusPrimitiveDrawCount
    ).toBeGreaterThan(0);
    expect(internals._maxAnnotationLane).toBe(0);
    expect(internals.annotationOverlay.maxAnnotationLane).toBe(0);
    expect(internals.annotationFeatures).toBe(body);
    expect(hidden.lane).toBe(99);

    renderState.annotationSearchFocus = null;
    renderState.annotationSearchFocusFeature = null;
    renderer.render(renderState);

    expect(
      internals.annotationOverlay
        .getLayoutStateForTest()
        ._contract!.lanes.filter(({ role }) => role === 'annotation')
        .map(({ laneIndex }) => laneIndex)
    ).toEqual([0]);
    expect(internals._maxAnnotationLane).toBe(0);
    expect(internals.annotationOverlay.maxAnnotationLane).toBe(0);
    expect(internals.annotationFeatures).toBe(body);
  });

  it('invalidates only a same-id codon carrier whose semantic geometry changed', async () => {
    const sourceIdentity = 'codon-reconciliation-source';
    const genomeShell: Genome = {
      name: 'codon reconciliation shell',
      sourceIdentity,
      length: 3_000,
      circular: false,
      features: [],
      sequence: 'ATG'.repeat(1_000),
    };
    const renderState = { ...state(), viewOffset: 75 / genomeShell.length, zoom: 20 };
    const renderer = new IndexedPixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;
    await renderer.init(app, genomeShell, () => renderState);
    const changedA: Feature = {
      id: 7001,
      type: 'CDS',
      start: 100,
      end: 130,
      direction: 'forward',
      displayName: 'changed carrier',
      color: 0x22c55e,
      lane: 0,
      cdsLane: 0,
    };
    const stableA: Feature = {
      id: 7002,
      type: 'CDS',
      start: 140,
      end: 170,
      direction: 'forward',
      displayName: 'stable carrier',
      color: 0x3b82f6,
      lane: 1,
      cdsLane: 1,
    };
    expect(
      renderer.setAnnotationPresentationSnapshot(
        smallSnapshot(sourceIdentity, 1, [changedA, stableA], {
          maxAnnotationLane: -1,
          maxCdsLane: 1,
        })
      ).status
    ).toBe('applied');
    renderer.render(renderState);
    type CacheEntry = {
      codons: Array<{ startBp: number }>;
      introns: unknown[];
      lo: number;
      hi: number;
    };
    const codonCache = (renderer as unknown as { codonCache: Map<number, CacheEntry> }).codonCache;
    const changedEntryA = codonCache.get(changedA.id);
    const stableEntryA = codonCache.get(stableA.id);
    expect(changedEntryA?.codons[0]?.startBp).toBe(100);
    expect(stableEntryA?.codons[0]?.startBp).toBe(140);

    const changedB = { ...changedA, start: 106, end: 136 };
    const stableB = { ...stableA };
    expect(
      renderer.setAnnotationPresentationSnapshot(
        smallSnapshot(sourceIdentity, 2, [changedB, stableB], {
          maxAnnotationLane: -1,
          maxCdsLane: 1,
        })
      ).status
    ).toBe('applied');
    expect(codonCache.has(changedA.id)).toBe(false);
    expect(codonCache.get(stableA.id)).toBe(stableEntryA);

    renderer.render(renderState);
    const changedEntryB = codonCache.get(changedA.id);
    expect(changedEntryB).not.toBe(changedEntryA);
    expect(changedEntryB?.codons[0]?.startBp).toBe(106);
    expect(codonCache.get(stableA.id)).toBe(stableEntryA);
  });

  it('recognizes a production mRNA cds[] carrier and reserves high-zoom translation capability', async () => {
    const sourceIdentity = 'transcript-codon-carrier-source';
    const genomeShell: Genome = {
      name: 'transcript codon shell',
      sourceIdentity,
      length: 3_000,
      circular: false,
      features: [],
      sequence: 'ATG'.repeat(1_000),
    };
    const renderState = { ...state(), viewOffset: 75 / genomeShell.length, zoom: 20 };
    const renderer = new IndexedPixiLinearRenderer();
    const app = {
      stage: new Container(),
      canvas: document.createElement('canvas'),
    } as unknown as Application;
    await renderer.init(app, genomeShell, () => renderState);
    const transcript: Feature = {
      id: 8001,
      type: 'mRNA',
      start: 90,
      end: 180,
      direction: 'forward',
      displayName: 'production transcript carrier',
      color: 0x8b5cf6,
      lane: 0,
      cds: [{ start: 101, end: 130 }],
    };
    expect(
      renderer.setAnnotationPresentationSnapshot(
        smallSnapshot(sourceIdentity, 1, [transcript], {
          maxAnnotationLane: 0,
          maxCdsLane: -1,
        })
      ).status
    ).toBe('applied');
    const internals = renderer as unknown as {
      annotationHasDirectionalCds: boolean;
      codonTrack: { renderCodons: (...args: unknown[]) => void };
      _overlayLayout: { annotationHeight: number } | null;
    };
    const renderCodons = vi.spyOn(internals.codonTrack, 'renderCodons');

    renderer.render(renderState);

    expect(internals.annotationHasDirectionalCds).toBe(true);
    expect(renderCodons).toHaveBeenCalled();
    expect(renderCodons.mock.calls[0]?.[0]).toMatchObject({ id: transcript.id, type: 'mRNA' });
    expect(internals._overlayLayout?.annotationHeight).toBeGreaterThan(0);
    expect(
      renderer.getRendererDebugSnapshot() as {
        annotationCodonCarrierCount: number;
        translationLaneCount: number;
      }
    ).toMatchObject({ annotationCodonCarrierCount: 1, translationLaneCount: 1 });
  });
});

import { act, render, screen } from '@testing-library/react';
import { createRef, type ElementRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type {
  AnnotationFlatPresentationSnapshot,
  AnnotationResidentPagePublication,
  FeatureHitPayload,
  Feature,
  Genome,
} from '@waypoint/genome-renderer';
import { IndexedGenomeTileNativeMap } from './IndexedGenomeTileNativeMap';
import type { IndexedGenomeSelectedAnnotation } from './indexed-genome-selection';

const pixi = vi.hoisted(() => ({
  options: null as Record<string, unknown> | null,
  requestRender: vi.fn(),
}));

vi.mock('@waypoint/genome-renderer/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@waypoint/genome-renderer/react')>();
  return {
    ...actual,
    useIndexedPixiMap: (options: Record<string, unknown>) => {
      pixi.options = options;
      return {
        containerRef: { current: null },
        handle: {
          getState: () => ({ highlightRange: null, cursorPosition: null }),
          requestRender: pixi.requestRender,
          getViewCenter: () => 1_544_005_000,
          getViewportRange: () => ({ start: 1_444_000_000, end: 1_644_000_000 }),
          setViewport: vi.fn(),
          setViewCenter: vi.fn(),
          setDisplaySize: vi.fn(),
          getLinearRenderer: () => null,
          subscribeToPresentedFrames: vi.fn(() => () => {}),
        },
      };
    },
  };
});

const genome: Genome = {
  name: 'grch38-full-assembly',
  sourceIdentity: 'grch38-source',
  length: 3_088_269_832,
  circular: false,
  annotationLayerTypes: ['mRNA'],
  features: [],
};

const detailGenome: Genome = {
  ...genome,
  features: [
    {
      id: 4_000_000_000,
      canonicalIdentity: '["annotation.v2","grch38-source","rna-TX41"]',
      start: 1_544_000_000,
      end: 1_544_010_000,
      type: 'mRNA',
      displayName: 'TX41',
      transcriptId: 'NM_TX41.1',
      sourceId: 'rna-TX41',
      direction: 'forward',
      color: 0x3b82f6,
      lane: 4,
    },
  ],
};

const hit: FeatureHitPayload = {
  id: 17,
  start: 1_544_000_000,
  end: 1_544_010_000,
  canonicalIdentity: '["annotation.v2","grch38-source","rna-TX41"]',
  displayName: 'TX41',
  type: 'mRNA',
  transcriptId: 'NM_TX41.1',
  sourceId: 'rna-TX41',
  lane: 4,
  direction: 'forward',
};

const richTooltipHits = [
  hit,
  {
    ...hit,
    id: 18,
    canonicalIdentity: '["annotation.v2","grch38-source","rna-H19"]',
    displayName: 'H19',
    type: 'lnc_RNA',
    transcriptId: 'NR_H19.1',
    sourceId: 'rna-H19',
    lane: 2,
    direction: 'reverse',
  },
  {
    ...hit,
    id: 19,
    canonicalIdentity: '["annotation.v2","grch38-source","enhancer-E47"]',
    displayName: 'Enhancer E47',
    type: 'enhancer',
    transcriptId: null,
    sourceId: 'enhancer-E47',
    lane: 1,
    direction: 'none',
  },
  {
    ...hit,
    id: 20,
    canonicalIdentity: '["annotation.v2","grch38-source","silencer-S12"]',
    displayName: 'Silencer S12',
    type: 'silencer',
    transcriptId: null,
    sourceId: 'silencer-S12',
    lane: 3,
    direction: 'none',
  },
] satisfies readonly FeatureHitPayload[];

const annotationSnapshot: AnnotationFlatPresentationSnapshot = {
  contract: 'annotation-presentation-snapshot.v1',
  sourceIdentity: 'grch38-source',
  genomeLengthBp: 3_088_269_832,
  policyKey: 'mRNA:canonical:12',
  generation: 0,
  features: detailGenome.features ?? [],
  requestedLayerTypes: ['mRNA'],
  layout: { maxAnnotationLane: 11, maxCdsLane: -1 },
  exactCoverage: [],
};

const residentPagePublication: AnnotationResidentPagePublication = {
  contract: 'annotation-resident-page-publication.v1',
  sourceIdentity: 'grch38-source',
  genomeLengthBp: 3_088_269_832,
  policyKey: 'mRNA:source-pages',
  generation: 0,
  requestedLayerTypes: ['mRNA'],
  exactCoverage: [],
  pages: [],
};

describe('IndexedGenomeTileNativeMap prepacked interaction', () => {
  it('uses native read cadence without changing quantitative edge coverage', () => {
    const originalPixelRatio = window.devicePixelRatio;
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
    try {
      const view = render(
        <IndexedGenomeTileNativeMap genome={genome} themeMode="light" width={1_100} height={800} />
      );
      expect(pixi.options?.antialias).toBe(false);
      expect(pixi.options?.resolution).toBe(1.5);
      expect(pixi.options?.minimumFrameIntervalMs).toBe(13);
      view.rerender(
        <IndexedGenomeTileNativeMap
          genome={genome}
          themeMode="light"
          width={1_100}
          height={800}
          hasPileupTracks
        />
      );
      expect(pixi.options?.antialias).toBe(false);
      expect(pixi.options?.resolution).toBe(1.5);
      expect(pixi.options?.minimumFrameIntervalMs).toBe(0);
      view.rerender(
        <IndexedGenomeTileNativeMap
          genome={genome}
          themeMode="light"
          width={1_100}
          height={800}
          hasQuantitativeTracks
        />
      );
      expect(pixi.options?.antialias).toBe(true);
      expect(pixi.options?.resolution).toBe(2);
      expect(pixi.options?.minimumFrameIntervalMs ?? 0).toBe(0);
      view.rerender(
        <IndexedGenomeTileNativeMap genome={genome} themeMode="light" width={1_100} height={800} />
      );
      expect(pixi.options?.antialias).toBe(false);
      expect(pixi.options?.minimumFrameIntervalMs).toBe(13);
    } finally {
      Object.defineProperty(window, 'devicePixelRatio', {
        value: originalPixelRatio,
        configurable: true,
      });
    }
  });

  it('forwards the coordinate-derived broad requirement without requiring an annotation sidecar', () => {
    const requirement = {
      identityKey: 'indexed-full-assembly:fixture',
      genomeLengthBp: genome.length,
      broadCorridorFinestSpanBp: 16_000_000,
    };
    render(
      <IndexedGenomeTileNativeMap
        genome={genome}
        compiledBroadSurfaceRequirement={requirement}
        width={1_600}
        height={500}
      />
    );

    expect(pixi.options?.compiledBroadSurfaceRequirement).toEqual(requirement);
    expect(pixi.options?.annotationPresentationSnapshot).toBeUndefined();
    expect(pixi.options?.annotationResidentPagePublication).toBeUndefined();
    expect(pixi.options?.hiddenMapIdlePolicy).toBe('short-timeout');
  });

  it('forwards a render-loop invalidation without changing the camera', () => {
    const ref = createRef<ElementRef<typeof IndexedGenomeTileNativeMap>>();
    render(<IndexedGenomeTileNativeMap ref={ref} genome={genome} width={1_600} height={500} />);

    act(() => ref.current?.requestRender());

    expect(pixi.requestRender).toHaveBeenCalledTimes(1);
  });

  it('forwards resident pages without converting them into a flat presentation snapshot', () => {
    render(
      <IndexedGenomeTileNativeMap
        genome={genome}
        annotationResidentPagePublication={residentPagePublication}
        width={1_600}
        height={500}
      />
    );

    expect(pixi.options?.annotationResidentPagePublication).toBe(residentPagePublication);
    expect(pixi.options?.annotationPresentationSnapshot).toBeUndefined();
    expect(screen.getByTestId('indexed-genome-webgl-map').dataset.featureCount).toBe('0');
  });

  it('forwards only the exact track and canonical identity for search focus', () => {
    const focus = {
      trackId: 'lncRNA',
      canonicalIdentity: 'annotation.v2:H19.ncrna.1',
    };
    const view = render(
      <IndexedGenomeTileNativeMap
        genome={genome}
        annotationSearchFocus={focus}
        width={1_600}
        height={500}
      />
    );

    expect(pixi.options?.annotationSearchFocus).toBe(focus);

    view.rerender(<IndexedGenomeTileNativeMap genome={genome} width={1_600} height={500} />);
    expect(pixi.options?.annotationSearchFocus).toBeUndefined();
  });

  it('resolves selection and feature counts from the sidecar instead of the stable shell', () => {
    const onSelectedAnnotationChange = vi.fn();
    render(
      <IndexedGenomeTileNativeMap
        genome={genome}
        annotationPresentationSnapshot={annotationSnapshot}
        width={1_600}
        height={500}
        selectedAnnotation={null}
        onSelectedAnnotationChange={onSelectedAnnotationChange}
      />
    );

    expect(screen.getByTestId('indexed-genome-webgl-map').dataset.featureCount).toBe('1');
    expect(pixi.options?.genome).toBe(genome);
    expect(pixi.options?.annotationPresentationSnapshot).toBe(annotationSnapshot);
    act(() => {
      (pixi.options?.onHoverChange as (value: unknown) => void)({
        ...hit,
        id: 4_000_000_000,
        screenX: 800,
        screenY: 152,
      });
    });
    expect(screen.getByText('TX41')).toBeTruthy();
    act(() => {
      (pixi.options?.onFeatureClick as (value: number) => void)(4_000_000_000);
    });
    expect(onSelectedAnnotationChange.mock.lastCall?.[0]).toMatchObject({
      featureId: 4_000_000_000,
      canonicalIdentity: hit.canonicalIdentity,
    });
  });

  it.each(richTooltipHits)(
    'renders the complete rich tooltip contract for $type without a resident Feature graph',
    (richHit) => {
      render(<IndexedGenomeTileNativeMap genome={genome} width={1_600} height={500} />);

      act(() => {
        (pixi.options?.onHoverChange as (value: unknown) => void)({
          ...richHit,
          screenX: 800,
          screenY: 152,
        });
      });

      const tooltip = screen.getByTestId('indexed-annotation-feature-tooltip');
      expect(tooltip.textContent).toContain(richHit.displayName);
      expect(tooltip.textContent).toContain(richHit.type);
      expect(tooltip.textContent).toContain('1544000001-1544010000');
      expect(tooltip.textContent).toContain(`lane ${richHit.lane}`);
      if (richHit.direction !== 'none') {
        expect(tooltip.textContent).toContain(richHit.direction);
      }
      expect(tooltip.textContent).toContain(richHit.sourceId);
      if (richHit.transcriptId !== null) {
        expect(tooltip.textContent).toContain(richHit.transcriptId);
      }
      expect(tooltip.textContent).toContain(String(richHit.id));
    }
  );

  it.each(['forward', 'reverse'] as const)(
    'updates %s CDS regions from resident segments without rerendering within a region',
    (direction) => {
      const start = 1_544_000_000;
      const feature: Feature = {
        id: 17,
        start,
        end: start + 80,
        type: 'CDS',
        displayName: 'Spliced CDS',
        direction,
        color: 0x3b82f6,
        lane: 4,
        segments: [
          { start: start + 1, end: start + 20 },
          { start: start + 41, end: start + 80 },
        ],
      };
      render(
        <IndexedGenomeTileNativeMap
          genome={{ ...genome, features: [feature] }}
          width={1_600}
          height={500}
        />
      );
      const hoverAt = (position: number) =>
        act(() =>
          (pixi.options?.onHoverChange as (value: unknown) => void)({
            ...feature,
            position,
            screenX: 100,
            screenY: 100,
          })
        );
      hoverAt(start + 5);
      expect(screen.getByTestId('indexed-annotation-feature-tooltip').textContent).toContain(
        direction === 'forward' ? 'Exon 1' : 'Exon 2'
      );
      const sameRegionOptions = pixi.options;
      hoverAt(start + 6);
      expect(pixi.options).toBe(sameRegionOptions);
      hoverAt(start + 25);
      expect(screen.getByTestId('indexed-annotation-feature-tooltip').textContent).toContain(
        'Intron 1'
      );
      hoverAt(start + 60);
      const tooltip = screen.getByTestId('indexed-annotation-feature-tooltip');
      expect(tooltip.textContent).toContain(direction === 'forward' ? 'Exon 2' : 'Exon 1');
      expect(tooltip.textContent).not.toContain('Intron');
      act(() =>
        (pixi.options?.onHoverChange as (value: unknown) => void)({
          ...hit,
          id: 99,
          type: 'CDS',
          position: start + 25,
          screenX: 100,
          screenY: 100,
        })
      );
      expect(tooltip.textContent).not.toMatch(/Exon|Intron/);
    }
  );

  it('renders a rich tooltip and preserves exact selection with no resident Feature graph', () => {
    const onSelectedAnnotationChange = vi.fn();
    const view = render(
      <IndexedGenomeTileNativeMap
        genome={genome}
        width={1_600}
        height={500}
        selectedAnnotation={null}
        onSelectedAnnotationChange={onSelectedAnnotationChange}
      />
    );

    act(() => {
      (pixi.options?.onHoverChange as (value: unknown) => void)({
        ...hit,
        screenX: 800,
        screenY: 152,
      });
    });
    expect(screen.getByText('TX41')).toBeTruthy();
    expect(screen.getByText(/mRNA.*1544000001-1544010000.*forward.*lane 4/)).toBeTruthy();
    expect(screen.getByText(/rna-TX41/)).toBeTruthy();
    expect(screen.getByText(/NM_TX41\.1/)).toBeTruthy();

    act(() => {
      (pixi.options?.onFeatureHitClick as (value: FeatureHitPayload) => void)(hit);
    });
    const selected = onSelectedAnnotationChange.mock.lastCall?.[0] as
      | IndexedGenomeSelectedAnnotation
      | undefined;
    expect(selected).toMatchObject({
      featureId: 17,
      canonicalIdentity: hit.canonicalIdentity,
      type: 'mRNA',
      name: 'TX41',
      start: 1_544_000_001,
      end: 1_544_010_000,
      direction: 1,
    });

    view.rerender(
      <IndexedGenomeTileNativeMap
        genome={genome}
        width={1_600}
        height={500}
        selectedAnnotation={selected}
        onSelectedAnnotationChange={onSelectedAnnotationChange}
      />
    );
    expect(pixi.options?.selectedFeatureIds).toEqual(new Set([17]));
    expect(pixi.options?.selectedFeatureCanonicalIdentities).toEqual(
      new Set([hit.canonicalIdentity])
    );
    expect(screen.getByTestId('indexed-genome-webgl-map').dataset.featureCount).toBe('0');

    view.rerender(
      <IndexedGenomeTileNativeMap
        genome={detailGenome}
        width={1_600}
        height={500}
        selectedAnnotation={selected}
        onSelectedAnnotationChange={onSelectedAnnotationChange}
      />
    );
    expect(pixi.options?.selectedFeatureIds).toEqual(new Set([4_000_000_000]));
    expect(pixi.options?.annotationPresentationSnapshot).toBeUndefined();
    expect(pixi.options?.genome).toBe(detailGenome);
    expect(screen.getByTestId('indexed-genome-webgl-map').dataset.featureCount).toBe('1');

    act(() => {
      (pixi.options?.onFeatureClick as (value: number) => void)(4_000_000_000);
    });
    const selectedFromDetail = onSelectedAnnotationChange.mock.lastCall?.[0] as
      | IndexedGenomeSelectedAnnotation
      | undefined;
    expect(selectedFromDetail).toMatchObject({
      featureId: 4_000_000_000,
      canonicalIdentity: hit.canonicalIdentity,
    });
    view.rerender(
      <IndexedGenomeTileNativeMap
        genome={genome}
        width={1_600}
        height={500}
        selectedAnnotation={selectedFromDetail}
        onSelectedAnnotationChange={onSelectedAnnotationChange}
      />
    );
    expect(pixi.options?.selectedFeatureIds).toEqual(new Set());
    expect(pixi.options?.selectedFeatureCanonicalIdentities).toEqual(
      new Set([hit.canonicalIdentity])
    );
  });
});

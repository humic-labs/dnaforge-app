// @vitest-environment node

import { describe, it, expect } from 'vitest';
import {
  annotationRoutingRedriveGeneration,
  compiledViewportDetailRosterCoversViewportV1,
  lodTierForViewport,
} from './assembly-lod-policy';
import { ANNOTATION_VIEWPORT_TILE_MAX_BP } from './indexed-annotation-tile-policy';
import {
  SEQUENCE_RENDER_MIN_PIXELS_PER_BP,
  SEQUENCE_STREAM_MIN_PIXELS_PER_BP,
} from './indexed-sequence-window-policy';

describe('lodTierForViewport  LOD continuum tier contract)', () => {
  it('above the 512 kb annotation boundary → OVERVIEW (no detail tiles)', () => {
    const d = lodTierForViewport({
      visibleBp: ANNOTATION_VIEWPORT_TILE_MAX_BP + 1,
      pixelsPerBp: 1e-5,
    });
    expect(d.tier).toBe('overview');
    expect(d.annotationRepresentation).toBe('legacy-summary');
    expect(d.fetchAnnotationTile).toBe(false);
    expect(d.fetchCodonCarrierPages).toBe(false);
    expect(d.prefetchCodonCarrierPages).toBe(false);
  });

  it('at/below the 512 kb boundary → DETAIL (fetch viewport tiles)', () => {
    const d = lodTierForViewport({
      visibleBp: ANNOTATION_VIEWPORT_TILE_MAX_BP,
      pixelsPerBp: 0.01,
    });
    expect(d.tier).toBe('detail');
    expect(d.annotationRepresentation).toBe('resident-exact');
    expect(d.fetchAnnotationTile).toBe(true);
    expect(d.fetchCodonCarrierPages).toBe(false);
    expect(d.prefetchCodonCarrierPages).toBe(false);
  });

  it('genome-scale (3 Gbp visible) is OVERVIEW; nucleotides off', () => {
    const d = lodTierForViewport({ visibleBp: 3_088_269_832, pixelsPerBp: 1500 / 3_088_269_832 });
    expect(d.tier).toBe('overview');
    expect(d.streamNucleotides).toBe(false);
    expect(d.renderNucleotides).toBe(false);
  });

  it('streams nucleotides at the stream threshold; renders only at the render threshold', () => {
    const streaming = lodTierForViewport({
      visibleBp: 50_000,
      pixelsPerBp: SEQUENCE_STREAM_MIN_PIXELS_PER_BP,
    });
    expect(streaming.streamNucleotides).toBe(true);
    expect(streaming.renderNucleotides).toBe(false);

    const rendering = lodTierForViewport({
      visibleBp: 2_000,
      pixelsPerBp: SEQUENCE_RENDER_MIN_PIXELS_PER_BP,
    });
    expect(rendering.streamNucleotides).toBe(true);
    expect(rendering.renderNucleotides).toBe(true);
  });

  it('just below the stream threshold streams nothing', () => {
    const d = lodTierForViewport({
      visibleBp: 200_000,
      pixelsPerBp: SEQUENCE_STREAM_MIN_PIXELS_PER_BP - 1e-6,
    });
    expect(d.streamNucleotides).toBe(false);
    expect(d.renderNucleotides).toBe(false);
  });

  it('prefetches compiled codon carriers before nucleotide streaming needs them', () => {
    const compiledBroadSurface = {
      broadCorridorFinestSpanBp: 16_000_000,
      viewportCssWidthPx: 1000,
      devicePixelRatio: 2,
      residentSceneCoversViewport: true,
    } as const;
    const prefetchThreshold = SEQUENCE_STREAM_MIN_PIXELS_PER_BP / 16;
    const prefetch = lodTierForViewport({
      visibleBp: 200_000,
      pixelsPerBp: prefetchThreshold,
      compiledBroadSurface,
    });
    const broad = lodTierForViewport({
      visibleBp: 600_000,
      pixelsPerBp: prefetchThreshold - 1e-6,
      compiledBroadSurface,
    });

    expect(prefetch.prefetchCodonCarrierPages).toBe(true);
    expect(prefetch.fetchCodonCarrierPages).toBe(false);
    expect(prefetch.streamNucleotides).toBe(false);
    expect(broad.prefetchCodonCarrierPages).toBe(false);
  });

  it('unknown pixelsPerBp (null / non-finite) → nucleotide flags false, tier still computed', () => {
    expect(lodTierForViewport({ visibleBp: 1000, pixelsPerBp: null }).renderNucleotides).toBe(
      false
    );
    expect(lodTierForViewport({ visibleBp: 1000, pixelsPerBp: null }).tier).toBe('detail');
    expect(lodTierForViewport({ visibleBp: 1000, pixelsPerBp: Number.NaN }).streamNucleotides).toBe(
      false
    );
  });

  it('base-level zoom (≥1 px/bp) renders and streams nucleotides in the DETAIL tier', () => {
    const d = lodTierForViewport({ visibleBp: 1500, pixelsPerBp: 1 });
    expect(d.tier).toBe('detail');
    expect(d.fetchAnnotationTile).toBe(true);
    expect(d.streamNucleotides).toBe(true);
    expect(d.renderNucleotides).toBe(true);
  });

  it('keeps one compiled resident owner across the former 512 kb page boundary', () => {
    const compiledBroadSurface = {
      broadCorridorFinestSpanBp: 16_000_000,
      viewportCssWidthPx: 1166,
      devicePixelRatio: 2,
      residentSceneCoversViewport: true,
    } as const;
    const representationAt = (visibleBp: number) =>
      lodTierForViewport({
        visibleBp,
        pixelsPerBp: compiledBroadSurface.viewportCssWidthPx / visibleBp,
        compiledBroadSurface,
      }).annotationRepresentation;

    expect(representationAt(72_875_001)).toBe('compiled-broad');
    expect(representationAt(72_874_999)).toBe('compiled-resident-scene');
    expect(representationAt(524_289)).toBe('compiled-resident-scene');
    expect(representationAt(524_288)).toBe('compiled-resident-scene');
    expect(representationAt(400)).toBe('compiled-resident-scene');
    expect(
      lodTierForViewport({
        visibleBp: 400,
        pixelsPerBp: compiledBroadSurface.viewportCssWidthPx / 400,
        compiledBroadSurface,
      })
    ).toMatchObject({
      fetchAnnotationTile: false,
      fetchCodonCarrierPages: true,
      prefetchCodonCarrierPages: true,
      streamNucleotides: true,
      renderNucleotides: true,
    });
  });

  it('derives the broad boundary from physical width instead of a hard-coded bp span', () => {
    const compiledBroadSurface = {
      broadCorridorFinestSpanBp: 16_000_000,
      viewportCssWidthPx: 800,
      devicePixelRatio: 3,
      residentSceneCoversViewport: true,
    } as const;
    const representationAt = (visibleBp: number) =>
      lodTierForViewport({
        visibleBp,
        pixelsPerBp: compiledBroadSurface.viewportCssWidthPx / visibleBp,
        compiledBroadSurface,
      }).annotationRepresentation;

    expect(representationAt(75_000_001)).toBe('compiled-broad');
    expect(representationAt(74_999_999)).toBe('compiled-resident-scene');
  });

  it('holds the last compiled frame without reviving legacy pages while exact coverage catches up', () => {
    const decision = lodTierForViewport({
      visibleBp: 3_136_321,
      pixelsPerBp: 1166 / 3_136_321,
      compiledBroadSurface: {
        broadCorridorFinestSpanBp: 16_000_000,
        viewportCssWidthPx: 1166,
        devicePixelRatio: 2,
        residentSceneCoversViewport: false,
      },
    });

    expect(decision.annotationRepresentation).toBe('compiled-transition-hold');
    expect(decision.fetchAnnotationTile).toBe(false);
    expect(decision.fetchCodonCarrierPages).toBe(false);
  });
});

describe('annotationRoutingRedriveGeneration', () => {
  it('cannot consume an ownership generation before a real viewport publication exists', () => {
    expect(
      annotationRoutingRedriveGeneration({
        routingEnabled: true,
        sourceScopeKey: 'source-scope',
        routerStreamKey: 'router-stream',
        viewportPublicationKey: null,
        residentSceneCoversViewport: false,
      })
    ).toBeNull();
  });

  it('binds one dispatch to the exact source, router stream, viewport publication, and owner state', () => {
    const pending = annotationRoutingRedriveGeneration({
      routingEnabled: true,
      sourceScopeKey: 'source-scope-a',
      routerStreamKey: 'router-stream-a',
      viewportPublicationKey: 'viewport-a',
      residentSceneCoversViewport: false,
    });
    const ready = annotationRoutingRedriveGeneration({
      routingEnabled: true,
      sourceScopeKey: 'source-scope-a',
      routerStreamKey: 'router-stream-a',
      viewportPublicationKey: 'viewport-a',
      residentSceneCoversViewport: true,
    });
    const moved = annotationRoutingRedriveGeneration({
      routingEnabled: true,
      sourceScopeKey: 'source-scope-a',
      routerStreamKey: 'router-stream-a',
      viewportPublicationKey: 'viewport-b',
      residentSceneCoversViewport: true,
    });

    expect(pending).not.toBeNull();
    expect(ready).not.toBe(pending);
    expect(moved).not.toBe(ready);
  });
});

describe('compiledViewportDetailRosterCoversViewportV1', () => {
  it('rejects a loaded packet roster that covers the previous chromosome', () => {
    expect(
      compiledViewportDetailRosterCoversViewportV1({
        selectedSetPrepared: true,
        viewport: { start: 2_834_183_054, end: 2_869_183_054 },
        tracks: [
          { status: 'loaded', coverageStartBp: 1_610_612_736, coverageEndBp: 1_750_612_736 },
          { status: 'loaded', coverageStartBp: 1_610_612_736, coverageEndBp: 1_750_612_736 },
        ],
      })
    ).toBe(false);
  });

  it('accepts only a complete selected roster whose admitted ranges cover the viewport', () => {
    const input = {
      selectedSetPrepared: true,
      viewport: { start: 2_834_183_054, end: 2_869_183_054 },
      tracks: [
        { status: 'loaded', coverageStartBp: 2_768_240_640, coverageEndBp: 2_908_240_640 },
        { status: 'loaded', coverageStartBp: 2_768_240_640, coverageEndBp: 2_908_240_640 },
      ],
    } as const;
    expect(compiledViewportDetailRosterCoversViewportV1(input)).toBe(true);
    expect(
      compiledViewportDetailRosterCoversViewportV1({
        ...input,
        tracks: [input.tracks[0], { ...input.tracks[1], status: 'loading' }],
      })
    ).toBe(false);
  });
});

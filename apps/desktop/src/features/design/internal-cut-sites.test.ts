// @vitest-environment node

import { describe, expect, it } from 'vitest';
import type { DesignRegion, DesignSpacer, SequenceDesign } from './types';
import { deriveAssemblyIssues } from '../assembly/issues/assembly-issues';
import { INTERNAL_CUT_SITE_STYLE } from '@waypoint/sequence-utils';
import {
  collectInternalCutSiteMarkers,
  internalCutSiteMarkersToColoredCutSites,
  markerHighlightRange,
  markerScrollPosition,
  regionComposedOffsets,
  stepCutSiteIndex,
} from './internal-cut-sites';

function pcrRegion(id: string, sequence: string): DesignRegion {
  return {
    id,
    sourceSequenceId: `source-${id}`,
    sourceSequenceName: id,
    sourceStart: 0,
    sourceEnd: sequence.length,
    sequence,
    annotations: [],
    sourceType: 'pcr',
  };
}

function goldenGateDesign(regions: DesignRegion[], spacers: DesignSpacer[] = []): SequenceDesign {
  const now = new Date('2026-06-20T00:00:00.000Z');
  return {
    id: 'design-1',
    name: 'fixture',
    topology: 'linear',
    regions,
    spacers,
    version: 1,
    assemblyState: 'ready',
    validationErrors: [],
    proposedPlans: [],
    status: 'computed',
    assemblyMethod: 'goldengate',
    backboneSequenceId: null,
    defaultHomologyLength: 30,
    homologyRegions: [],
    goldenGateConfig: { enzyme: 'BsaI' },
    goldenGateJunctions: [],
    designPrimers: [],
    selectedJunctionIndex: null,
    scrollToPosition: null,
    highlightRange: null,
    createdAt: now,
    updatedAt: now,
  };
}

describe('regionComposedOffsets  #10 coordinate contract)', () => {
  it('maps region id → composed 0-indexed start, accounting for spacers', () => {
    const r0 = pcrRegion('r0', 'A'.repeat(10));
    const r1 = pcrRegion('r1', 'C'.repeat(8));
    const spacer: DesignSpacer = { id: 's0', junctionIndex: 0, sequence: 'TTT' };
    const offsets = regionComposedOffsets(goldenGateDesign([r0, r1], [spacer]));

    expect(offsets.get('r0')).toBe(0);
    expect(offsets.get('r1')).toBe(13);
  });

  it('has no spacer drift when there are no spacers', () => {
    const offsets = regionComposedOffsets(
      goldenGateDesign([pcrRegion('r0', 'AAAAA'), pcrRegion('r1', 'CC'), pcrRegion('r2', 'GGG')])
    );
    expect([offsets.get('r0'), offsets.get('r1'), offsets.get('r2')]).toEqual([0, 5, 7]);
  });
});

describe('collectInternalCutSiteMarkers  #8 → #10)', () => {
  it('projects region-local footprints into composed coordinates past a spacer', () => {
    const r0 = pcrRegion('r0', 'A'.repeat(10));
    const r1 = pcrRegion('r1', 'AAAAGGTCTCAAAA');
    const spacer: DesignSpacer = { id: 's0', junctionIndex: 0, sequence: 'TTT' };
    const design = goldenGateDesign([r0, r1], [spacer]);

    const markers = collectInternalCutSiteMarkers(design, deriveAssemblyIssues({ design }));

    expect(markers).toEqual([
      {
        id: 'internal-cut-site:r1:4:forward',
        regionId: 'r1',
        start: 17,
        end: 23,
        strand: 'forward',
      },
    ]);
  });

  it('returns an empty list when there are no internal sites', () => {
    const design = goldenGateDesign([pcrRegion('r0', 'GCTAGCTAGCTA')]);
    expect(collectInternalCutSiteMarkers(design, deriveAssemblyIssues({ design }))).toEqual([]);
  });

  it('sorts markers by composed start across regions', () => {
    const r0 = pcrRegion('r0', 'GGTCTCAAAA');
    const r1 = pcrRegion('r1', 'AAAAAAGGTCTC');
    const design = goldenGateDesign([r0, r1]);
    const markers = collectInternalCutSiteMarkers(design, deriveAssemblyIssues({ design }));
    expect(markers.map((m) => m.start)).toEqual([0, 16]);
  });
});

describe('coordinate-contract converters  codex #2)', () => {
  const marker = { id: 'm', regionId: 'r', start: 17, end: 23, strand: 'forward' as const };

  it('scrollToPosition is 1-indexed footprint start', () => {
    expect(markerScrollPosition(marker)).toBe(18);
  });

  it('highlightRange is 0-indexed inclusive, non-wrapping', () => {
    expect(markerHighlightRange(marker)).toEqual({ start: 17, end: 22, wraps: false });
  });
});

describe('internalCutSiteMarkersToColoredCutSites  #10, T7)', () => {
  const BSAI_GEOM = { cutPositionTop: 7, cutPositionBottom: 11 };

  it('projects a forward marker with the REAL Type IIS cut downstream of the footprint', () => {
    const sites = internalCutSiteMarkersToColoredCutSites(
      [{ id: 'm0', regionId: 'r0', start: 17, end: 23, strand: 'forward' }],
      'BsaI',
      'GGTCTC',
      BSAI_GEOM
    );
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({
      cutPositionTop: 24,
      cutPositionBottom: 28,
      recognitionStart: 17,
      recognitionEnd: 23,
      strand: 'forward',
      color: INTERNAL_CUT_SITE_STYLE.colorHex,
      isInternalCutSite: true,
    });
    expect(sites[0].enzyme.name).toBe('BsaI');
    expect(sites[0].enzyme.recognition_sequence).toBe('GGTCTC');
    expect(sites[0].enzyme.cut_position_top).toBe(7);
    expect(sites[0].enzyme.cut_position_bottom).toBe(11);
  });

  it('mirrors the cut UPSTREAM for a reverse-strand marker (matches findCutSites)', () => {
    const sites = internalCutSiteMarkersToColoredCutSites(
      [{ id: 'm1', regionId: 'r0', start: 17, end: 23, strand: 'reverse' }],
      'BsaI',
      'GGTCTC',
      BSAI_GEOM
    );
    expect(sites[0]).toMatchObject({
      cutPositionTop: 12,
      cutPositionBottom: 16,
      recognitionStart: 17,
      recognitionEnd: 23,
      strand: 'reverse',
      isInternalCutSite: true,
    });
  });

  it('produces a non-degenerate sticky-end jog (cutPositionTop ≠ cutPositionBottom)', () => {
    const [site] = internalCutSiteMarkersToColoredCutSites(
      [{ id: 'm2', regionId: 'r0', start: 5, end: 11, strand: 'forward' }],
      'BsaI',
      'GGTCTC',
      BSAI_GEOM
    );
    expect(site.cutPositionBottom - site.cutPositionTop).toBe(4);
  });
});

describe('stepCutSiteIndex  #10 stepper, T4)', () => {
  it('is inert (null) for an empty list', () => {
    expect(stepCutSiteIndex(0, null, 'next')).toBeNull();
    expect(stepCutSiteIndex(0, 0, 'prev')).toBeNull();
  });

  it('starts at the first site on next, the last on prev from null', () => {
    expect(stepCutSiteIndex(3, null, 'next')).toBe(0);
    expect(stepCutSiteIndex(3, null, 'prev')).toBe(2);
  });

  it('wraps at both ends', () => {
    expect(stepCutSiteIndex(3, 2, 'next')).toBe(0);
    expect(stepCutSiteIndex(3, 0, 'prev')).toBe(2);
    expect(stepCutSiteIndex(3, 1, 'next')).toBe(2);
    expect(stepCutSiteIndex(3, 1, 'prev')).toBe(0);
  });

  it('recovers from an out-of-range index', () => {
    expect(stepCutSiteIndex(2, 5, 'next')).toBe(0);
    expect(stepCutSiteIndex(2, -1, 'prev')).toBe(1);
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { useDesignStore } from './store';
import type { DesignRegion, SequenceDesign } from './types';

function pcrRegion(id: string, sequence: string): DesignRegion {
  return {
    id,
    sourceSequenceId: `src-${id}`,
    sourceSequenceName: id,
    sourceStart: 0,
    sourceEnd: sequence.length,
    sequence,
    annotations: [],
    sourceType: 'pcr',
  };
}

function ggDesign(id: string, regions: DesignRegion[]): SequenceDesign {
  const now = new Date('2026-06-20T00:00:00.000Z');
  return {
    id,
    name: 'fixture',
    topology: 'linear',
    regions,
    spacers: [],
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

function load(design: SequenceDesign) {
  useDesignStore.setState({ designs: { [design.id]: design }, activeDesignId: design.id });
}
const get = (id: string) => useDesignStore.getState().designs[id];

describe('design-store internal cut-site stepper  T4)', () => {
  beforeEach(() => {
    useDesignStore.setState({ designs: {}, activeDesignId: null });
  });

  it('steps next/prev with wraparound and drives scroll + highlight per the coordinate contract', () => {
    load(ggDesign('d1', [pcrRegion('r0', 'GGTCTCAAAA'), pcrRegion('r1', 'AAAAAAGGTCTC')]));
    const { stepInternalCutSite } = useDesignStore.getState();

    stepInternalCutSite('d1', 'next');
    expect(get('d1').activeCutSiteIndex).toBe(0);
    expect(get('d1').scrollToPosition).toBe(1);
    expect(get('d1').highlightRange).toEqual({ start: 0, end: 5, wraps: false });

    stepInternalCutSite('d1', 'next');
    expect(get('d1').activeCutSiteIndex).toBe(1);
    expect(get('d1').scrollToPosition).toBe(17);
    expect(get('d1').highlightRange).toEqual({ start: 16, end: 21, wraps: false });

    stepInternalCutSite('d1', 'next');
    expect(get('d1').activeCutSiteIndex).toBe(0);

    stepInternalCutSite('d1', 'prev');
    expect(get('d1').activeCutSiteIndex).toBe(1);
  });

  it('goToInternalCutSite jumps to a specific (clamped) index', () => {
    load(ggDesign('d2', [pcrRegion('r0', 'GGTCTCAAAA'), pcrRegion('r1', 'AAAAAAGGTCTC')]));
    useDesignStore.getState().goToInternalCutSite('d2', 1);
    expect(get('d2').activeCutSiteIndex).toBe(1);
    useDesignStore.getState().goToInternalCutSite('d2', 99);
    expect(get('d2').activeCutSiteIndex).toBe(1);
  });

  it('is a no-op when the design has no internal cut sites', () => {
    load(ggDesign('d3', [pcrRegion('r0', 'GCTAGCTAGCTA')]));
    useDesignStore.getState().stepInternalCutSite('d3', 'next');
    expect(get('d3').activeCutSiteIndex ?? null).toBeNull();
    expect(get('d3').scrollToPosition).toBeNull();
  });

  it('setHoveredCutSiteRegion sets and clears the hovered region  #10, T8)', () => {
    load(ggDesign('d4', [pcrRegion('r0', 'GGTCTCAAAA')]));
    useDesignStore.getState().setHoveredCutSiteRegion('d4', 'r0');
    expect(get('d4').hoveredCutSiteRegionId).toBe('r0');
    useDesignStore.getState().setHoveredCutSiteRegion('d4', null);
    expect(get('d4').hoveredCutSiteRegionId).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { computeDraftAssembly, reverseComplement } from './algorithms/draft-assembly';
import { describeDesignAssemblyState } from './assembly-debug';
import { useDesignStore } from './store';
import type { DesignRegion, SequenceDesign } from './types';

function makePcrRegion(id: string, sequence: string): DesignRegion {
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

function makeRdRegion(
  id: string,
  sequence: string,
  upstream: string,
  downstream: string,
  overrides: Partial<DesignRegion> = {}
): DesignRegion {
  return {
    id,
    sourceSequenceId: `source-${id}`,
    sourceSequenceName: id,
    sourceStart: 0,
    sourceEnd: sequence.length,
    sequence,
    annotations: [],
    sourceType: 'rd',
    ggType: 'insert',
    rdOverhangs: { upstream, downstream },
    rdSourceEnzyme: 'BsaI',
    ...overrides,
  };
}

function makeGoldenGateDesign(regions: DesignRegion[]): SequenceDesign {
  const baseDesign: SequenceDesign = {
    id: 'hybrid-design',
    name: 'Hybrid GoldenGate fixture',
    topology: 'circular',
    regions,
    spacers: [],
    version: 1,
    assemblyState: 'drafting',
    validationErrors: [],
    proposedPlans: [],
    status: 'draft',
    assemblyMethod: 'goldengate',
    defaultHomologyLength: 30,
    homologyRegions: [],
    goldenGateConfig: { enzyme: 'BsaI' },
    designPrimers: [],
    selectedJunctionIndex: null,
    scrollToPosition: null,
    highlightRange: null,
    createdAt: new Date('2026-04-27T00:00:00Z'),
    updatedAt: new Date('2026-04-27T00:00:00Z'),
  };
  const drafted = computeDraftAssembly(baseDesign);
  return {
    ...baseDesign,
    designPrimers: drafted.designPrimers,
    goldenGateJunctions: drafted.goldenGateJunctions,
    status: 'computed',
    assemblyState: 'ready',
  };
}

function makeHomologyDesign(
  regions: DesignRegion[],
  assemblyMethod: 'gibson' | 'nebuilder',
  topology: SequenceDesign['topology'] = 'circular'
): SequenceDesign {
  const baseDesign: SequenceDesign = {
    id: `${assemblyMethod}-hybrid-design`,
    name: `Hybrid ${assemblyMethod} fixture`,
    topology,
    regions,
    spacers: [],
    version: 1,
    assemblyState: 'drafting',
    validationErrors: [],
    proposedPlans: [],
    status: 'draft',
    assemblyMethod,
    defaultHomologyLength: 30,
    homologyRegions: [],
    designPrimers: [],
    selectedJunctionIndex: null,
    scrollToPosition: null,
    highlightRange: null,
    createdAt: new Date('2026-04-27T00:00:00Z'),
    updatedAt: new Date('2026-04-27T00:00:00Z'),
  };
  const drafted = computeDraftAssembly(baseDesign);
  return {
    ...baseDesign,
    homologyRegions: drafted.homologyRegions,
    designPrimers: drafted.designPrimers,
    status: 'computed',
    assemblyState: 'ready',
  };
}

describe('describeDesignAssemblyState', () => {
  it('captures a hybrid RD/PCR/RD GoldenGate design including hidden hybrid offset controls', () => {
    const leftRd = makeRdRegion('left-rd', 'GGACCCCCAATG', 'GGAC', 'AATG');
    const pcr = makePcrRegion('pcr-insert', 'AATGGGTTACCGATCGATCGATCGATCG');
    const rightRd = makeRdRegion('right-rd', 'CCTAGGGGCCCCGGAC', 'CCTA', 'GGAC');
    const design = makeGoldenGateDesign([leftRd, pcr, rightRd]);

    const snapshot = describeDesignAssemblyState(design);

    expect(snapshot.usedStoredDraft).toBe(true);
    expect(snapshot.regions.map((region) => region.sourceType)).toEqual(['rd', 'pcr', 'rd']);
    expect(snapshot.goldenGate?.junctions).toHaveLength(3);

    const [leftHybrid, rightHybrid, rdFixed] = snapshot.goldenGate!.junctions;

    expect(leftHybrid).toMatchObject({
      junctionIndex: 0,
      leftRegionSourceType: 'rd',
      rightRegionSourceType: 'pcr',
      sourceType: 'pcr-matched-rd',
      matchedRegionIndex: 0,
      fixedRdEnd: 'left-downstream',
      hasPcrSide: true,
      offset: 2,
      overhang: 'AATG',
      composedWindowAtOffset: 'AATG',
      fixedOverhangMatchesComposedWindow: true,
      offsetControl: {
        visibleWithCurrentUiRule: false,
        hiddenReason: 'rd-adjacent-ui-rule',
        updateWouldRecomputeFixedOverhang: true,
      },
    });

    expect(rightHybrid).toMatchObject({
      junctionIndex: 1,
      leftRegionSourceType: 'pcr',
      rightRegionSourceType: 'rd',
      sourceType: 'pcr-matched-rd',
      matchedRegionIndex: 2,
      fixedRdEnd: 'right-upstream',
      hasPcrSide: true,
      offset: 2,
      overhang: 'CCTA',
      composedWindowAtOffset: 'CCTA',
      fixedOverhangMatchesComposedWindow: true,
      offsetControl: {
        visibleWithCurrentUiRule: false,
        hiddenReason: 'rd-adjacent-ui-rule',
        updateWouldRecomputeFixedOverhang: true,
      },
    });

    expect(rdFixed).toMatchObject({
      junctionIndex: 2,
      leftRegionSourceType: 'rd',
      rightRegionSourceType: 'rd',
      sourceType: 'rd-fixed',
      fixedRdEnd: 'both',
      hasPcrSide: false,
      overhang: 'GGAC',
      offsetControl: {
        visibleWithCurrentUiRule: false,
        hiddenReason: 'rd-fixed',
        updateWouldRecomputeFixedOverhang: true,
      },
    });

    const pcrPrimers = snapshot.goldenGate!.primerPairs.find((pair) => pair.fragmentIndex === 1);
    expect(pcrPrimers).toMatchObject({
      fragmentIndex: 1,
      regionSourceType: 'pcr',
      forward: {
        exists: true,
        junctionIndex: 0,
        tailOverhang: 'AATG',
      },
      reverse: {
        exists: true,
        junctionIndex: 1,
        tailOverhang: 'TAGG',
      },
    });

    const rdPrimers = snapshot.goldenGate!.primerPairs.filter(
      (pair) => pair.regionSourceType === 'rd'
    );
    expect(rdPrimers.every((pair) => !pair.forward.exists && !pair.reverse.exists)).toBe(true);
  });

  it('keeps the PCR/PCR junction editable in a mixed RD/PCR/PCR design', () => {
    const rd = makeRdRegion('rd-fragment', 'TCCGAAAAGGAC', 'TCCG', 'GGAC');
    const pcrA = makePcrRegion('pcr-a', 'ATGCGTACGATCGTACGATC');
    const pcrB = makePcrRegion('pcr-b', 'CAGTTACCGGTACGATCGTA');
    const design = makeGoldenGateDesign([rd, pcrA, pcrB]);

    const snapshot = describeDesignAssemblyState(design);
    const junctions = snapshot.goldenGate!.junctions;

    expect(junctions[0]).toMatchObject({
      sourceType: 'pcr-matched-rd',
      fixedRdEnd: 'left-downstream',
      offsetControl: {
        visibleWithCurrentUiRule: false,
        hiddenReason: 'rd-adjacent-ui-rule',
      },
    });
    expect(junctions[1]).toMatchObject({
      leftRegionSourceType: 'pcr',
      rightRegionSourceType: 'pcr',
      sourceType: 'pcr-designed',
      hasPcrSide: true,
      offset: 0,
      offsetControl: {
        visibleWithCurrentUiRule: true,
        updateWouldRecomputeFixedOverhang: false,
      },
    });
    expect(junctions[2]).toMatchObject({
      sourceType: 'pcr-matched-rd',
      fixedRdEnd: 'right-upstream',
      offsetControl: {
        visibleWithCurrentUiRule: false,
        hiddenReason: 'rd-adjacent-ui-rule',
      },
    });
  });

  it('refuses legacy offset updates for hybrid RD/PCR Golden Gate junctions', () => {
    const leftRd = makeRdRegion('left-rd', 'GGACCCCCAATG', 'GGAC', 'AATG');
    const pcr = makePcrRegion('pcr-insert', 'AATGGGTTACCGATCGATCGATCGATCG');
    const rightRd = makeRdRegion('right-rd', 'CCTAGGGGCCCCGGAC', 'CCTA', 'GGAC');
    const design = makeGoldenGateDesign([leftRd, pcr, rightRd]);
    const before = describeDesignAssemblyState(design);

    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
      pendingDispatchId: null,
    });

    useDesignStore.getState().updateGoldenGateOffset(design.id, 0, 0);

    const after = describeDesignAssemblyState(useDesignStore.getState().designs[design.id]);
    const updatedHybrid = after.goldenGate!.junctions[0];

    expect(updatedHybrid).toMatchObject({
      sourceType: 'pcr-matched-rd',
      fixedRdEnd: 'left-downstream',
      offset: before.goldenGate!.junctions[0].offset,
      overhang: 'AATG',
      fixedOverhangMatchesComposedWindow: true,
    });
    expect(after.goldenGate!.junctions).toEqual(before.goldenGate!.junctions);
    expect(leftRd.rdOverhangs?.downstream).toBe('AATG');
  });

  it('captures which PCR primers carry each overlap in a mixed Gibson assembly', () => {
    const rd = makeRdRegion('rd-fragment', 'GGAC' + 'ATGC'.repeat(24) + 'AATG', 'GGAC', 'AATG');
    const pcrA = makePcrRegion('pcr-a', 'TGCAGGTTACCGATCGATCGATCGATCG'.repeat(2));
    const pcrB = makePcrRegion('pcr-b', 'CAGTTACCGGTACGATCGTAGGTTAC'.repeat(2));
    const design = makeHomologyDesign([rd, pcrA, pcrB], 'gibson');

    const snapshot = describeDesignAssemblyState(design);
    const junctions = snapshot.homology!.junctions;

    expect(snapshot.homology?.method).toBe('gibson');
    expect(snapshot.regions.map((region) => region.sourceType)).toEqual(['rd', 'pcr', 'pcr']);
    expect(snapshot.homology?.primerPairs.map((pair) => pair.fragmentIndex)).toEqual([1, 2]);

    const rdToPcr = junctions[0];
    expect(rdToPcr).toMatchObject({
      encodingMode: 'rd-to-pcr',
      encoding: { onLeft: rdToPcr.length, onRight: 0 },
      leftReversePrimerTail: null,
      rightForwardPrimerTail: rdToPcr.sequence,
    });
    expect(rdToPcr.sequence).toBe(rd.sequence.slice(-rdToPcr.length));

    const pcrToPcr = junctions[1];
    expect(pcrToPcr.encodingMode).toBe('pcr-to-pcr');
    expect(pcrToPcr.encoding.onLeft).toBeGreaterThan(0);
    expect(pcrToPcr.encoding.onRight).toBeGreaterThan(0);
    expect(pcrToPcr.leftReversePrimerTail).toBeTruthy();
    expect(pcrToPcr.rightForwardPrimerTail).toBeTruthy();

    const pcrToRd = junctions[2];
    expect(pcrToRd).toMatchObject({
      encodingMode: 'pcr-to-rd',
      encoding: { onLeft: 0, onRight: pcrToRd.length },
      leftReversePrimerTail: reverseComplement(pcrToRd.sequence),
      rightForwardPrimerTail: null,
    });
    expect(pcrToRd.sequence).toBe(rd.sequence.slice(0, pcrToRd.length));
  });

  it('captures NEBuilder effective RD sequence after selected end resection', () => {
    const rd = makeRdRegion('rd-left', 'GGAC' + 'GCTA'.repeat(18) + 'AAAAACTGCA', 'GGAC', 'TGCA', {
      rdEnds: {
        downstream: {
          retainedScarSequence: 'CTGCA',
          retainedScarLength: 5,
          nebuilderResectionBases: 10,
        },
      },
    });
    const pcr = makePcrRegion('pcr-right', 'CGTA'.repeat(30));
    const design = makeHomologyDesign([rd, pcr], 'nebuilder', 'linear');

    const snapshot = describeDesignAssemblyState(design);
    const effectiveRd = rd.sequence.slice(0, -10);
    const junction = snapshot.homology!.junctions[0];

    expect(snapshot.homology?.method).toBe('nebuilder');
    expect(snapshot.regions[0]).toMatchObject({
      sourceType: 'rd',
      length: rd.sequence.length,
      effectiveLength: effectiveRd.length,
      effectiveSequence: effectiveRd,
    });
    expect(junction).toMatchObject({
      encodingMode: 'rd-to-pcr',
      encoding: { onLeft: junction.length, onRight: 0 },
      rightForwardPrimerTail: junction.sequence,
    });
    expect(junction.sequence).toBe(effectiveRd.slice(-junction.length));
    expect(junction.sequence).not.toBe(rd.sequence.slice(-junction.length));
  });
});

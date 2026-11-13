import { computeDraftAssembly } from './algorithms/draft-assembly';
import type {
  DesignPrimer,
  DesignPrimerPair,
  DesignRegion,
  GoldenGateJunction,
  HomologyEncoding,
  HomologyRegion,
  SequenceDesign,
} from './types';
import { getComposedSequence } from './types';
import { getEffectiveDesignRegions } from './restriction-digest';

export interface AssemblyRegionDebugSnapshot {
  index: number;
  id: string;
  sourceSequenceId: string;
  sourceSequenceName: string;
  sourceType: 'pcr' | 'rd';
  sourceStart: number;
  sourceEnd: number;
  length: number;
  effectiveLength?: number;
  effectiveSequence?: string;
  annotationCount: number;
  ggType?: DesignRegion['ggType'];
  rdOverhangs?: DesignRegion['rdOverhangs'];
  rdSourceEnzyme?: DesignRegion['rdSourceEnzyme'];
  rdSourceEnzymeName?: DesignRegion['rdSourceEnzymeName'];
  rdEnds?: DesignRegion['rdEnds'];
  rdSiblingOverhangs?: string[];
}

export interface GoldenGatePrimerDebugSnapshot {
  exists: boolean;
  direction: DesignPrimer['direction'];
  junctionIndex: number | null;
  pbsStart: number;
  pbsEnd: number;
  pbsLength: number;
  pbsSequence: string;
  tailOverhang?: string;
  literalExtra?: string;
  fullTail?: string;
  fullPrimer?: string;
  tm?: number;
  cognate4bpLength?: number;
  synthetic4bpSpacerLength?: number;
}

export interface GoldenGatePrimerPairDebugSnapshot {
  fragmentIndex: number;
  regionSourceType: 'pcr' | 'rd';
  forward: GoldenGatePrimerDebugSnapshot;
  reverse: GoldenGatePrimerDebugSnapshot;
}

export interface HomologyPrimerDebugSnapshot {
  exists: boolean;
  direction: DesignPrimer['direction'];
  junctionIndex: number | null;
  pbsStart: number;
  pbsEnd: number;
  pbsLength: number;
  pbsSequence: string;
  annealingLength: number;
  overhangLength: number;
  overhangSequence: string;
  spacerSequence?: string;
  fullPrimer?: string;
  tm?: number;
}

export interface HomologyPrimerPairDebugSnapshot {
  fragmentIndex: number;
  regionSourceType: 'pcr' | 'rd';
  forward: HomologyPrimerDebugSnapshot;
  reverse: HomologyPrimerDebugSnapshot;
}

export interface GoldenGateJunctionDebugSnapshot {
  junctionIndex: number;
  leftRegionIndex: number;
  rightRegionIndex: number;
  leftRegionSourceType: 'pcr' | 'rd';
  rightRegionSourceType: 'pcr' | 'rd';
  sourceType: GoldenGateJunction['source']['type'];
  matchedRegionIndex?: number;
  fixedRdEnd?: 'left-downstream' | 'right-upstream' | 'both';
  hasPcrSide: boolean;
  junctionPosition: number;
  offset: number;
  overhangStart: number;
  overhangEnd: number;
  overhang: string;
  composedWindowAtOffset: string;
  fixedOverhangMatchesComposedWindow: boolean | null;
  isValid: boolean;
  validationError?: string;
  offsetControl: {
    visibleWithCurrentUiRule: boolean;
    hiddenReason?: 'rd-fixed' | 'rd-adjacent-ui-rule';
    updateWouldRecomputeFixedOverhang: boolean;
  };
}

export interface HomologyJunctionDebugSnapshot {
  junctionIndex: number;
  leftRegionIndex: number;
  rightRegionIndex: number;
  leftRegionSourceType: 'pcr' | 'rd';
  rightRegionSourceType: 'pcr' | 'rd';
  junctionPosition: number;
  start: number;
  end: number;
  length: number;
  sequence: string;
  encoding: HomologyEncoding;
  encodingMode: 'rd-to-pcr' | 'pcr-to-rd' | 'pcr-to-pcr' | 'rd-to-rd';
  tmEstimate?: number;
  gcContent?: number;
  leftReversePrimerTail: string | null;
  rightForwardPrimerTail: string | null;
}

export interface AssemblyDebugSnapshot {
  designId: string;
  name: string;
  assemblyMethod: SequenceDesign['assemblyMethod'];
  topology: SequenceDesign['topology'];
  assemblyState: SequenceDesign['assemblyState'];
  status?: SequenceDesign['status'];
  version: number;
  regionCount: number;
  spacerCount: number;
  composedLength: number;
  composedSequence: string;
  usedStoredDraft: boolean;
  regions: AssemblyRegionDebugSnapshot[];
  goldenGate?: {
    enzyme: string;
    junctions: GoldenGateJunctionDebugSnapshot[];
    primerPairs: GoldenGatePrimerPairDebugSnapshot[];
  };
  homology?: {
    method: 'gibson' | 'nebuilder';
    junctions: HomologyJunctionDebugSnapshot[];
    primerPairs: HomologyPrimerPairDebugSnapshot[];
  };
}

function normalizeSourceType(region: DesignRegion | undefined): 'pcr' | 'rd' {
  return region?.sourceType === 'rd' || !!region?.rdOverhangs ? 'rd' : 'pcr';
}

function readComposedWindow(sequence: string, start: number, length: number): string {
  if (!sequence || length <= 0) return '';

  let result = '';
  for (let i = 0; i < length; i++) {
    const idx = (((start + i) % sequence.length) + sequence.length) % sequence.length;
    result += sequence[idx] ?? '';
  }
  return result;
}

function summarizePrimer(primer: DesignPrimer): GoldenGatePrimerDebugSnapshot {
  const pbsLength = primer.pbs.end - primer.pbs.start;

  return {
    exists: primer.sequence.length > 0,
    direction: primer.direction,
    junctionIndex: primer.junctionIndex,
    pbsStart: primer.pbs.start,
    pbsEnd: primer.pbs.end,
    pbsLength,
    pbsSequence: primer.pbs.sequence,
    tailOverhang: primer.goldenGateOverhang?.overhang,
    literalExtra: primer.goldenGateOverhang?.literalExtra,
    fullTail: primer.goldenGateOverhang?.fullSequence,
    fullPrimer: primer.sequence,
    tm: primer.tm,
    cognate4bpLength: primer.cognate4bpLength,
    synthetic4bpSpacerLength: primer.synthetic4bpSpacerLength,
  };
}

function summarizePrimerPairs(
  regions: DesignRegion[],
  primerPairs: DesignPrimerPair[]
): GoldenGatePrimerPairDebugSnapshot[] {
  return primerPairs.map((pair) => ({
    fragmentIndex: pair.fragmentIndex,
    regionSourceType: normalizeSourceType(regions[pair.fragmentIndex]),
    forward: summarizePrimer(pair.forward),
    reverse: summarizePrimer(pair.reverse),
  }));
}

function summarizeHomologyPrimer(primer: DesignPrimer): HomologyPrimerDebugSnapshot {
  const pbsLength = primer.pbs.end - primer.pbs.start;

  return {
    exists: primer.sequence.length > 0,
    direction: primer.direction,
    junctionIndex: primer.junctionIndex,
    pbsStart: primer.pbs.start,
    pbsEnd: primer.pbs.end,
    pbsLength,
    pbsSequence: primer.pbs.sequence,
    annealingLength: primer.overhang.length,
    overhangLength: primer.overhang.tailLength ?? primer.overhang.sequence.length,
    overhangSequence: primer.overhang.sequence,
    spacerSequence: primer.overhang.spacerSequence,
    fullPrimer: primer.sequence,
    tm: primer.tm,
  };
}

function summarizeHomologyPrimerPairs(
  regions: DesignRegion[],
  primerPairs: DesignPrimerPair[]
): HomologyPrimerPairDebugSnapshot[] {
  return primerPairs.map((pair) => ({
    fragmentIndex: pair.fragmentIndex,
    regionSourceType: normalizeSourceType(regions[pair.fragmentIndex]),
    forward: summarizeHomologyPrimer(pair.forward),
    reverse: summarizeHomologyPrimer(pair.reverse),
  }));
}

function summarizeRegions(
  regions: DesignRegion[],
  effectiveRegions: DesignRegion[] = regions
): AssemblyRegionDebugSnapshot[] {
  return regions.map((region, index) => ({
    index,
    id: region.id,
    sourceSequenceId: region.sourceSequenceId,
    sourceSequenceName: region.sourceSequenceName,
    sourceType: normalizeSourceType(region),
    sourceStart: region.sourceStart,
    sourceEnd: region.sourceEnd,
    length: region.sequence.length,
    effectiveLength: effectiveRegions[index]?.sequence.length,
    effectiveSequence: effectiveRegions[index]?.sequence,
    annotationCount: region.annotations.length,
    ggType: region.ggType,
    rdOverhangs: region.rdOverhangs,
    rdSourceEnzyme: region.rdSourceEnzyme,
    rdSourceEnzymeName: region.rdSourceEnzymeName,
    rdEnds: region.rdEnds,
    rdSiblingOverhangs: region.rdSiblingOverhangs,
  }));
}

function fixedRdEndForJunction(
  junction: GoldenGateJunction,
  leftRegion: DesignRegion | undefined,
  rightRegion: DesignRegion | undefined,
  leftRegionIndex: number,
  rightRegionIndex: number
): GoldenGateJunctionDebugSnapshot['fixedRdEnd'] {
  if (junction.source.type === 'rd-fixed') {
    return 'both';
  }

  if (junction.source.type !== 'pcr-matched-rd') {
    return undefined;
  }

  if (junction.source.matchedRegionIndex === leftRegionIndex && leftRegion?.rdOverhangs) {
    return 'left-downstream';
  }

  if (junction.source.matchedRegionIndex === rightRegionIndex && rightRegion?.rdOverhangs) {
    return 'right-upstream';
  }

  return undefined;
}

function fixedOverhangForJunction(
  fixedRdEnd: GoldenGateJunctionDebugSnapshot['fixedRdEnd'],
  leftRegion: DesignRegion | undefined,
  rightRegion: DesignRegion | undefined,
  junction: GoldenGateJunction
): string | undefined {
  if (fixedRdEnd === 'left-downstream') {
    return leftRegion?.rdOverhangs?.downstream;
  }
  if (fixedRdEnd === 'right-upstream') {
    return rightRegion?.rdOverhangs?.upstream;
  }
  if (fixedRdEnd === 'both') {
    return leftRegion?.rdOverhangs?.downstream ?? rightRegion?.rdOverhangs?.upstream;
  }
  return junction.source.type === 'pcr-designed' ? undefined : junction.overhang;
}

function summarizeJunctions(
  design: SequenceDesign,
  junctions: GoldenGateJunction[],
  composedSequence: string
): GoldenGateJunctionDebugSnapshot[] {
  const numRegions = design.regions.length;

  return junctions.map((junction) => {
    const leftRegionIndex = junction.junctionIndex;
    const rightRegionIndex = (junction.junctionIndex + 1) % numRegions;
    const leftRegion = design.regions[leftRegionIndex];
    const rightRegion = design.regions[rightRegionIndex];
    const leftRegionSourceType = normalizeSourceType(leftRegion);
    const rightRegionSourceType = normalizeSourceType(rightRegion);
    const involvesRdFragment = leftRegionSourceType === 'rd' || rightRegionSourceType === 'rd';
    const fixedRdEnd = fixedRdEndForJunction(
      junction,
      leftRegion,
      rightRegion,
      leftRegionIndex,
      rightRegionIndex
    );
    const fixedOverhang = fixedOverhangForJunction(fixedRdEnd, leftRegion, rightRegion, junction);
    const composedWindowAtOffset = readComposedWindow(
      composedSequence,
      junction.overhangStart,
      junction.overhang.length
    );
    const isRdFixed = junction.source.type === 'rd-fixed';
    const hiddenReason = isRdFixed
      ? 'rd-fixed'
      : involvesRdFragment
        ? 'rd-adjacent-ui-rule'
        : undefined;

    return {
      junctionIndex: junction.junctionIndex,
      leftRegionIndex,
      rightRegionIndex,
      leftRegionSourceType,
      rightRegionSourceType,
      sourceType: junction.source.type,
      matchedRegionIndex:
        junction.source.type === 'pcr-matched-rd' ? junction.source.matchedRegionIndex : undefined,
      fixedRdEnd,
      hasPcrSide: leftRegionSourceType === 'pcr' || rightRegionSourceType === 'pcr',
      junctionPosition: junction.junctionPosition,
      offset: junction.offset,
      overhangStart: junction.overhangStart,
      overhangEnd: junction.overhangEnd,
      overhang: junction.overhang,
      composedWindowAtOffset,
      fixedOverhangMatchesComposedWindow: fixedOverhang
        ? fixedOverhang === composedWindowAtOffset
        : null,
      isValid: junction.isValid,
      validationError: junction.validationError,
      offsetControl: {
        visibleWithCurrentUiRule: !hiddenReason,
        hiddenReason,
        updateWouldRecomputeFixedOverhang: junction.source.type !== 'pcr-designed',
      },
    };
  });
}

function findPrimerPair(
  primerPairs: DesignPrimerPair[],
  fragmentIndex: number
): DesignPrimerPair | undefined {
  return primerPairs.find((pair) => pair.fragmentIndex === fragmentIndex);
}

function getHomologyEncodingMode(
  leftRegion: DesignRegion | undefined,
  rightRegion: DesignRegion | undefined
): HomologyJunctionDebugSnapshot['encodingMode'] {
  const leftType = normalizeSourceType(leftRegion);
  const rightType = normalizeSourceType(rightRegion);

  if (leftType === 'rd' && rightType === 'pcr') return 'rd-to-pcr';
  if (leftType === 'pcr' && rightType === 'rd') return 'pcr-to-rd';
  if (leftType === 'rd' && rightType === 'rd') return 'rd-to-rd';
  return 'pcr-to-pcr';
}

function summarizeHomologyJunctions(
  design: SequenceDesign,
  homologyRegions: HomologyRegion[],
  primerPairs: DesignPrimerPair[]
): HomologyJunctionDebugSnapshot[] {
  const numRegions = design.regions.length;

  return homologyRegions.map((homology) => {
    const leftRegionIndex = homology.junctionIndex;
    const rightRegionIndex = (homology.junctionIndex + 1) % numRegions;
    const leftRegion = design.regions[leftRegionIndex];
    const rightRegion = design.regions[rightRegionIndex];
    const leftPrimerPair = findPrimerPair(primerPairs, leftRegionIndex);
    const rightPrimerPair = findPrimerPair(primerPairs, rightRegionIndex);
    const leftReversePrimer =
      leftPrimerPair?.reverse.junctionIndex === homology.junctionIndex
        ? leftPrimerPair.reverse
        : undefined;
    const rightForwardPrimer =
      rightPrimerPair?.forward.junctionIndex === homology.junctionIndex
        ? rightPrimerPair.forward
        : undefined;

    return {
      junctionIndex: homology.junctionIndex,
      leftRegionIndex,
      rightRegionIndex,
      leftRegionSourceType: normalizeSourceType(leftRegion),
      rightRegionSourceType: normalizeSourceType(rightRegion),
      junctionPosition: homology.junctionPosition,
      start: homology.start,
      end: homology.end,
      length: homology.metadata?.sequence?.length ?? 0,
      sequence: homology.metadata?.sequence ?? '',
      encoding: homology.encoding,
      encodingMode: getHomologyEncodingMode(leftRegion, rightRegion),
      tmEstimate: homology.metadata?.tmEstimate,
      gcContent: homology.metadata?.gcContent,
      leftReversePrimerTail: leftReversePrimer?.overhang.sequence ?? null,
      rightForwardPrimerTail: rightForwardPrimer?.overhang.sequence ?? null,
    };
  });
}

export function describeDesignAssemblyState(design: SequenceDesign): AssemblyDebugSnapshot {
  const effectiveRegions = getEffectiveDesignRegions(design);
  const composedSequence = getComposedSequence(effectiveRegions, design.spacers);
  const computed = computeDraftAssembly(design);
  const usedStoredDraft =
    design.assemblyMethod === 'goldengate'
      ? (design.goldenGateJunctions?.length ?? 0) > 0 && design.designPrimers.length > 0
      : design.designPrimers.length > 0;

  const computedJunctions = computed.goldenGateJunctions ?? [];
  const junctions =
    design.assemblyMethod === 'goldengate'
      ? usedStoredDraft
        ? (design.goldenGateJunctions ?? computedJunctions)
        : computedJunctions
      : [];
  const primerPairs = usedStoredDraft ? design.designPrimers : computed.designPrimers;
  const homologyRegions =
    design.assemblyMethod !== 'goldengate'
      ? usedStoredDraft && design.homologyRegions.length > 0
        ? design.homologyRegions
        : computed.homologyRegions
      : [];

  return {
    designId: design.id,
    name: design.name,
    assemblyMethod: design.assemblyMethod,
    topology: design.topology,
    assemblyState: design.assemblyState,
    status: design.status,
    version: design.version,
    regionCount: design.regions.length,
    spacerCount: design.spacers.length,
    composedLength: composedSequence.length,
    composedSequence,
    usedStoredDraft,
    regions: summarizeRegions(design.regions, effectiveRegions),
    goldenGate:
      design.assemblyMethod === 'goldengate'
        ? {
            enzyme: design.goldenGateConfig?.enzyme ?? 'BsaI',
            junctions: summarizeJunctions(design, junctions, composedSequence),
            primerPairs: summarizePrimerPairs(design.regions, primerPairs),
          }
        : undefined,
    homology:
      design.assemblyMethod === 'gibson' || design.assemblyMethod === 'nebuilder'
        ? {
            method: design.assemblyMethod,
            junctions: summarizeHomologyJunctions(design, homologyRegions, primerPairs),
            primerPairs: summarizeHomologyPrimerPairs(design.regions, primerPairs),
          }
        : undefined,
  };
}

import { type UserMessage, userMessageWithValues, userMessageValue } from '@waypoint/user-messages';
import type { DesignRegion, GoldenGateEnzyme, RestrictionDigestEnd } from '../types';
import { ENZYME_SPECS } from '../types';
import { reverseComplement } from '../algorithms/draft-assembly';

const GOLDEN_GATE_CUT_GEOMETRY: Record<
  GoldenGateEnzyme,
  { cutPositionTop: number; cutPositionBottom: number; overhangLength: number }
> = {
  BsaI: { cutPositionTop: 7, cutPositionBottom: 11, overhangLength: 4 },
  BbsI: { cutPositionTop: 8, cutPositionBottom: 12, overhangLength: 4 },
  BsmBI: { cutPositionTop: 7, cutPositionBottom: 11, overhangLength: 4 },
  SapI: { cutPositionTop: 8, cutPositionBottom: 11, overhangLength: 3 },
};

export interface GoldenGateDigestFragmentLike {
  index: number;
  upstream: { sequence: string };
  downstream: { sequence: string };
}

export type OverhangConflictType =
  | 'duplicate'
  | 'mismatch'
  | 'self-ligation'
  | 'internal-site'
  | 'rd-enzyme-mismatch'
  | 'rd-enzyme-unknown'
  | 'rd-fragment-not-insert'
  | 'rd-cut-site-mismatch';

export interface InternalCutSite {
  start: number;
  end: number;
  strand: 'forward' | 'reverse';
}

export interface OverhangConflict {
  type: OverhangConflictType;
  overhang: string;
  message: string;
  involvedIndices: number[];
  internalSites?: InternalCutSite[];
  regionId?: string;
  regionIndex?: number;
  junctionIndex?: number;
  leftRegionId?: string;
  rightRegionId?: string;
  endName?: 'upstream' | 'downstream' | 'left' | 'right';
  expectedEnzyme?: GoldenGateEnzyme;
  actualEnzyme?: GoldenGateEnzyme | string | null;
  expectedRecognitionSequence?: string;
  actualRecognitionSequence?: string;
  expectedOverhang?: string;
  actualOverhang?: string;
  expectedCutGeometry?: string;
  actualCutGeometry?: string;
  mismatchReason?: string;
}

export type GoldenGateConflictSeverity = 'error' | 'warning';

export function goldenGateConflictSeverity(
  _type: OverhangConflictType
): GoldenGateConflictSeverity {
  return 'error';
}

export function goldenGateConflictTitle(type: OverhangConflictType): string {
  switch (type) {
    case 'internal-site':
      return 'Enzyme site inside this part';
    case 'mismatch':
      return 'RD overhang mismatch';
    case 'self-ligation':
      return 'Both ends have the same overhang';
    case 'duplicate':
      return 'Duplicate overhang conflict';
    case 'rd-enzyme-mismatch':
      return 'Incompatible RD enzyme';
    case 'rd-enzyme-unknown':
      return 'Unsupported RD fragment';
    case 'rd-fragment-not-insert':
      return "This part can't be used as an insert";
    case 'rd-cut-site-mismatch':
      return 'RD cut-site provenance mismatch';
    default:
      return 'Golden Gate validation issue';
  }
}

export interface FragmentValidationResult {
  isValid: boolean;
  conflicts: OverhangConflict[];
  compatiblePositions: number[];
}

export interface AssemblyValidationResult {
  isValid: boolean;
  conflicts: OverhangConflict[];
  uniqueOverhangs: Set<string>;
}

export interface GoldenGateAssemblyValidationContext {
  backboneSequenceId?: string | null;
}

export function getFragmentOverhangs(fragment: GoldenGateDigestFragmentLike): {
  upstream: string;
  downstream: string;
} {
  return {
    upstream: fragment.upstream.sequence,
    downstream: fragment.downstream.sequence,
  };
}

export function getRegionOverhangs(region: DesignRegion): {
  upstream: string | null;
  downstream: string | null;
} {
  if (!isRestrictionDigestRegion(region) || !region.rdOverhangs) {
    return { upstream: null, downstream: null };
  }
  return {
    upstream: region.rdOverhangs.upstream,
    downstream: region.rdOverhangs.downstream,
  };
}

export function checkDuplicateOverhangs(
  fragment: GoldenGateDigestFragmentLike,
  existingOverhangs: Set<string>
): OverhangConflict[] {
  const conflicts: OverhangConflict[] = [];
  const { upstream, downstream } = getFragmentOverhangs(fragment);

  if (existingOverhangs.has(upstream)) {
    conflicts.push({
      type: 'duplicate',
      overhang: upstream,
      message: `Upstream overhang ${upstream} already exists in assembly - may cause mis-ligation`,
      involvedIndices: [fragment.index],
    });
  }

  if (existingOverhangs.has(downstream)) {
    conflicts.push({
      type: 'duplicate',
      overhang: downstream,
      message: `Downstream overhang ${downstream} already exists in assembly - may cause mis-ligation`,
      involvedIndices: [fragment.index],
    });
  }

  if (upstream === downstream) {
    conflicts.push({
      type: 'self-ligation',
      overhang: upstream,
      message: `Both ends of this part have the same overhang (${upstream}), so it would close back on itself instead of joining its neighbors. Give the two ends different overhangs.`,
      involvedIndices: [fragment.index],
    });
  }

  return conflicts;
}

function findAllOccurrences(sequence: string, pattern: string): number[] {
  const positions: number[] = [];
  let pos = 0;
  const seq = sequence.toUpperCase();
  const pat = pattern.toUpperCase();

  while ((pos = seq.indexOf(pat, pos)) !== -1) {
    positions.push(pos);
    pos += 1;
  }

  return positions;
}

export function checkInternalSitesInPcrRegions(
  regions: DesignRegion[],
  enzyme: GoldenGateEnzyme
): OverhangConflict[] {
  const conflicts: OverhangConflict[] = [];
  const spec = ENZYME_SPECS[enzyme];
  const site = spec.site;
  const siteRc = reverseComplement(site);

  for (let i = 0; i < regions.length; i++) {
    const region = regions[i];

    if (region.sourceType !== 'pcr') continue;

    const seq = region.sequence?.toUpperCase() ?? '';
    if (!seq) continue;

    const siteLen = site.length;
    const internalSites: InternalCutSite[] = [
      ...findAllOccurrences(seq, site).map(
        (start): InternalCutSite => ({ start, end: start + siteLen, strand: 'forward' })
      ),
      ...findAllOccurrences(seq, siteRc).map(
        (start): InternalCutSite => ({ start, end: start + siteLen, strand: 'reverse' })
      ),
    ].sort((a, b) => a.start - b.start || a.end - b.end);
    const totalSites = internalSites.length;

    if (totalSites > 0) {
      conflicts.push({
        type: 'internal-site',
        overhang: site,
        message: `Part ${i + 1} contains ${totalSites} extra ${enzyme} recognition site(s), so ${enzyme} would cut this part apart during the reaction. Remove the internal site(s) (e.g. with a silent mutation) or choose a fragment without them.`,
        involvedIndices: [i],
        internalSites,
        regionId: region.id,
        regionIndex: i,
        expectedEnzyme: enzyme,
        expectedRecognitionSequence: site,
        actualRecognitionSequence: site,
        mismatchReason: 'internal-site',
      });
    }
  }

  return conflicts;
}

export type EnzymeInternalSitePartSummary = {
  regionIndex: number;
  regionId: string;
  siteCount: number;
};

export function summarizeInternalSitesByEnzyme(
  regions: readonly DesignRegion[]
): Record<GoldenGateEnzyme, EnzymeInternalSitePartSummary[]> {
  const enzymes = Object.keys(ENZYME_SPECS) as GoldenGateEnzyme[];
  const result = {} as Record<GoldenGateEnzyme, EnzymeInternalSitePartSummary[]>;
  for (const enzyme of enzymes) {
    result[enzyme] = checkInternalSitesInPcrRegions([...regions], enzyme).flatMap((conflict) => {
      const siteCount = conflict.internalSites?.length ?? 0;
      if (siteCount === 0) return [];
      return [
        {
          regionIndex: conflict.regionIndex ?? conflict.involvedIndices[0] ?? 0,
          regionId: conflict.regionId ?? '',
          siteCount,
        },
      ];
    });
  }
  return result;
}

export function countInternalSites(parts: readonly EnzymeInternalSitePartSummary[]): number {
  return parts.reduce((sum, part) => sum + part.siteCount, 0);
}

export function formatInternalCutCountLabel(siteCount: number): UserMessage | null {
  if (siteCount <= 0) return null;
  return userMessageWithValues('copy.value-internal-cutvalue', {
    value0: userMessageValue(siteCount),
    value1: userMessageValue(siteCount === 1 ? '' : 's'),
  });
}

function isRestrictionDigestRegion(region: DesignRegion): boolean {
  return region.sourceType === 'rd' || !!region.rdOverhangs;
}

export function checkGoldenGateRdFragmentCompatibility(
  regions: DesignRegion[],
  enzyme: GoldenGateEnzyme,
  context: GoldenGateAssemblyValidationContext = {}
): OverhangConflict[] {
  const conflicts: OverhangConflict[] = [];
  const expectedSite = ENZYME_SPECS[enzyme].site.toUpperCase();

  for (let index = 0; index < regions.length; index++) {
    const region = regions[index];
    if (!isRestrictionDigestRegion(region)) continue;

    const label = region.sourceSequenceName || `region ${index + 1}`;

    if (!region.rdSourceEnzyme) {
      conflicts.push({
        type: 'rd-enzyme-unknown',
        overhang: region.rdSourceEnzymeName ?? 'unknown',
        message: `${label} is a restriction digest fragment, but it was not produced by a supported Golden Gate Type IIS enzyme.`,
        involvedIndices: [index],
        regionId: region.id,
        regionIndex: index,
        expectedEnzyme: enzyme,
        actualEnzyme: region.rdSourceEnzymeName ?? null,
        mismatchReason: 'rd-enzyme-unknown',
      });
      continue;
    }

    if (region.rdSourceEnzyme !== enzyme) {
      conflicts.push({
        type: 'rd-enzyme-mismatch',
        overhang: region.rdSourceEnzyme,
        message: `${label} was produced by ${region.rdSourceEnzyme}, so it cannot be used in a ${enzyme} Golden Gate reaction.`,
        involvedIndices: [index],
        regionId: region.id,
        regionIndex: index,
        expectedEnzyme: enzyme,
        actualEnzyme: region.rdSourceEnzyme,
        mismatchReason: 'rd-enzyme-mismatch',
      });
    }

    const isSelectedDestinationBackbone =
      region.ggType === 'backbone' && region.sourceSequenceId === context.backboneSequenceId;
    if (region.ggType && region.ggType !== 'insert' && !isSelectedDestinationBackbone) {
      conflicts.push({
        type: 'rd-fragment-not-insert',
        overhang: region.ggType,
        message: `${label} is a "${region.ggType}" fragment, but this position needs an insert. Golden Gate can only join insert-polarity fragments — ones whose overhangs face inward. Use a different, insert-polarity part here.`,
        involvedIndices: [index],
        regionId: region.id,
        regionIndex: index,
        expectedEnzyme: enzyme,
        actualEnzyme: region.rdSourceEnzyme,
        mismatchReason: 'rd-fragment-not-insert',
      });
    }

    for (const [endName, expectedOverhang] of [
      ['upstream', region.rdOverhangs?.upstream],
      ['downstream', region.rdOverhangs?.downstream],
    ] as const) {
      const end = region.rdEnds?.[endName];
      if (!end) continue;

      if (end.recognitionSequence && end.recognitionSequence.toUpperCase() !== expectedSite) {
        conflicts.push({
          type: 'rd-cut-site-mismatch',
          overhang: end.recognitionSequence,
          message: `${label} ${endName} RD end comes from ${end.recognitionSequence}, not the selected ${enzyme} site ${expectedSite}.`,
          involvedIndices: [index],
          regionId: region.id,
          regionIndex: index,
          endName,
          expectedEnzyme: enzyme,
          actualEnzyme: region.rdSourceEnzyme,
          expectedRecognitionSequence: expectedSite,
          actualRecognitionSequence: end.recognitionSequence,
          expectedOverhang,
          actualOverhang: end.overhang,
          mismatchReason: 'recognition-sequence-mismatch',
        });
      }

      if (end.overhang && expectedOverhang && end.overhang !== expectedOverhang) {
        conflicts.push({
          type: 'rd-cut-site-mismatch',
          overhang: end.overhang,
          message: `${label} ${endName} RD end overhang ${end.overhang} does not match region overhang ${expectedOverhang}.`,
          involvedIndices: [index],
          regionId: region.id,
          regionIndex: index,
          endName,
          expectedEnzyme: enzyme,
          actualEnzyme: region.rdSourceEnzyme,
          expectedRecognitionSequence: expectedSite,
          actualRecognitionSequence: end.recognitionSequence,
          expectedOverhang,
          actualOverhang: end.overhang,
          mismatchReason: 'rd-end-overhang-mismatch',
        });
      }

      const cutMismatch = getGoldenGateCutGeometryMismatch(
        end,
        enzyme,
        region.sourceSequence,
        region.sourceLength
      );
      if (cutMismatch) {
        conflicts.push({
          type: 'rd-cut-site-mismatch',
          overhang: end.overhang ?? expectedOverhang ?? 'unknown',
          message: `${label} ${endName} RD end ${cutMismatch}.`,
          involvedIndices: [index],
          regionId: region.id,
          regionIndex: index,
          endName,
          expectedEnzyme: enzyme,
          actualEnzyme: region.rdSourceEnzyme,
          expectedRecognitionSequence: expectedSite,
          actualRecognitionSequence: end.recognitionSequence,
          expectedOverhang,
          actualOverhang: end.overhang,
          expectedCutGeometry: `${enzyme}:${expectedSite}`,
          actualCutGeometry: `${end.cutPositionTop ?? '?'}:${end.cutPositionBottom ?? '?'}`,
          mismatchReason: cutMismatch,
        });
      }
    }
  }

  return conflicts;
}

function getGoldenGateCutGeometryMismatch(
  end: RestrictionDigestEnd,
  enzyme: GoldenGateEnzyme,
  sourceSequence?: string,
  recordedSourceLength?: number
): string | null {
  if (
    end.recognitionStart === undefined ||
    end.recognitionEnd === undefined ||
    end.cutPositionTop === undefined ||
    end.cutPositionBottom === undefined
  ) {
    return null;
  }

  const geometry = GOLDEN_GATE_CUT_GEOMETRY[enzyme];
  const sequenceLength = sourceSequence?.length ?? recordedSourceLength;
  const actualTop = end.cutPositionTop;
  const actualBottom = end.cutPositionBottom;
  const expected =
    end.strand === 'reverse'
      ? {
          top: end.recognitionEnd - geometry.cutPositionBottom,
          bottom: end.recognitionEnd - geometry.cutPositionTop,
        }
      : {
          top: end.recognitionStart + geometry.cutPositionTop,
          bottom: end.recognitionStart + geometry.cutPositionBottom,
        };

  const expectedTop = normalizeCutCoordinate(expected.top, sequenceLength);
  const expectedBottom = normalizeCutCoordinate(expected.bottom, sequenceLength);

  if (
    expectedTop !== null &&
    expectedBottom !== null &&
    (!cutCoordinatesMatch(actualTop, expectedTop, sequenceLength) ||
      !cutCoordinatesMatch(actualBottom, expectedBottom, sequenceLength))
  ) {
    return `cut coordinates ${actualTop}/${actualBottom} do not match ${enzyme} geometry ${expectedTop}/${expectedBottom}`;
  }

  const actualOverhangLength = cutSpanLength(actualTop, actualBottom, sequenceLength);
  if (actualOverhangLength !== null && actualOverhangLength !== geometry.overhangLength) {
    return `cut span is ${actualOverhangLength} bp, expected ${geometry.overhangLength} bp for ${enzyme}`;
  }

  return null;
}

function normalizeCutCoordinate(value: number, sequenceLength: number | undefined): number | null {
  if (!Number.isFinite(value)) return null;
  if (!sequenceLength || sequenceLength <= 0) {
    return value >= 0 ? value : null;
  }
  return ((value % sequenceLength) + sequenceLength) % sequenceLength;
}

function cutCoordinatesMatch(
  actual: number,
  expected: number,
  sequenceLength: number | undefined
): boolean {
  if (!Number.isFinite(actual)) return false;
  if (!sequenceLength || sequenceLength <= 0) return actual === expected;
  return normalizeCutCoordinate(actual, sequenceLength) === expected;
}

function cutSpanLength(
  top: number,
  bottom: number,
  sequenceLength: number | undefined
): number | null {
  if (!Number.isFinite(top) || !Number.isFinite(bottom)) return null;
  if (!sequenceLength || sequenceLength <= 0) return Math.abs(bottom - top);
  return (bottom - top + sequenceLength) % sequenceLength;
}

export function validateAssembly(
  regions: DesignRegion[],
  isCircular: boolean
): AssemblyValidationResult {
  const conflicts: OverhangConflict[] = [];
  const allOverhangs: string[] = [];
  const overhangCounts = new Map<string, number[]>();

  for (let i = 0; i < regions.length; i++) {
    const region = regions[i];
    const { upstream, downstream } = getRegionOverhangs(region);

    if (upstream) {
      allOverhangs.push(upstream);
      const indices = overhangCounts.get(upstream) || [];
      indices.push(i);
      overhangCounts.set(upstream, indices);
    }

    if (downstream) {
      allOverhangs.push(downstream);
      const indices = overhangCounts.get(downstream) || [];
      indices.push(i);
      overhangCounts.set(downstream, indices);
    }

    if (upstream && downstream && upstream === downstream) {
      conflicts.push({
        type: 'self-ligation',
        overhang: upstream,
        message: `Region ${i + 1} has identical overhangs (${upstream})`,
        involvedIndices: [i],
      });
    }
  }

  for (const [overhang, indices] of overhangCounts.entries()) {
    if (indices.length > 2) {
      conflicts.push({
        type: 'duplicate',
        overhang,
        message: `Overhang ${overhang} appears ${indices.length} times - risk of mis-ligation`,
        involvedIndices: indices,
      });
    }
  }

  const numJunctions = isCircular ? regions.length : regions.length - 1;
  for (let j = 0; j < numJunctions; j++) {
    const currentIdx = j;
    const nextIdx = (j + 1) % regions.length;
    const currentRegion = regions[currentIdx];
    const nextRegion = regions[nextIdx];

    const currentIsRD = isRestrictionDigestRegion(currentRegion) && currentRegion.rdOverhangs;
    const nextIsRD = isRestrictionDigestRegion(nextRegion) && nextRegion.rdOverhangs;

    if (currentIsRD && nextIsRD) {
      const currentOverhangs = getRegionOverhangs(currentRegion);
      const nextOverhangs = getRegionOverhangs(nextRegion);

      if (currentOverhangs.downstream && nextOverhangs.upstream) {
        void (currentOverhangs.downstream !== nextOverhangs.upstream);
      } else if (currentOverhangs.downstream && !nextOverhangs.upstream) {
        conflicts.push({
          type: 'duplicate',
          overhang: currentOverhangs.downstream,
          message: `Overhang ${currentOverhangs.downstream} has no matching upstream in adjacent RD fragment`,
          involvedIndices: [currentIdx],
        });
      } else if (!currentOverhangs.downstream && nextOverhangs.upstream) {
        conflicts.push({
          type: 'duplicate',
          overhang: nextOverhangs.upstream,
          message: `Overhang ${nextOverhangs.upstream} has no matching downstream in adjacent RD fragment`,
          involvedIndices: [nextIdx],
        });
      }
    }
  }

  for (let i = 0; i < regions.length - 1; i++) {
    const currentOverhangs = getRegionOverhangs(regions[i]);
    const nextOverhangs = getRegionOverhangs(regions[i + 1]);

    if (currentOverhangs.downstream && nextOverhangs.upstream) {
      if (currentOverhangs.downstream !== nextOverhangs.upstream) {
        conflicts.push({
          type: 'mismatch',
          overhang: `${currentOverhangs.downstream}/${nextOverhangs.upstream}`,
          message: `Mismatch at junction ${i + 1}: ${currentOverhangs.downstream} ≠ ${nextOverhangs.upstream}`,
          involvedIndices: [i, i + 1],
        });
      }
    }
  }

  if (isCircular && regions.length > 1) {
    const lastOverhangs = getRegionOverhangs(regions[regions.length - 1]);
    const firstOverhangs = getRegionOverhangs(regions[0]);

    if (lastOverhangs.downstream && firstOverhangs.upstream) {
      if (lastOverhangs.downstream !== firstOverhangs.upstream) {
        conflicts.push({
          type: 'mismatch',
          overhang: `${lastOverhangs.downstream}/${firstOverhangs.upstream}`,
          message: `Circular mismatch: ${lastOverhangs.downstream} ≠ ${firstOverhangs.upstream}`,
          involvedIndices: [regions.length - 1, 0],
        });
      }
    }
  }

  return {
    isValid: conflicts.length === 0,
    conflicts,
    uniqueOverhangs: new Set(allOverhangs),
  };
}

export function validateGoldenGateAssembly(
  regions: DesignRegion[],
  isCircular: boolean,
  enzyme: GoldenGateEnzyme,
  context: GoldenGateAssemblyValidationContext = {}
): AssemblyValidationResult {
  const overhangResult = validateAssembly(regions, isCircular);

  const internalSiteConflicts = checkInternalSitesInPcrRegions(regions, enzyme);
  const rdCompatibilityConflicts = checkGoldenGateRdFragmentCompatibility(regions, enzyme, context);

  const allConflicts = [
    ...overhangResult.conflicts,
    ...internalSiteConflicts,
    ...rdCompatibilityConflicts,
  ];

  return {
    isValid: allConflicts.length === 0,
    conflicts: allConflicts,
    uniqueOverhangs: overhangResult.uniqueOverhangs,
  };
}

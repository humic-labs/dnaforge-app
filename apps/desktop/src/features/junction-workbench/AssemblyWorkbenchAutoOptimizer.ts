import type {
  AssemblyOptimizationGoldenGateJunctionInput,
  AssemblyOptimizationInput,
} from '../assembly/public/assembly-optimization-input';
import { goldenGateOffsetLimitBp } from './AssemblyWorkbenchContract';
import {
  getGoldenGateFidelityDatasetForEnzyme,
  reverseComplementOverhang,
  scoreGoldenGateOverhangSet,
  type GoldenGateFidelityDataset,
  type GoldenGateFidelityDatasetKey,
  type GoldenGateSetFidelityScore,
} from './golden-gate-fidelity/GoldenGateFidelityDataset';
import {
  buildLeanFidelityIndex,
  overhangToCode,
  scoreOverhangCodes,
  type LeanFidelityIndex,
  type LeanSetScore,
} from './golden-gate-fidelity/leanSetFidelity';

const DEFAULT_MAX_EXACT_SEARCH_NODES = 2_000_000;
const DEFAULT_TOP_COMBINATION_COUNT = 8;
const FIDELITY_EPSILON = 1e-12;
const SEARCH_CACHE_MAX_ENTRIES = 16;

let exactSearchNodeLimitOverride: number | null = null;

interface GoldenGateCandidate {
  junctionIndex: number;
  offset: number;
  overhang: string;
  movement: number;
  singletonLogFidelity: number;
}

interface GoldenGatePbsFeasibilityContext {
  topology: AssemblyOptimizationInput['topology'];
  productLength: number;
  regionPositions: Array<{ id: string; start: number; end: number }>;
  requiredLengthByPrimer: Map<string, number>;
}

type GoldenGateCandidateSearchResult =
  | {
      exhaustive: true;
      selected: GoldenGateCandidate[];
      minMovementImprovement: GoldenGateCandidate[] | null;
      topCombinations: GoldenGateCandidate[][];
      evaluatedNodes: number;
    }
  | {
      exhaustive: false;
      selected: GoldenGateCandidate[];
      minMovementImprovement: GoldenGateCandidate[] | null;
      topCombinations: GoldenGateCandidate[][];
      evaluatedNodes: number;
    };

const exactSearchCache = new Map<string, GoldenGateCandidateSearchResult>();
let exactSearchCacheHits = 0;
let exactSearchCacheMisses = 0;

export interface GoldenGateOptimizationJunctionChoice {
  junctionIndex: number;
  offset: number;
  overhang: string;
  locked: boolean;
  movement: number;
}

export interface GoldenGateOptimizationCombination {
  rank: number;
  offsetsByJunctionIndex: Map<number, number>;
  fidelity: GoldenGateSetFidelityScore;
  choices: GoldenGateOptimizationJunctionChoice[];
  totalMovement: number;
  changedCount: number;
}

export type GoldenGateAutoOptimizePlan =
  | {
      status: 'planned';
      optimizationFingerprint: string;
      offsetsByJunctionIndex: Map<number, number>;
      beforeFidelity: GoldenGateSetFidelityScore;
      afterFidelity: GoldenGateSetFidelityScore;
      datasetKey: GoldenGateFidelityDatasetKey;
      evaluatedNodes: number;
      exhaustive: boolean;
      selectedRank: number;
      topCombinations: GoldenGateOptimizationCombination[];
    }
  | {
      status: 'unavailable';
      optimizationFingerprint?: string;
      reason: 'no-four-base-dataset' | 'search-limit-exceeded';
      message: string;
      offsetsByJunctionIndex: Map<number, number>;
      evaluatedNodes?: number;
      exhaustive?: false;
    };

export function planGoldenGateAutoOptimization(
  input: AssemblyOptimizationInput,
  options: {
    scopeJunctionIndex?: number | null;
    maxExactSearchNodes?: number;
    topCombinationCount?: number;
    candidateRank?: number;
  } = {}
): GoldenGateAutoOptimizePlan {
  const junctions = input.goldenGate?.junctions ?? [];
  if (junctions.length === 0) {
    return emptyPlannedPlan(emptyScore(), emptyScore(), 'BsaI-HFv2', input.optimizationFingerprint);
  }

  const enzyme = input.goldenGate?.enzyme ?? 'BsaI';
  const dataset = getGoldenGateFidelityDatasetForEnzyme(enzyme);
  if (!dataset) {
    return unavailablePlan(
      input.optimizationFingerprint,
      'no-four-base-dataset',
      `No bundled four-base empirical ligation-fidelity dataset is available for ${enzyme}.`
    );
  }

  const composedSequence = input.productSequence;
  if (composedSequence.length === 0) {
    const score = scoreGoldenGateOverhangSet([], dataset);
    return emptyPlannedPlan(score, score, dataset.key, input.optimizationFingerprint);
  }

  const offsetLimit = goldenGateOffsetLimitBp(input.goldenGate);
  const scopeJunctionIndex = options.scopeJunctionIndex;
  const pbsFeasibility = goldenGatePbsFeasibilityContext(input);
  const candidateSets = junctions.map((junction) =>
    candidateSetForJunction(
      junction,
      composedSequence,
      offsetLimit,
      scopeJunctionIndex,
      dataset,
      pbsFeasibility
    )
  );
  const current = candidateSets.map((set) => set.current);
  const beforeFidelity = scoreCandidateSet(current, dataset);
  const visibleCombinationCount = Math.max(
    1,
    options.topCombinationCount ?? DEFAULT_TOP_COMBINATION_COUNT
  );
  const searchOptions = {
    maxExactSearchNodes:
      options.maxExactSearchNodes ?? exactSearchNodeLimitOverride ?? DEFAULT_MAX_EXACT_SEARCH_NODES,
    topCombinationCount: goldenGateSearchPoolSize(visibleCombinationCount, candidateSets),
  };
  const search = optimizeCandidateSetCached(
    input,
    candidateSets,
    current,
    dataset,
    scopeJunctionIndex,
    searchOptions
  );

  const visibleOptimizedCandidates = selectVisibleGoldenGateCandidateRows({
    exactTopCandidates: search.topCombinations,
    bestCandidates: search.selected,
    minMovementImprovement: search.minMovementImprovement,
    current,
    candidateSets,
    dataset,
    count: Math.max(0, visibleCombinationCount - 1),
  });
  const topCombinations = [
    optimizationCombinationForCandidates(current, current, candidateSets, dataset, 0),
    ...visibleOptimizedCandidates.map((candidates, index) =>
      optimizationCombinationForCandidates(candidates, current, candidateSets, dataset, index + 1)
    ),
  ];
  const explicitRankSelection = options.candidateRank !== undefined;
  const selectedRank = explicitRankSelection
    ? clampCandidateRank(options.candidateRank, topCombinations.length)
    : implicitGoldenGateSelectedRank(topCombinations, beforeFidelity);
  const selectedCombination =
    topCombinations[selectedRank] ??
    optimizationCombinationForCandidates(current, current, candidateSets, dataset, 0);
  const selectedCandidates = choicesAsCandidates(selectedCombination);
  const afterFidelity = selectedCombination.fidelity;

  if (
    !explicitRankSelection &&
    compareCandidateSetScores(afterFidelity, selectedCandidates, beforeFidelity, current) <= 0
  ) {
    return {
      status: 'planned',
      optimizationFingerprint: input.optimizationFingerprint,
      offsetsByJunctionIndex: new Map(),
      beforeFidelity,
      afterFidelity,
      datasetKey: dataset.key,
      evaluatedNodes: search.evaluatedNodes,
      exhaustive: search.exhaustive,
      selectedRank,
      topCombinations,
    };
  }

  return {
    status: 'planned',
    optimizationFingerprint: input.optimizationFingerprint,
    offsetsByJunctionIndex: selectedCombination.offsetsByJunctionIndex,
    beforeFidelity,
    afterFidelity,
    datasetKey: dataset.key,
    evaluatedNodes: search.evaluatedNodes,
    exhaustive: search.exhaustive,
    selectedRank,
    topCombinations,
  };
}

function implicitGoldenGateSelectedRank(
  combinations: readonly GoldenGateOptimizationCombination[],
  beforeFidelity: GoldenGateSetFidelityScore
): number {
  let bestRank = 0;
  let bestMovement = Number.POSITIVE_INFINITY;
  for (let index = 1; index < combinations.length; index++) {
    const combination = combinations[index];
    if (compareGoldenGateSetQuality(combination.fidelity, beforeFidelity) <= 0) continue;
    if (bestRank !== 0) {
      const classDelta =
        implicitImprovementClass(combination.fidelity) -
        implicitImprovementClass(combinations[bestRank].fidelity);
      if (classDelta < 0) continue;
      if (classDelta > 0) {
        bestRank = index;
        bestMovement = combination.totalMovement;
        continue;
      }
    }
    const incumbent = combinations[bestRank];
    if (
      combination.totalMovement < bestMovement ||
      (combination.totalMovement === bestMovement &&
        (bestRank === 0 ||
          compareGoldenGateSetQuality(combination.fidelity, incumbent.fidelity) > 0))
    ) {
      bestRank = index;
      bestMovement = combination.totalMovement;
    }
  }
  return bestRank;
}

function implicitImprovementClass(score: GoldenGateSetFidelityScore): number {
  return score.valid ? 1 : 0;
}

function compareSetQualityAxes(
  left: {
    valid: boolean;
    conflictCount: number;
    logFidelity: number;
    onTargetCount: number;
  },
  right: {
    valid: boolean;
    conflictCount: number;
    logFidelity: number;
    onTargetCount: number;
  }
): number {
  if (left.valid !== right.valid) return left.valid ? 1 : -1;
  const conflictDelta = right.conflictCount - left.conflictCount;
  if (conflictDelta !== 0) return conflictDelta;
  const logDelta = left.logFidelity - right.logFidelity;
  if (Math.abs(logDelta) > FIDELITY_EPSILON) return logDelta > 0 ? 1 : -1;
  return left.onTargetCount - right.onTargetCount;
}

function compareGoldenGateSetQuality(
  leftScore: GoldenGateSetFidelityScore,
  rightScore: GoldenGateSetFidelityScore
): number {
  return compareSetQualityAxes(
    {
      valid: leftScore.valid,
      conflictCount: leftScore.conflicts.length,
      logFidelity: leftScore.logFidelity,
      onTargetCount: leftScore.onTargetCount,
    },
    {
      valid: rightScore.valid,
      conflictCount: rightScore.conflicts.length,
      logFidelity: rightScore.logFidelity,
      onTargetCount: rightScore.onTargetCount,
    }
  );
}

function compareLeanSetQuality(leftScore: LeanSetScore, rightScore: LeanSetScore): number {
  return compareSetQualityAxes(
    {
      valid: leftScore.valid,
      conflictCount: leftScore.conflictCount,
      logFidelity: leftScore.logFidelity,
      onTargetCount: leftScore.onTargetCount,
    },
    {
      valid: rightScore.valid,
      conflictCount: rightScore.conflictCount,
      logFidelity: rightScore.logFidelity,
      onTargetCount: rightScore.onTargetCount,
    }
  );
}

function choicesAsCandidates(
  combination: GoldenGateOptimizationCombination
): GoldenGateCandidate[] {
  return combination.choices.map((choice) => ({
    junctionIndex: choice.junctionIndex,
    offset: choice.offset,
    overhang: choice.overhang,
    movement: choice.movement,
    singletonLogFidelity: 0,
  }));
}

function candidateSetForJunction(
  junction: AssemblyOptimizationGoldenGateJunctionInput,
  composedSequence: string,
  offsetLimit: number,
  scopeJunctionIndex: number | null | undefined,
  dataset: GoldenGateFidelityDataset,
  pbsFeasibility: GoldenGatePbsFeasibilityContext | null
): { current: GoldenGateCandidate; candidates: GoldenGateCandidate[] } {
  const current = currentCandidateForJunction(junction, dataset);
  const inScope =
    scopeJunctionIndex === null ||
    scopeJunctionIndex === undefined ||
    junction.junctionIndex === scopeJunctionIndex;

  if (!inScope || isOptimizationJunctionOffsetLocked(junction)) {
    return { current, candidates: [current] };
  }

  const candidates: GoldenGateCandidate[] = [];
  const movementBasis = goldenGateCandidateMovementBasis(junction);
  for (let offset = -offsetLimit; offset <= offsetLimit; offset++) {
    const candidate = candidateForOffset(
      junction,
      offset,
      composedSequence,
      dataset,
      movementBasis
    );
    if (
      offset === current.offset ||
      goldenGateCandidatePreservesPrimerPbs(junction, candidate, pbsFeasibility)
    ) {
      candidates.push(candidate);
    }
  }

  return {
    current,
    candidates: dedupeCandidatesByOverhang(candidates, current).sort(candidateSortKey),
  };
}

function goldenGatePbsFeasibilityContext(
  input: AssemblyOptimizationInput
): GoldenGatePbsFeasibilityContext | null {
  if (input.primerPbsConstraints.length === 0 || input.regions.length === 0) return null;

  const spacerLengthByJunction = new Map(
    input.spacers.map((spacer) => [spacer.junctionIndex, spacer.sequence.length])
  );
  const regionPositions: GoldenGatePbsFeasibilityContext['regionPositions'] = [];
  let position = 0;
  for (let fragmentIndex = 0; fragmentIndex < input.regions.length; fragmentIndex++) {
    const region = input.regions[fragmentIndex];
    regionPositions.push({
      id: region.id,
      start: position,
      end: position + region.sequence.length,
    });
    position += region.sequence.length;
    position += spacerLengthByJunction.get(fragmentIndex) ?? 0;
  }

  const requiredLengthByPrimer = new Map<string, number>();
  for (const constraint of input.primerPbsConstraints) {
    const region = regionPositions[constraint.fragmentIndex];
    if (!region || region.id !== constraint.regionId || constraint.length <= 0) continue;
    requiredLengthByPrimer.set(
      primerPbsConstraintKey(constraint.fragmentIndex, constraint.direction),
      constraint.length
    );
  }
  if (requiredLengthByPrimer.size === 0) return null;

  return {
    topology: input.topology,
    productLength: input.productSequence.length,
    regionPositions,
    requiredLengthByPrimer,
  };
}

function goldenGateCandidatePreservesPrimerPbs(
  junction: AssemblyOptimizationGoldenGateJunctionInput,
  candidate: GoldenGateCandidate,
  context: GoldenGatePbsFeasibilityContext | null
): boolean {
  if (!context) return true;
  const fragmentCount = context.regionPositions.length;
  if (fragmentCount === 0) return true;

  const leftFragmentIndex = junction.junctionIndex;
  const rightFragmentIndex = (junction.junctionIndex + 1) % fragmentCount;
  const leftRegion = context.regionPositions[leftFragmentIndex];
  const rightRegion = context.regionPositions[rightFragmentIndex];
  if (!leftRegion || !rightRegion) return false;

  const overhangStart = junction.junctionPosition - 2 + candidate.offset;
  const overhangEnd = overhangStart + 4;
  const requiredReverseLength = context.requiredLengthByPrimer.get(
    primerPbsConstraintKey(leftFragmentIndex, 'reverse')
  );
  if (requiredReverseLength !== undefined) {
    const reversePbsEnd = Math.max(
      leftRegion.start + 1,
      Math.min(overhangStart >= leftRegion.end ? leftRegion.end : overhangStart, leftRegion.end)
    );
    if (reversePbsEnd - leftRegion.start < requiredReverseLength) return false;
  }

  const requiredForwardLength = context.requiredLengthByPrimer.get(
    primerPbsConstraintKey(rightFragmentIndex, 'forward')
  );
  if (requiredForwardLength === undefined) return true;

  const wrapsAtOrigin =
    context.topology === 'circular' &&
    rightFragmentIndex === 0 &&
    junction.junctionPosition >= context.productLength;
  let forwardPbsStart: number;
  if (wrapsAtOrigin) {
    forwardPbsStart =
      overhangEnd > context.productLength
        ? ((overhangEnd % context.productLength) + context.productLength) % context.productLength
        : rightRegion.start;
  } else {
    forwardPbsStart = overhangEnd <= junction.junctionPosition ? rightRegion.start : overhangEnd;
  }
  const clampedForwardPbsStart = Math.max(
    rightRegion.start,
    Math.min(forwardPbsStart, rightRegion.end - 1)
  );
  return rightRegion.end - clampedForwardPbsStart >= requiredForwardLength;
}

function primerPbsConstraintKey(fragmentIndex: number, direction: 'forward' | 'reverse'): string {
  return `${fragmentIndex}:${direction}`;
}

function currentCandidateForJunction(
  junction: AssemblyOptimizationGoldenGateJunctionInput,
  dataset: GoldenGateFidelityDataset
): GoldenGateCandidate {
  return {
    junctionIndex: junction.junctionIndex,
    offset: junction.offset,
    overhang: junction.overhang,
    movement: 0,
    singletonLogFidelity: scoreGoldenGateOverhangSet([junction.overhang], dataset).logFidelity,
  };
}

function optimizeCandidateSetCached(
  input: AssemblyOptimizationInput,
  candidateSets: Array<{ current: GoldenGateCandidate; candidates: GoldenGateCandidate[] }>,
  current: GoldenGateCandidate[],
  dataset: GoldenGateFidelityDataset,
  scopeJunctionIndex: number | null | undefined,
  options: { maxExactSearchNodes: number; topCombinationCount: number }
): GoldenGateCandidateSearchResult {
  const key = goldenGateExactSearchCacheKey(input, dataset, scopeJunctionIndex, options);
  const cached = exactSearchCache.get(key);
  if (cached) {
    exactSearchCacheHits += 1;
    exactSearchCache.delete(key);
    exactSearchCache.set(key, cached);
    return cached;
  }

  exactSearchCacheMisses += 1;
  const search = optimizeCandidateSet(candidateSets, current, dataset, options);
  exactSearchCache.set(key, search);
  while (exactSearchCache.size > SEARCH_CACHE_MAX_ENTRIES) {
    const oldestKey = exactSearchCache.keys().next().value;
    if (!oldestKey) break;
    exactSearchCache.delete(oldestKey);
  }
  return search;
}

function goldenGateExactSearchCacheKey(
  input: AssemblyOptimizationInput,
  dataset: GoldenGateFidelityDataset,
  scopeJunctionIndex: number | null | undefined,
  options: { maxExactSearchNodes: number; topCombinationCount: number }
): string {
  return [
    'golden-gate-exact-search-v2',
    input.optimizationFingerprint,
    dataset.key,
    scopeJunctionIndex ?? 'all',
    options.maxExactSearchNodes,
    options.topCombinationCount,
  ].join('|');
}

function optimizeCandidateSet(
  candidateSets: Array<{ current: GoldenGateCandidate; candidates: GoldenGateCandidate[] }>,
  current: GoldenGateCandidate[],
  dataset: GoldenGateFidelityDataset,
  options: { maxExactSearchNodes: number; topCombinationCount: number }
): GoldenGateCandidateSearchResult {
  const order = candidateSets
    .map((set, index) => ({ index, size: set.candidates.length }))
    .sort((left, right) => left.size - right.size || left.index - right.index)
    .map((item) => item.index);

  const overhangFacts = new Map<string, { rc: string; correct: number; usable: boolean }>();
  for (const set of candidateSets) {
    for (const candidate of set.candidates) {
      if (overhangFacts.has(candidate.overhang)) continue;
      const overhang = candidate.overhang;
      const rc = reverseComplementOverhang(overhang);
      const correct = dataset.count(rc, overhang) + dataset.count(overhang, rc);
      overhangFacts.set(overhang, { rc, correct, usable: overhang !== rc && correct > 0 });
    }
  }

  const leanIndex: LeanFidelityIndex = buildLeanFidelityIndex(dataset);
  const codeSets: number[][] = candidateSets.map((set) =>
    set.candidates.map((candidate) => overhangToCode(candidate.overhang))
  );
  const selectedCodeByOriginalIndex: number[] = new Array(candidateSets.length).fill(-1);
  const leafScorePool = new Int32Array(candidateSets.length * 2);
  const leafRcScratch = new Int32Array(candidateSets.length);
  function leanScoreCandidateSet(candidates: readonly GoldenGateCandidate[]): LeanSetScore {
    return scoreOverhangCodes(
      candidates.map((candidate) => overhangToCode(candidate.overhang)),
      leanIndex,
      leafScorePool,
      leafRcScratch
    );
  }

  const selectedByOriginalIndex: Array<GoldenGateCandidate | undefined> = new Array(
    candidateSets.length
  );
  let best = current.slice();
  let bestScore = leanScoreCandidateSet(best);
  const currentScore = bestScore;
  let minMovementImprovement: GoldenGateCandidate[] | null = null;
  let minMovementImprovementScore = currentScore;
  let minMovementImprovementBp = Number.POSITIVE_INFINITY;
  const topCombinations: Array<{
    candidates: GoldenGateCandidate[];
    score: LeanSetScore;
  }> = [];
  const seenCombinationKeys = new Set<string>();
  let evaluatedNodes = 0;
  let exhaustive = true;

  function pruneThresholdLogFidelity(): number | null {
    if (topCombinations.length < options.topCombinationCount) return null;
    const worst = topCombinations[topCombinations.length - 1];
    return worst.score.valid ? worst.score.logFidelity : null;
  }

  function completionUpperBound(depth: number): number {
    const prefixOverhangs: string[] = [];
    for (let position = 0; position < depth; position++) {
      const candidate = selectedByOriginalIndex[order[position]];
      if (candidate) prefixOverhangs.push(candidate.overhang);
    }
    const prefixScore = scoreGoldenGateOverhangSet(prefixOverhangs, dataset);
    if (!prefixScore.valid) return Number.NEGATIVE_INFINITY;

    const prefixTerminals = new Set<string>();
    for (const overhang of prefixOverhangs) {
      prefixTerminals.add(overhang);
      const facts = overhangFacts.get(overhang);
      if (facts) prefixTerminals.add(facts.rc);
    }

    let tail = 0;
    for (let position = depth; position < order.length; position++) {
      const candidates = candidateSets[order[position]].candidates;
      let bestLogProb = Number.NEGATIVE_INFINITY;
      for (const candidate of candidates) {
        const facts = overhangFacts.get(candidate.overhang);
        if (!facts || !facts.usable) continue;
        const overhang = candidate.overhang;
        const rc = facts.rc;
        let total = 0;
        for (const terminal of prefixTerminals) {
          total += dataset.count(terminal, overhang) + dataset.count(terminal, rc);
        }
        if (!prefixTerminals.has(overhang)) {
          total += dataset.count(overhang, overhang) + dataset.count(overhang, rc);
        }
        if (rc !== overhang && !prefixTerminals.has(rc)) {
          total += dataset.count(rc, overhang) + dataset.count(rc, rc);
        }
        if (total > 0) {
          const logProb = Math.log(facts.correct / total);
          if (logProb > bestLogProb) bestLogProb = logProb;
        }
      }
      if (bestLogProb === Number.NEGATIVE_INFINITY) return Number.NEGATIVE_INFINITY;
      tail += bestLogProb;
    }
    return prefixScore.logFidelity + tail;
  }

  function visit(depth: number): void {
    if (!exhaustive) return;
    evaluatedNodes++;
    if (evaluatedNodes > options.maxExactSearchNodes) {
      exhaustive = false;
      return;
    }

    if (depth >= order.length) {
      const selected = selectedByOriginalIndex as GoldenGateCandidate[];
      const score = scoreOverhangCodes(
        selectedCodeByOriginalIndex,
        leanIndex,
        leafScorePool,
        leafRcScratch
      );
      if (compareLeanScores(score, selected, bestScore, best) > 0) {
        best = selected.slice();
        bestScore = score;
      }
      if (compareLeanSetQuality(score, currentScore) > 0) {
        const movement = candidateSetTotalMovement(selected);
        if (
          minMovementImprovement === null ||
          movement < minMovementImprovementBp ||
          (movement === minMovementImprovementBp &&
            compareLeanScores(
              score,
              selected,
              minMovementImprovementScore,
              minMovementImprovement
            ) > 0)
        ) {
          minMovementImprovement = selected.slice();
          minMovementImprovementScore = score;
          minMovementImprovementBp = movement;
        }
      }
      pushTopCombination(selected, score);
      return;
    }

    const originalIndex = order[depth];
    const threshold = pruneThresholdLogFidelity();
    const childrenAreLeaves = depth + 1 >= order.length;
    const candidates = candidateSets[originalIndex].candidates;
    const candidateCodes = codeSets[originalIndex];
    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
      selectedByOriginalIndex[originalIndex] = candidates[candidateIndex];
      selectedCodeByOriginalIndex[originalIndex] = candidateCodes[candidateIndex];
      if (
        childrenAreLeaves ||
        threshold === null ||
        completionUpperBound(depth + 1) >= threshold - FIDELITY_EPSILON
      ) {
        visit(depth + 1);
      }
      selectedByOriginalIndex[originalIndex] = undefined;
      selectedCodeByOriginalIndex[originalIndex] = -1;
      if (!exhaustive) return;
    }
  }

  function pushTopCombination(
    candidates: readonly GoldenGateCandidate[],
    score: LeanSetScore
  ): void {
    if (topCombinations.length >= options.topCombinationCount) {
      const worst = topCombinations[topCombinations.length - 1];
      if (compareLeanScores(score, candidates, worst.score, worst.candidates) <= 0) {
        return;
      }
    }
    const key = combinationKey(candidates);
    if (seenCombinationKeys.has(key)) return;
    seenCombinationKeys.add(key);
    topCombinations.push({ candidates: candidates.slice(), score });
    topCombinations.sort(
      (left, right) =>
        -compareLeanScores(left.score, left.candidates, right.score, right.candidates)
    );
    if (topCombinations.length > options.topCombinationCount) {
      const removed = topCombinations.pop();
      if (removed) seenCombinationKeys.delete(combinationKey(removed.candidates));
    }
  }

  visit(0);

  return exhaustive
    ? {
        exhaustive: true,
        selected: best,
        minMovementImprovement,
        topCombinations: topCombinations.map((combination) => combination.candidates),
        evaluatedNodes,
      }
    : {
        exhaustive: false,
        selected: best,
        minMovementImprovement,
        topCombinations: topCombinations.map((combination) => combination.candidates),
        evaluatedNodes,
      };
}

function goldenGateSearchPoolSize(
  visibleCombinationCount: number,
  candidateSets: Array<{ current: GoldenGateCandidate; candidates: GoldenGateCandidate[] }>
): number {
  const editableCount = candidateSets.filter((set) => set.candidates.length > 1).length;
  return Math.max(visibleCombinationCount + 1, editableCount + 1, 16);
}

function selectVisibleGoldenGateCandidateRows(input: {
  exactTopCandidates: GoldenGateCandidate[][];
  bestCandidates: GoldenGateCandidate[];
  minMovementImprovement: GoldenGateCandidate[] | null;
  current: GoldenGateCandidate[];
  candidateSets: Array<{ current: GoldenGateCandidate; candidates: GoldenGateCandidate[] }>;
  dataset: GoldenGateFidelityDataset;
  count: number;
}): GoldenGateCandidate[][] {
  if (input.count <= 0) return [];
  const selected: GoldenGateCandidate[][] = [];
  const seen = new Set<string>();
  const currentKey = combinationKey(input.current);

  const push = (candidates: readonly GoldenGateCandidate[]): boolean => {
    const key = combinationKey(candidates);
    if (key === currentKey || seen.has(key)) return false;
    seen.add(key);
    selected.push(candidates.slice());
    return selected.length >= input.count;
  };

  push(input.bestCandidates);
  if (input.minMovementImprovement) push(input.minMovementImprovement);
  const best = selected[0] ?? input.bestCandidates;

  for (
    let index = 0;
    index < input.candidateSets.length && selected.length < input.count;
    index++
  ) {
    if (input.candidateSets[index].candidates.length <= 1) continue;
    const alternative = bestSingleJunctionAlternative({
      best,
      junctionSlotIndex: index,
      candidates: input.candidateSets[index].candidates,
      dataset: input.dataset,
      seen,
      currentKey,
    });
    if (alternative) push(alternative);
  }

  for (const candidates of input.exactTopCandidates) {
    if (selected.length >= input.count) break;
    push(candidates);
  }

  return selected;
}

function bestSingleJunctionAlternative(input: {
  best: GoldenGateCandidate[];
  junctionSlotIndex: number;
  candidates: GoldenGateCandidate[];
  dataset: GoldenGateFidelityDataset;
  seen: ReadonlySet<string>;
  currentKey: string;
}): GoldenGateCandidate[] | null {
  const base = input.best[input.junctionSlotIndex];
  if (!base) return null;
  const alternatives = input.candidates
    .filter((candidate) => candidate.offset !== base.offset || candidate.overhang !== base.overhang)
    .map((candidate) => {
      const row = input.best.slice();
      row[input.junctionSlotIndex] = candidate;
      return {
        candidates: row,
        score: scoreCandidateSet(row, input.dataset),
      };
    })
    .filter((row) => {
      const key = combinationKey(row.candidates);
      return key !== input.currentKey && !input.seen.has(key);
    })
    .sort(
      (left, right) =>
        -compareCandidateSetScores(left.score, left.candidates, right.score, right.candidates)
    );
  return alternatives[0]?.candidates ?? null;
}

function optimizationCombinationForCandidates(
  candidates: readonly GoldenGateCandidate[],
  current: readonly GoldenGateCandidate[],
  candidateSets: Array<{ current: GoldenGateCandidate; candidates: GoldenGateCandidate[] }>,
  dataset: GoldenGateFidelityDataset,
  rank: number
): GoldenGateOptimizationCombination {
  const offsetsByJunctionIndex = new Map<number, number>();
  let totalMovement = 0;
  let changedCount = 0;
  const choices = candidates.map((candidate, index) => {
    const before = current[index];
    const changed = Boolean(before && before.offset !== candidate.offset);
    if (changed) {
      offsetsByJunctionIndex.set(candidate.junctionIndex, candidate.offset);
      changedCount += 1;
    }
    totalMovement += candidate.movement;
    return {
      junctionIndex: candidate.junctionIndex,
      offset: candidate.offset,
      overhang: candidate.overhang,
      locked: candidateSets[index]?.candidates.length === 1,
      movement: candidate.movement,
    };
  });
  return {
    rank,
    offsetsByJunctionIndex,
    fidelity: scoreCandidateSet(candidates, dataset),
    choices,
    totalMovement,
    changedCount,
  };
}

function combinationKey(candidates: readonly GoldenGateCandidate[]): string {
  return candidates
    .map((candidate) => `${candidate.junctionIndex}:${candidate.offset}:${candidate.overhang}`)
    .join('|');
}

function clampCandidateRank(rank: number | undefined, count: number): number {
  if (count <= 0 || typeof rank !== 'number' || !Number.isFinite(rank)) return 0;
  return Math.max(0, Math.min(count - 1, Math.round(rank)));
}

function candidateForOffset(
  junction: AssemblyOptimizationGoldenGateJunctionInput,
  offset: number,
  composedSequence: string,
  dataset: GoldenGateFidelityDataset,
  movementBasis = junction.offset
): GoldenGateCandidate {
  const overhangStart = junction.junctionPosition - 2 + offset;
  const overhang = circularSequenceSlice(composedSequence, overhangStart, 4);
  return {
    junctionIndex: junction.junctionIndex,
    offset,
    overhang,
    movement: Math.abs(offset - movementBasis),
    singletonLogFidelity: scoreGoldenGateOverhangSet([overhang], dataset).logFidelity,
  };
}

function goldenGateCandidateMovementBasis(
  junction: AssemblyOptimizationGoldenGateJunctionInput
): number {
  return junction.source.type === 'pcr-designed' ? 0 : junction.offset;
}

function scoreCandidateSet(
  candidates: readonly GoldenGateCandidate[],
  dataset: GoldenGateFidelityDataset
): GoldenGateSetFidelityScore {
  return scoreGoldenGateOverhangSet(
    candidates.map((candidate) => candidate.overhang),
    dataset
  );
}

function compareCandidateSetScores(
  leftScore: GoldenGateSetFidelityScore,
  leftCandidates: readonly GoldenGateCandidate[],
  rightScore: GoldenGateSetFidelityScore,
  rightCandidates: readonly GoldenGateCandidate[]
): number {
  const quality = compareGoldenGateSetQuality(leftScore, rightScore);
  if (quality !== 0) return quality;
  return compareCandidateSetTiebreak(leftCandidates, rightCandidates);
}

function compareCandidateSetTiebreak(
  leftCandidates: readonly GoldenGateCandidate[],
  rightCandidates: readonly GoldenGateCandidate[]
): number {
  const movementDelta =
    candidateSetTotalMovement(rightCandidates) - candidateSetTotalMovement(leftCandidates);
  if (movementDelta !== 0) return movementDelta;
  const changedDelta =
    candidateSetChangedCount(rightCandidates) - candidateSetChangedCount(leftCandidates);
  if (changedDelta !== 0) return changedDelta;
  return -candidateOffsetLexicographicCompare(leftCandidates, rightCandidates);
}

function compareLeanScores(
  leftScore: LeanSetScore,
  leftCandidates: readonly GoldenGateCandidate[],
  rightScore: LeanSetScore,
  rightCandidates: readonly GoldenGateCandidate[]
): number {
  const quality = compareLeanSetQuality(leftScore, rightScore);
  if (quality !== 0) return quality;
  return compareCandidateSetTiebreak(leftCandidates, rightCandidates);
}

function candidateSetTotalMovement(candidates: readonly GoldenGateCandidate[]): number {
  return candidates.reduce((total, candidate) => total + candidate.movement, 0);
}

function candidateSetChangedCount(candidates: readonly GoldenGateCandidate[]): number {
  return candidates.filter((candidate) => candidate.movement > 0).length;
}

function dedupeCandidatesByOverhang(
  candidates: readonly GoldenGateCandidate[],
  current: GoldenGateCandidate
): GoldenGateCandidate[] {
  const bestByOverhang = new Map<string, GoldenGateCandidate>();
  for (const candidate of candidates) {
    const existing = bestByOverhang.get(candidate.overhang);
    if (!existing || candidateSortKey(candidate, existing) < 0) {
      bestByOverhang.set(candidate.overhang, candidate);
    }
  }
  if (!bestByOverhang.has(current.overhang)) {
    bestByOverhang.set(current.overhang, current);
  }
  return Array.from(bestByOverhang.values());
}

function candidateSortKey(left: GoldenGateCandidate, right: GoldenGateCandidate): number {
  return (
    right.singletonLogFidelity - left.singletonLogFidelity ||
    Math.abs(left.offset) - Math.abs(right.offset) ||
    left.offset - right.offset ||
    left.overhang.localeCompare(right.overhang)
  );
}

function candidateOffsetLexicographicCompare(
  left: readonly GoldenGateCandidate[],
  right: readonly GoldenGateCandidate[]
): number {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const delta = left[index].offset - right[index].offset;
    if (delta !== 0) return delta;
  }
  return left.length - right.length;
}

function circularSequenceSlice(sequence: string, start: number, length: number): string {
  if (sequence.length === 0 || length <= 0) return '';
  let result = '';
  for (let index = 0; index < length; index++) {
    const pos = (((start + index) % sequence.length) + sequence.length) % sequence.length;
    result += sequence[pos];
  }
  return result;
}

function emptyPlannedPlan(
  beforeFidelity: GoldenGateSetFidelityScore,
  afterFidelity: GoldenGateSetFidelityScore,
  datasetKey: GoldenGateFidelityDatasetKey,
  optimizationFingerprint?: string
): Extract<GoldenGateAutoOptimizePlan, { status: 'planned' }> {
  return {
    status: 'planned',
    optimizationFingerprint: optimizationFingerprint ?? 'assembly-opt-v2:empty:0',
    offsetsByJunctionIndex: new Map(),
    beforeFidelity,
    afterFidelity,
    datasetKey,
    evaluatedNodes: 0,
    exhaustive: true,
    selectedRank: 0,
    topCombinations: [],
  };
}

function unavailablePlan(
  optimizationFingerprint: string | undefined,
  reason: Extract<GoldenGateAutoOptimizePlan, { status: 'unavailable' }>['reason'],
  message: string
): Extract<GoldenGateAutoOptimizePlan, { status: 'unavailable' }> {
  return {
    status: 'unavailable',
    optimizationFingerprint,
    reason,
    message,
    offsetsByJunctionIndex: new Map(),
  };
}

function isOptimizationJunctionOffsetLocked(
  junction: AssemblyOptimizationGoldenGateJunctionInput
): boolean {
  return junction.source.type !== 'pcr-designed';
}

function emptyScore(): GoldenGateSetFidelityScore {
  return {
    datasetKey: 'BsaI-HFv2',
    valid: true,
    fidelity: 1,
    logFidelity: 0,
    onTargetCount: 0,
    conflicts: [],
    perOverhang: [],
  };
}

export function clearGoldenGateAutoOptimizationCacheForTesting(): void {
  exactSearchCache.clear();
  exactSearchCacheHits = 0;
  exactSearchCacheMisses = 0;
}

export function setGoldenGateExactSearchNodeLimitForTesting(limit: number | null): void {
  exactSearchNodeLimitOverride = limit;
}

export function goldenGateAutoOptimizationCacheStatsForTesting(): {
  entries: number;
  hits: number;
  misses: number;
} {
  return {
    entries: exactSearchCache.size,
    hits: exactSearchCacheHits,
    misses: exactSearchCacheMisses,
  };
}

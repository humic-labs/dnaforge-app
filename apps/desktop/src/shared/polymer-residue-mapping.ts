export interface PolymerCoordinateChain {
  sequence: string;
  residues: Array<{ position: number; labelSeqId?: number; name: string; name3: string }>;
}
type ChainSequence = PolymerCoordinateChain;
export interface PolymerResidueMapEntry {
  residueIndex: number;
  position: number;
  labelSeqId?: number;
}
type ResidueMapEntry = PolymerResidueMapEntry;
export type ChainResidueMappingUnavailableReason =
  | 'ambiguous'
  | 'too-large'
  | 'mismatch'
  | 'no-scope'
  | 'no-coordinates';

export type ChainResidueMappingResult =
  | {
      status: 'mapped';
      method: 'author-numbering' | 'sequence-alignment' | 'declared-empty-chain';
      residues: ResidueMapEntry[];
      mappedCount: number;
      matchCount: number;
      mismatchCount: number;
    }
  | {
      status: 'unavailable';
      reason: ChainResidueMappingUnavailableReason;
    };

const THREE_LETTER_TO_ONE_LETTER: Record<string, string> = {
  ALA: 'A',
  ARG: 'R',
  ASN: 'N',
  ASP: 'D',
  CYS: 'C',
  GLN: 'Q',
  GLU: 'E',
  GLY: 'G',
  HIS: 'H',
  ILE: 'I',
  LEU: 'L',
  LYS: 'K',
  MET: 'M',
  PHE: 'F',
  PRO: 'P',
  SER: 'S',
  THR: 'T',
  TRP: 'W',
  TYR: 'Y',
  VAL: 'V',
};

export function mapChainResiduesToExpectedSequence(
  chain: ChainSequence,
  expectedResidueSequence: string
): ChainResidueMappingResult {
  const expected = normalizeResidueSequence(expectedResidueSequence);
  if (!expected) return { status: 'unavailable', reason: 'no-scope' };
  if (chain.residues.length === 0) {
    return {
      status: 'mapped',
      method: 'declared-empty-chain',
      residues: [],
      mappedCount: 0,
      matchCount: 0,
      mismatchCount: 0,
    };
  }

  const observed = normalizeResidueSequence(chain.sequence);
  if (!observed) return { status: 'unavailable', reason: 'no-coordinates' };

  const authorNumberingMap = residueMapFromAuthorNumbering(chain, expected);
  if (authorNumberingMap) {
    return mappedResidueResult('author-numbering', authorNumberingMap, chain, expected);
  }

  const alignment = alignObservedToExpectedResidueIndices(expected, observed);
  if (alignment.status === 'unavailable') return alignment;

  const residues = chain.residues
    .map((residue, chainIndex) => {
      const residueIndex = alignment.observedToExpected[chainIndex] ?? null;
      if (residueIndex === null || residueIndex < 0 || residueIndex >= expected.length) return null;
      return {
        residueIndex,
        position: residue.position,
        ...(residue.labelSeqId !== undefined ? { labelSeqId: residue.labelSeqId } : {}),
      };
    })
    .filter((entry): entry is ResidueMapEntry => entry !== null);

  if (residues.length === 0) return { status: 'unavailable', reason: 'mismatch' };
  return mappedResidueResult('sequence-alignment', residues, chain, expected);
}

function mappedResidueResult(
  method: 'author-numbering' | 'sequence-alignment',
  residues: ResidueMapEntry[],
  chain: ChainSequence,
  expected: string
): ChainResidueMappingResult {
  const residueByCoordinate = new Map(
    chain.residues.map((residue) => [
      `${residue.position}\u0000${residue.labelSeqId ?? ''}`,
      residue,
    ])
  );
  let matchCount = 0;
  let mismatchCount = 0;
  for (const entry of residues) {
    const residue = residueByCoordinate.get(`${entry.position}\u0000${entry.labelSeqId ?? ''}`);
    const observed = residue ? residueLetterForAuthorNumbering(residue) : '';
    if (observed && observed === expected[entry.residueIndex]) matchCount += 1;
    else mismatchCount += 1;
  }
  return {
    status: 'mapped',
    method,
    residues,
    mappedCount: residues.length,
    matchCount,
    mismatchCount,
  };
}

function residueMapFromAuthorNumbering(
  chain: ChainSequence,
  expected: string
): ResidueMapEntry[] | null {
  const indexedResidues = chain.residues
    .map((residue) => {
      const residueLetter = residueLetterForAuthorNumbering(residue);
      if (!residueLetter) return null;
      if (!Number.isFinite(residue.position)) return null;
      return { residue, residueLetter, position: residue.position };
    })
    .filter(
      (
        entry
      ): entry is {
        residue: ChainSequence['residues'][number];
        residueLetter: string;
        position: number;
      } => entry !== null
    );
  if (indexedResidues.length === 0) return null;

  const expectedIndicesByResidue = new Map<string, number[]>();
  for (let expectedIndex = 0; expectedIndex < expected.length; expectedIndex += 1) {
    const residue = expected[expectedIndex];
    const indices = expectedIndicesByResidue.get(residue);
    if (indices) indices.push(expectedIndex);
    else expectedIndicesByResidue.set(residue, [expectedIndex]);
  }

  const offsets = new Set<number>();
  for (const indexedResidue of indexedResidues) {
    const matchingExpectedIndices = expectedIndicesByResidue.get(indexedResidue.residueLetter);
    if (!matchingExpectedIndices) continue;
    for (const expectedIndex of matchingExpectedIndices) {
      offsets.add(expectedIndex - indexedResidue.position);
    }
  }
  if (offsets.size === 0) return null;

  const candidates = [...offsets].map((offset) => {
    let mapped = 0;
    let matches = 0;
    let mismatches = 0;
    for (const indexedResidue of indexedResidues) {
      const residueIndex = indexedResidue.position + offset;
      if (residueIndex < 0 || residueIndex >= expected.length) continue;
      mapped += 1;
      if (expected[residueIndex] === indexedResidue.residueLetter) matches += 1;
      else mismatches += 1;
    }
    return { offset, mapped, matches, mismatches };
  });

  const minOverlap = Math.min(
    20,
    Math.max(3, Math.floor(Math.min(expected.length, indexedResidues.length) / 2))
  );
  const passing = candidates
    .filter((candidate) => candidate.mapped >= minOverlap)
    .filter((candidate) => candidate.mapped / indexedResidues.length >= 0.9)
    .filter((candidate) => candidate.matches / candidate.mapped >= 0.85)
    .sort((left, right) => {
      if (right.matches !== left.matches) return right.matches - left.matches;
      if (right.mapped !== left.mapped) return right.mapped - left.mapped;
      if (left.mismatches !== right.mismatches) return left.mismatches - right.mismatches;
      return Math.abs(left.offset) - Math.abs(right.offset);
    });

  const best = passing[0];
  if (!best) return null;
  const equivalentlyBest = passing.filter(
    (candidate) =>
      candidate !== best &&
      candidate.matches === best.matches &&
      candidate.mapped === best.mapped &&
      candidate.mismatches === best.mismatches
  );
  if (equivalentlyBest.length > 0) return null;

  const residues = indexedResidues
    .map(({ residue, position }) => {
      const residueIndex = position + best.offset;
      if (residueIndex < 0 || residueIndex >= expected.length) return null;
      return {
        residueIndex,
        position: residue.position,
        ...(residue.labelSeqId !== undefined ? { labelSeqId: residue.labelSeqId } : {}),
      };
    })
    .filter((entry): entry is ResidueMapEntry => entry !== null);

  return residues.length > 0 ? residues : null;
}

function residueLetterForAuthorNumbering(residue: ChainSequence['residues'][number]): string {
  const oneLetterName = normalizeResidueSequence(residue.name);
  if (oneLetterName.length === 1) return oneLetterName;
  const threeLetterName = normalizeResidueSequence(residue.name3);
  if (threeLetterName.length === 3) return THREE_LETTER_TO_ONE_LETTER[threeLetterName] ?? '';
  return '';
}

type SequenceAlignmentResult =
  | { status: 'mapped'; observedToExpected: Array<number | null> }
  | { status: 'unavailable'; reason: 'ambiguous' | 'too-large' | 'mismatch' };

function alignObservedToExpectedResidueIndices(
  expected: string,
  observed: string
): SequenceAlignmentResult {
  const expectedLength = expected.length;
  const observedLength = observed.length;
  if (expectedLength === 0 || observedLength === 0) {
    return { status: 'unavailable', reason: 'mismatch' };
  }

  const cellCount = (expectedLength + 1) * (observedLength + 1);
  if (cellCount > 4_000_000) return { status: 'unavailable', reason: 'too-large' };

  const width = expectedLength + 1;
  const score = new Int32Array(cellCount);
  const trace = new Uint8Array(cellCount);
  const MATCH = 2;
  const MISMATCH = -2;
  const GAP = -1;
  const DIAG = 1;
  const UP = 2;
  const LEFT = 3;
  const index = (observedIndex: number, expectedIndex: number) =>
    observedIndex * width + expectedIndex;

  for (let expectedIndex = 1; expectedIndex <= expectedLength; expectedIndex += 1) {
    score[index(0, expectedIndex)] = 0;
    trace[index(0, expectedIndex)] = LEFT;
  }
  for (let observedIndex = 1; observedIndex <= observedLength; observedIndex += 1) {
    score[index(observedIndex, 0)] = observedIndex * GAP;
    trace[index(observedIndex, 0)] = UP;
  }

  for (let observedIndex = 1; observedIndex <= observedLength; observedIndex += 1) {
    for (let expectedIndex = 1; expectedIndex <= expectedLength; expectedIndex += 1) {
      const matchScore =
        observed[observedIndex - 1] === expected[expectedIndex - 1] ? MATCH : MISMATCH;
      const diagonalScore = score[index(observedIndex - 1, expectedIndex - 1)] + matchScore;
      const leftScore = score[index(observedIndex, expectedIndex - 1)] + GAP;
      const upScore = score[index(observedIndex - 1, expectedIndex)] + GAP;
      const currentIndex = index(observedIndex, expectedIndex);

      if (diagonalScore >= leftScore && diagonalScore >= upScore) {
        score[currentIndex] = diagonalScore;
        trace[currentIndex] = DIAG;
      } else if (leftScore >= upScore) {
        score[currentIndex] = leftScore;
        trace[currentIndex] = LEFT;
      } else {
        score[currentIndex] = upScore;
        trace[currentIndex] = UP;
      }
    }
  }

  let bestScore = Number.NEGATIVE_INFINITY;
  let bestExpectedEnd = -1;
  let bestEndCount = 0;
  for (let expectedIndex = 1; expectedIndex <= expectedLength; expectedIndex += 1) {
    const candidateScore = score[index(observedLength, expectedIndex)];
    if (candidateScore > bestScore) {
      bestScore = candidateScore;
      bestExpectedEnd = expectedIndex;
      bestEndCount = 1;
    } else if (candidateScore === bestScore) {
      bestEndCount += 1;
    }
  }
  if (bestExpectedEnd < 0) return { status: 'unavailable', reason: 'mismatch' };
  if (bestEndCount !== 1) return { status: 'unavailable', reason: 'ambiguous' };

  const observedToExpected = Array<number | null>(observedLength).fill(null);
  let observedIndex = observedLength;
  let expectedIndex = bestExpectedEnd;
  while (observedIndex > 0) {
    const direction = trace[index(observedIndex, expectedIndex)];
    if (direction === DIAG) {
      observedToExpected[observedIndex - 1] = expectedIndex - 1;
      observedIndex -= 1;
      expectedIndex -= 1;
    } else if (direction === UP) {
      observedToExpected[observedIndex - 1] = null;
      observedIndex -= 1;
    } else if (direction === LEFT) {
      expectedIndex -= 1;
    } else {
      return { status: 'unavailable', reason: 'mismatch' };
    }
    if (expectedIndex < 0) return { status: 'unavailable', reason: 'mismatch' };
  }
  if (hasAmbiguousEquivalentResidueMapping(expected, observed, observedToExpected)) {
    return { status: 'unavailable', reason: 'ambiguous' };
  }

  const mapped = observedToExpected.filter((entry): entry is number => entry !== null);
  const minOverlap = Math.min(
    20,
    Math.max(3, Math.floor(Math.min(expectedLength, observedLength) / 2))
  );
  if (mapped.length < minOverlap) return { status: 'unavailable', reason: 'mismatch' };
  if (mapped.length / observedLength < 0.9) {
    return { status: 'unavailable', reason: 'mismatch' };
  }

  let matches = 0;
  for (
    let observedResidueIndex = 0;
    observedResidueIndex < observedLength;
    observedResidueIndex += 1
  ) {
    const expectedResidueIndex = observedToExpected[observedResidueIndex];
    if (expectedResidueIndex === null) continue;
    if (observed[observedResidueIndex] === expected[expectedResidueIndex]) matches += 1;
  }
  if (matches / mapped.length < 0.85) {
    return { status: 'unavailable', reason: 'mismatch' };
  }
  return { status: 'mapped', observedToExpected };
}

function hasAmbiguousEquivalentResidueMapping(
  expected: string,
  observed: string,
  observedToExpected: ReadonlyArray<number | null>
): boolean {
  const mappedObservedIndices = observedToExpected
    .map((expectedIndex, observedIndex) =>
      expectedIndex === null ? null : { observedIndex, expectedIndex }
    )
    .filter((entry): entry is { observedIndex: number; expectedIndex: number } => entry !== null);

  for (let index = 1; index < mappedObservedIndices.length - 1; index += 1) {
    const current = mappedObservedIndices[index];
    const previousExpected = mappedObservedIndices[index - 1].expectedIndex;
    const nextExpected = mappedObservedIndices[index + 1].expectedIndex;
    for (
      let candidateExpected = previousExpected + 1;
      candidateExpected < nextExpected;
      candidateExpected += 1
    ) {
      if (candidateExpected === current.expectedIndex) continue;
      if (expected[candidateExpected] === observed[current.observedIndex]) return true;
    }
  }
  return false;
}

export function normalizeResidueSequence(sequence: string | undefined): string {
  return sequence?.replace(/[^A-Za-z]/g, '').toUpperCase() ?? '';
}

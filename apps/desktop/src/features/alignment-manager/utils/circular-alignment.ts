import { callAlignmentApi, type AlignmentApiResponse } from './alignment-api';

export interface CircularAlignmentInput {
  query: string;
  reference: string;
  isCircular: boolean;
  timeoutMs?: number;
}

export interface CircularAlignmentResult extends AlignmentApiResponse {
  wraps: boolean;
  refStart: number;
  refEnd: number;
}

export class CircularAlignmentMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CircularAlignmentMismatchError';
  }
}

function readCoverageCrossesOrigin(
  alignedQuery: string,
  alignedReference: string,
  matchPosInDoubled: number,
  L: number
): boolean {
  let refIdx = 0;
  let firstCoveredRefIdx = -1;
  let lastCoveredRefIdx = -1;
  const len = Math.min(alignedQuery.length, alignedReference.length);
  for (let i = 0; i < len; i++) {
    const q = alignedQuery[i];
    const r = alignedReference[i];
    if (q !== '-' && r !== '-') {
      if (firstCoveredRefIdx === -1) firstCoveredRefIdx = refIdx;
      lastCoveredRefIdx = refIdx;
    }
    if (r !== '-') refIdx++;
  }
  if (firstCoveredRefIdx === -1) return false;
  const readRefStart = matchPosInDoubled + firstCoveredRefIdx;
  const readRefEnd = matchPosInDoubled + lastCoveredRefIdx + 1;
  return readRefStart < L && readRefEnd > L;
}

export async function callPairwiseCircularAware(
  input: CircularAlignmentInput
): Promise<CircularAlignmentResult> {
  const { query, reference, isCircular, timeoutMs } = input;
  const L = reference.length;

  if (!isCircular) {
    const api = await callAlignmentApi(query, reference, timeoutMs);
    const ungappedRef = api.aligned_reference.replace(/-/g, '');
    if (ungappedRef.length === 0) {
      throw new CircularAlignmentMismatchError(
        'aligned_reference is empty after gap removal — sidecar returned no matchable positions'
      );
    }

    const refStart = reference.toUpperCase().indexOf(ungappedRef.toUpperCase());
    if (refStart < 0) {
      throw new CircularAlignmentMismatchError(
        'aligned_reference substring not found in reference — wrong reference passed to alignment?'
      );
    }

    return {
      ...api,
      wraps: false,
      refStart,
      refEnd: refStart + ungappedRef.length,
    };
  }

  const doubled = reference + reference;
  const api = await callAlignmentApi(query, doubled, timeoutMs);
  const ungappedRef = api.aligned_reference.replace(/-/g, '');
  if (ungappedRef.length === 0) {
    throw new CircularAlignmentMismatchError(
      'aligned_reference is empty after gap removal — sidecar returned no matchable positions'
    );
  }

  const matchPos = doubled.toUpperCase().indexOf(ungappedRef.toUpperCase());
  if (matchPos < 0) {
    throw new CircularAlignmentMismatchError(
      'aligned_reference substring not found in doubled reference — wrong reference passed to alignment?'
    );
  }

  const matchLen = ungappedRef.length;
  const matchEnd = matchPos + matchLen;

  if (matchPos >= L) {
    const canonicalStart = matchPos - L;
    return {
      ...api,
      wraps: false,
      refStart: canonicalStart,
      refEnd: canonicalStart + matchLen,
    };
  }

  const wraps = readCoverageCrossesOrigin(api.aligned_query, api.aligned_reference, matchPos, L);
  return {
    ...api,
    wraps,
    refStart: matchPos,
    refEnd: matchEnd,
  };
}

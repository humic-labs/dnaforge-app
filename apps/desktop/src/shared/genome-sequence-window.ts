import type { GenomeSequenceWindowRequest } from './indexed-genome';

export const MAX_SEQUENCE_WINDOW_BASES = 512 * 1024;

export function sequenceWindowRequestIssue(
  request: Pick<GenomeSequenceWindowRequest, 'start' | 'end' | 'generation'>
): 'start-end-not-finite' | 'generation-not-finite' | 'invalid-range' | 'too-large' | null {
  if (!Number.isFinite(request.start) || !Number.isFinite(request.end)) {
    return 'start-end-not-finite';
  }
  if (!Number.isFinite(request.generation)) return 'generation-not-finite';
  if (request.start < 0 || request.end < request.start) return 'invalid-range';
  if (request.end - request.start > MAX_SEQUENCE_WINDOW_BASES) return 'too-large';
  return null;
}

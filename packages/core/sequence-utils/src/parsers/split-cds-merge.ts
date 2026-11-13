export interface MergeCandidate {
  start: number;
  end: number;
  type: string;
  name: string;
  identity?: string;
  directionKey: string;
  hasSegments: boolean;
  preserveSourceFeature?: boolean;
}

export const MIN_EXON_COVERAGE = 0.5;

export function planSplitCDSMerges(candidates: readonly MergeCandidate[]): number[][] {
  const groups = new Map<string, number[]>();
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (c.type !== 'CDS' || c.hasSegments || c.preserveSourceFeature) continue;
    const key = c.identity
      ? `id\x00${c.identity}\x00${c.directionKey}`
      : `nm\x00${c.name}\x00${c.directionKey}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(i);
    else groups.set(key, [i]);
  }

  const plans: number[][] = [];
  for (const indices of groups.values()) {
    if (indices.length < 2) continue;

    indices.sort((a, b) => candidates[a].start - candidates[b].start);

    let hasOverlap = false;
    let overlapJunctions = 0;
    for (let i = 1; i < indices.length; i++) {
      if (candidates[indices[i]].start < candidates[indices[i - 1]].end) {
        hasOverlap = true;
        break;
      }
      if (candidates[indices[i]].start === candidates[indices[i - 1]].end) overlapJunctions += 1;
    }
    if (hasOverlap) continue;

    if (overlapJunctions > 0) {
      const firstPiece = candidates[indices[0]];
      const lastPiece = candidates[indices[indices.length - 1]];
      const codingLength = lastPiece.end - firstPiece.start + 1 + overlapJunctions;
      if (codingLength % 3 !== 0) continue;
    }

    if (!candidates[indices[0]].identity) {
      const first = candidates[indices[0]];
      const last = candidates[indices[indices.length - 1]];
      const span = last.end - first.start + 1;
      let exonCoverage = 0;
      let unionCursor = -Infinity;
      for (const idx of indices) {
        const c = candidates[idx];
        const from = Math.max(c.start, unionCursor + 1);
        if (c.end >= from) {
          exonCoverage += c.end - from + 1;
          unionCursor = c.end;
        }
      }
      if (span <= 0 || exonCoverage / span < MIN_EXON_COVERAGE) continue;

      const groupSet = new Set(indices);
      let hasInterveningFeature = false;
      for (let i = 1; i < indices.length && !hasInterveningFeature; i++) {
        const gapStart = candidates[indices[i - 1]].end;
        const gapEnd = candidates[indices[i]].start;
        for (let j = 0; j < candidates.length; j++) {
          if (groupSet.has(j)) continue;
          const other = candidates[j];
          if (other.start > gapStart && other.end < gapEnd) {
            hasInterveningFeature = true;
            break;
          }
        }
      }
      if (hasInterveningFeature) continue;
    }

    plans.push(indices);
  }

  return plans;
}

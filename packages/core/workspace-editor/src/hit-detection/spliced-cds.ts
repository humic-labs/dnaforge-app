export function orderedCdsSegments(cds: {
  start: number;
  end: number;
  segments?: Array<{ start: number; end: number }>;
}): Array<{ start: number; end: number }> {
  const segments = cds.segments ?? [];
  return cds.start > cds.end
    ? segments
        .slice()
        .sort(
          (a, b) =>
            (a.start < cds.start ? 1 : 0) - (b.start < cds.start ? 1 : 0) || a.start - b.start
        )
    : segments;
}

export function findSplicedCodonAtPosition(
  seqPos: number,
  segments: Array<{ start: number; end: number }>
): { start: number; end: number } | null {
  const result = findSplicedCodonWithIndexAtPosition(seqPos, segments);
  return result ? { start: result.start, end: result.end } : null;
}

export function findSplicedCodonWithIndexAtPosition(
  seqPos: number,
  segments: Array<{ start: number; end: number }>,
  options: { strand?: 1 | -1; codonStartOffset?: number } = {}
): { start: number; end: number; codonIndex: number } | null {
  const reverse = options.strand === -1;
  const ordered = reverse ? segments.slice().reverse() : segments;
  const frame = options.codonStartOffset ?? 0;
  let splicedPos = 0;
  let found = false;
  for (let si = 0; si < ordered.length; si++) {
    const segStart0 = ordered[si].start - 1;
    const segEnd0 = ordered[si].end;
    const segLen = segEnd0 - segStart0;
    if (seqPos >= segStart0 && seqPos < segEnd0) {
      splicedPos += reverse ? segEnd0 - 1 - seqPos : seqPos - segStart0;
      found = true;
      break;
    }
    splicedPos += segLen;
  }
  if (!found) return null;
  if (splicedPos < frame) return null;

  const codonIdx = Math.floor((splicedPos - frame) / 3);
  const start = frame + codonIdx * 3;
  const splicedPositions = [start, start + 1, start + 2];

  const genomicPositions: number[] = [];
  for (const sp of splicedPositions) {
    let rem = sp;
    for (const seg of ordered) {
      const segLen = seg.end - seg.start + 1;
      if (rem < segLen) {
        genomicPositions.push(reverse ? seg.end - 1 - rem : seg.start - 1 + rem);
        break;
      }
      rem -= segLen;
    }
  }

  if (genomicPositions.length < 3) return null;

  return {
    start: Math.min(...genomicPositions),
    end: Math.max(...genomicPositions),
    codonIndex: codonIdx,
  };
}

export function findIntronAtPosition(
  seqPos: number,
  segments: Array<{ start: number; end: number }>,
  sequenceLength?: number
): { start: number; end: number } | null {
  for (let i = 0; i < segments.length - 1; i++) {
    const current = segments[i];
    const next = segments[i + 1];
    const gapStart = current.end;
    const gapEnd = next.start - 2;
    if (gapEnd >= gapStart && seqPos >= gapStart && seqPos <= gapEnd) {
      return { start: gapStart, end: gapEnd };
    }
    const wrapsOrigin = next.start < current.start;
    if (wrapsOrigin && (seqPos >= gapStart || seqPos <= gapEnd)) {
      return {
        start: gapStart,
        end: gapEnd < 0 && sequenceLength !== undefined ? sequenceLength - 1 : gapEnd,
      };
    }
  }
  return null;
}

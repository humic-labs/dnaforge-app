import type { ResidueLocation } from '../../page/public/embeds/structure3d/types';

export interface CdsBounds {
  cdsStart: number;
  cdsEnd: number;
  strand: 1 | -1;
  segments?: ReadonlyArray<{ start: number; end: number }>;
}

export function codonToBpRange(
  codonIndex: number,
  bounds: CdsBounds
): { start: number; end: number } | null {
  if (codonIndex < 0) return null;
  if (bounds.segments && bounds.segments.length > 0) {
    return splicedCodonToBpRange(codonIndex, bounds);
  }
  const cdsLen = bounds.cdsEnd - bounds.cdsStart + 1;
  const codonStartOffset = codonIndex * 3;
  if (codonStartOffset + 2 >= cdsLen) return null;
  if (bounds.strand === 1) {
    const start = bounds.cdsStart + codonStartOffset;
    return { start, end: start + 2 };
  }
  const end = bounds.cdsEnd - codonStartOffset;
  return { start: end - 2, end };
}

function splicedCodonToBpRange(
  codonIndex: number,
  bounds: CdsBounds
): { start: number; end: number } | null {
  const segments = bounds.segments!;
  const targetBpOffset = codonIndex * 3;
  const forward = bounds.strand === 1;

  const orderedSegs = forward ? segments : [...segments].reverse();
  let cumulative = 0;
  const codonBps: number[] = [];
  for (const seg of orderedSegs) {
    const segLen = seg.end - seg.start + 1;
    const segCdsStart = cumulative;
    const segCdsEnd = cumulative + segLen - 1;
    for (let k = 0; k < 3; k++) {
      const wantCdsPos = targetBpOffset + k;
      if (wantCdsPos < segCdsStart || wantCdsPos > segCdsEnd) continue;
      const offsetInSeg = wantCdsPos - segCdsStart;
      const bp = forward ? seg.start + offsetInSeg : seg.end - offsetInSeg;
      codonBps.push(bp);
    }
    cumulative += segLen;
  }
  if (codonBps.length !== 3) return null;
  return {
    start: Math.min(...codonBps),
    end: Math.max(...codonBps),
  };
}

export function bpToCodonIndex(bpPos: number, bounds: CdsBounds): number | null {
  if (bpPos < bounds.cdsStart || bpPos > bounds.cdsEnd) return null;
  if (bounds.segments && bounds.segments.length > 0) {
    return splicedBpToCodonIndex(bpPos, bounds);
  }
  if (bounds.strand === 1) {
    return Math.floor((bpPos - bounds.cdsStart) / 3);
  }
  return Math.floor((bounds.cdsEnd - bpPos) / 3);
}

function splicedBpToCodonIndex(bpPos: number, bounds: CdsBounds): number | null {
  const segments = bounds.segments!;
  const forward = bounds.strand === 1;
  const orderedSegs = forward ? segments : [...segments].reverse();
  let cumulative = 0;
  for (const seg of orderedSegs) {
    if (bpPos >= seg.start && bpPos <= seg.end) {
      const offsetInSeg = forward ? bpPos - seg.start : seg.end - bpPos;
      return Math.floor((cumulative + offsetInSeg) / 3);
    }
    cumulative += seg.end - seg.start + 1;
  }
  return null;
}

export function residueToCodonIndex(residue: ResidueLocation): number | null {
  if (residue.compId) return null;
  if (residue.position <= 0) return null;
  return residue.position - 1;
}

export function codonIndexToResidue(codonIndex: number, chain: string): ResidueLocation {
  return { chain, position: codonIndex + 1 };
}

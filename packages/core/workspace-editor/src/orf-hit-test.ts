import type { ORF } from '@waypoint/sequence-utils';
import type { ORFWithLane } from './types';
import { ORF_LANE_GAP } from './orf-drawing';

export interface OrfBand {
  bandY: number;
  bandHeight: number;
  laneCount: number;
  laneHeight: number;
  orfs: readonly ORFWithLane[];
}

export function findOrfAtPointInBand(band: OrfBand, mouseY: number, position: number): ORF | null {
  if (band.laneCount <= 0 || band.bandHeight <= 0 || band.orfs.length === 0) return null;
  if (mouseY < band.bandY || mouseY >= band.bandY + band.bandHeight) return null;

  const laneStep = band.laneHeight + ORF_LANE_GAP;
  const relativeY = mouseY - band.bandY;
  const clickedLane = Math.floor(relativeY / laneStep);
  if (clickedLane < 0 || clickedLane >= band.laneCount) return null;
  if (relativeY - clickedLane * laneStep > band.laneHeight) return null;

  for (const orf of band.orfs) {
    if (orf.lane !== clickedLane) continue;
    if (position < orf.start || position > orf.end) continue;
    return orf;
  }
  return null;
}

export function findOrfAtPoint(
  forward: OrfBand,
  reverse: OrfBand,
  mouseY: number,
  position: number
): ORF | null {
  return (
    findOrfAtPointInBand(forward, mouseY, position) ??
    findOrfAtPointInBand(reverse, mouseY, position)
  );
}

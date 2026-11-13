import type { Layout2DRow, LinePositions, PrimerDisplay, WorkspaceEditorConfig } from './types';
import { computeLineTrackPositions } from './line-track-layout';
import { packPrimerLanes, primerOverlapsLine } from './primer-layout';

export function calculateLinePositions(
  line: Layout2DRow,
  config: WorkspaceEditorConfig,
  primers: readonly PrimerDisplay[],
  seqLen: number,
  hasMutTrackGlobal = line.hasMutationTrack ?? false
): LinePositions {
  let forwardPrimerLaneCount = line.forwardPrimerLaneCount ?? 0;
  let reversePrimerLaneCount = line.reversePrimerLaneCount ?? 0;
  if (
    line.forwardPrimerLaneCount === undefined &&
    !config.overviewLod &&
    config.lodLevel !== 'density' &&
    config.showPrimers &&
    primers.length > 0
  ) {
    const overlapping = primers.filter((primer) =>
      primerOverlapsLine(primer, line.startPos, line.endPos, seqLen)
    );
    const forward = overlapping.filter((primer) => primer.direction === 'forward');
    const reverse = overlapping.filter((primer) => primer.direction === 'reverse');
    forwardPrimerLaneCount = packPrimerLanes(forward, line.startPos, line.endPos, seqLen).laneCount;
    reversePrimerLaneCount = packPrimerLanes(reverse, line.startPos, line.endPos, seqLen).laneCount;
  }
  const packedLine =
    line.forwardPrimerLaneCount === undefined
      ? { ...line, forwardPrimerLaneCount, reversePrimerLaneCount }
      : line;
  return { ...computeLineTrackPositions(packedLine, config, hasMutTrackGlobal), line };
}

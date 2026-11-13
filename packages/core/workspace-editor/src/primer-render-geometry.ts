import type { PrimerDisplay, RenderedPrimerSegment, RenderedPrimerSegmentRole } from './types';
import { PRIMER_CANVAS_CONSTANTS } from './canvas-constants';
import { packPrimerLanes, primerOverlapsLine } from './primer-layout';

interface VisiblePrimerRange {
  start: number;
  end: number;
  charIndexStart: number;
  primerBaseStart: number;
  primerBaseEnd: number;
}

export interface ComputeRenderedPrimerSegmentsInput {
  primers: readonly PrimerDisplay[];
  direction: 'forward' | 'reverse';
  lineStartPos: number;
  lineEndPos: number;
  originX: number;
  bandTop: number;
  charWidth: number;
  rowHeight: number;
  sequenceLength: number;
  cycleOffset?: number;
  viewportLeftX?: number;
  viewportRightX?: number;
}

interface PrimerRoleRange {
  role: RenderedPrimerSegmentRole;
  startBase: number;
  endBase: number;
}

export function computeRenderedPrimerSegments({
  primers,
  direction,
  lineStartPos,
  lineEndPos,
  originX,
  bandTop,
  charWidth,
  rowHeight,
  sequenceLength,
  cycleOffset = 0,
  viewportLeftX,
  viewportRightX,
}: ComputeRenderedPrimerSegmentsInput): RenderedPrimerSegment[] {
  if (primers.length === 0 || sequenceLength <= 0 || charWidth <= 0 || rowHeight <= 0) {
    return [];
  }

  const linePrimers = primers.filter(
    (primer) =>
      primer.direction === direction &&
      primerOverlapsLine(primer, lineStartPos, lineEndPos, sequenceLength)
  );
  if (linePrimers.length === 0) return [];

  const { laneMap } = packPrimerLanes(linePrimers, lineStartPos, lineEndPos, sequenceLength);
  const laneHeight =
    rowHeight *
    (PRIMER_CANVAS_CONSTANTS.TRACK_HEIGHT_RATIO + PRIMER_CANVAS_CONSTANTS.ARROW_PADDING_RATIO);
  const rendered: RenderedPrimerSegment[] = [];

  for (const primer of linePrimers) {
    const lane = laneMap.get(primer.id) ?? 0;
    const y = bandTop + lane * laneHeight - 1;
    const fullLength = primerLength(primer, sequenceLength);
    if (fullLength <= 0) continue;

    const roleRanges = primerRoleRanges(primer, fullLength);
    const visibleRanges = visiblePrimerRanges(primer, lineStartPos, lineEndPos, sequenceLength);
    for (const visible of visibleRanges) {
      for (const roleRange of roleRanges) {
        const baseStart = Math.max(visible.primerBaseStart, roleRange.startBase);
        const baseEnd = Math.min(visible.primerBaseEnd, roleRange.endBase);
        if (baseEnd <= baseStart) continue;

        const x =
          originX + (visible.charIndexStart + baseStart - visible.primerBaseStart) * charWidth;
        const width = (baseEnd - baseStart) * charWidth;
        const segmentStart = visible.start + baseStart - visible.primerBaseStart;
        const segmentEnd = segmentStart + baseEnd - baseStart;
        if (
          (viewportLeftX !== undefined && x + width < viewportLeftX - 2) ||
          (viewportRightX !== undefined && x > viewportRightX + 2)
        ) {
          continue;
        }

        rendered.push({
          primer,
          primerId: primer.id,
          sourcePrimerId: primer.sourcePrimerId,
          direction: primer.direction,
          role: roleRange.role,
          start: segmentStart + cycleOffset,
          end: segmentEnd + cycleOffset,
          primerBaseStart: baseStart,
          primerBaseEnd: baseEnd,
          x,
          y,
          width,
          height: laneHeight,
          lane,
          cycleOffset,
        });
      }
    }
  }

  return rendered;
}

function primerLength(primer: PrimerDisplay, sequenceLength: number): number {
  if (primer.start > primer.end) return sequenceLength - primer.start + primer.end;
  return primer.end - primer.start;
}

function primerRoleRanges(primer: PrimerDisplay, fullLength: number): PrimerRoleRange[] {
  const overhangLength = Math.max(0, Math.min(primer.overhangLength ?? 0, fullLength));
  if (overhangLength === 0) return [{ role: 'pbs', startBase: 0, endBase: fullLength }];

  const pbsLength = fullLength - overhangLength;
  const spacerLength = Math.max(0, Math.min(primer.spacerLength ?? 0, overhangLength));
  const roles: PrimerRoleRange[] = [];

  if (primer.direction === 'forward') {
    const tailEnd = overhangLength - spacerLength;
    pushRoleRange(roles, 'tail', 0, tailEnd);
    pushRoleRange(roles, 'spacer', tailEnd, overhangLength);
    pushRoleRange(roles, 'pbs', overhangLength, fullLength);
    pushGoldenGateEnzymeRole(roles, primer, 0, overhangLength, fullLength);
  } else {
    pushRoleRange(roles, 'pbs', 0, pbsLength);
    pushRoleRange(roles, 'spacer', pbsLength, pbsLength + spacerLength);
    pushRoleRange(roles, 'tail', pbsLength + spacerLength, fullLength);
    pushGoldenGateEnzymeRole(roles, primer, pbsLength, fullLength, fullLength);
  }

  return roles;
}

function pushGoldenGateEnzymeRole(
  roles: PrimerRoleRange[],
  primer: PrimerDisplay,
  overhangStart: number,
  overhangEnd: number,
  fullLength: number
): void {
  const cut = primer.cutPositionInOverhang;
  if (cut === undefined || cut <= 0 || overhangEnd <= overhangStart) return;
  if (primer.direction === 'forward') {
    pushRoleRange(roles, 'enzyme-site', overhangStart, Math.min(overhangStart + cut, overhangEnd));
  } else {
    pushRoleRange(roles, 'enzyme-site', Math.max(overhangEnd - cut, overhangStart), fullLength);
  }
}

function pushRoleRange(
  roles: PrimerRoleRange[],
  role: RenderedPrimerSegmentRole,
  startBase: number,
  endBase: number
): void {
  if (endBase <= startBase) return;
  roles.push({ role, startBase, endBase });
}

function visiblePrimerRanges(
  primer: PrimerDisplay,
  lineStartPos: number,
  lineEndPos: number,
  sequenceLength: number
): VisiblePrimerRange[] {
  const primerSpansOrigin = primer.start > primer.end;
  const ranges: VisiblePrimerRange[] = [];

  if (primerSpansOrigin) {
    pushVisibleRange(ranges, {
      rangeStart: primer.start,
      rangeEnd: sequenceLength,
      lineStartPos,
      lineEndPos,
      sequenceLength,
      primerBaseOffset: 0,
    });
    pushVisibleRange(ranges, {
      rangeStart: 0,
      rangeEnd: primer.end,
      lineStartPos,
      lineEndPos,
      sequenceLength,
      primerBaseOffset: sequenceLength - primer.start,
    });
    return ranges;
  }

  pushVisibleRange(ranges, {
    rangeStart: primer.start,
    rangeEnd: primer.end,
    lineStartPos,
    lineEndPos,
    sequenceLength,
    primerBaseOffset: 0,
  });
  return ranges;
}

function pushVisibleRange(
  ranges: VisiblePrimerRange[],
  input: {
    rangeStart: number;
    rangeEnd: number;
    lineStartPos: number;
    lineEndPos: number;
    sequenceLength: number;
    primerBaseOffset: number;
  }
): void {
  const lineRanges =
    input.lineStartPos <= input.lineEndPos
      ? [{ start: input.lineStartPos, end: input.lineEndPos, charOffset: 0 }]
      : [
          { start: input.lineStartPos, end: input.sequenceLength, charOffset: 0 },
          {
            start: 0,
            end: input.lineEndPos,
            charOffset: input.sequenceLength - input.lineStartPos,
          },
        ];

  for (const line of lineRanges) {
    const start = Math.max(input.rangeStart, line.start);
    const end = Math.min(input.rangeEnd, line.end);
    if (end <= start) continue;
    const primerBaseStart = input.primerBaseOffset + start - input.rangeStart;
    const primerBaseEnd = primerBaseStart + end - start;
    ranges.push({
      start,
      end,
      charIndexStart: line.charOffset + start - line.start,
      primerBaseStart,
      primerBaseEnd,
    });
  }
}

import { describe, it, expect } from 'vitest';
import { gappedToBio, bioToGapped } from '../coordinate-space';

interface LayoutLine {
  startPos: number;
  endPos: number;
  y: number;
  sequence: string;
}

interface MockLayout {
  lines: LayoutLine[];
  sequenceLength: number;
  totalHeight: number;
}

interface PendingScrollTarget {
  position: number;
  atViewportTop: boolean;
  capturedGappedSequence?: string;
}

function getSequencePositionAtY(y: number, layout: MockLayout | null): number | null {
  if (!layout || !layout.lines.length) return null;

  const lineIndex = layout.lines.findIndex((line, idx) => {
    const nextLine = layout.lines[idx + 1];
    const lineBottom = nextLine ? nextLine.y : line.y + 100;
    return y >= line.y && y < lineBottom;
  });

  if (lineIndex === -1) {
    if (y < layout.lines[0].y) return layout.lines[0].startPos;
    return layout.lines[layout.lines.length - 1].endPos;
  }

  const line = layout.lines[lineIndex];
  const nextLine = layout.lines[lineIndex + 1];
  const lineHeight = nextLine ? nextLine.y - line.y : 100;

  const progressInLine = Math.max(0, Math.min(1, (y - line.y) / lineHeight));
  const charOffset = Math.floor(progressInLine * line.sequence.length);

  return (line.startPos + charOffset) % (layout.sequenceLength || 1);
}

function captureMutationTrackPosition_FIXED(
  scrollTop: number,
  clientHeight: number,
  layout: MockLayout,
  lastKnownPosition: number | null,
  layoutCoordinateSpaceTag: string | undefined
): PendingScrollTarget | null {
  let centerPos: number | null = null;

  if (scrollTop > 0) {
    const scrollCenterY = scrollTop + clientHeight / 2;
    centerPos = getSequencePositionAtY(scrollCenterY, layout);
  } else {
    centerPos = lastKnownPosition;
  }

  if (centerPos === null) return null;

  return {
    position: centerPos,
    atViewportTop: false,
    capturedGappedSequence: layoutCoordinateSpaceTag,
  };
}

function captureMutationTrackPosition_BUGGY(
  scrollTop: number,
  clientHeight: number,
  layout: MockLayout,
  _lastKnownPosition: number | null,
  layoutCoordinateSpaceTag: string | undefined
): PendingScrollTarget | null {
  const scrollCenterY = scrollTop + clientHeight / 2;
  const centerPos = getSequencePositionAtY(scrollCenterY, layout);
  if (centerPos === null) return null;

  return {
    position: centerPos,
    atViewportTop: false,
    capturedGappedSequence: layoutCoordinateSpaceTag,
  };
}

function convertCapturedPosition(
  pending: PendingScrollTarget,
  currentlyGapped: boolean,
  currentGappedSequence: string | undefined
): number {
  let position = pending.position;
  const wasCapturedInGapped = !!pending.capturedGappedSequence;

  if (wasCapturedInGapped && !currentlyGapped && pending.capturedGappedSequence) {
    let col = position;
    let bioPos = gappedToBio(col, pending.capturedGappedSequence);
    if (bioPos < 0) {
      while (col > 0 && bioPos < 0) {
        col--;
        bioPos = gappedToBio(col, pending.capturedGappedSequence);
      }
    }
    if (bioPos > 0) {
      position = bioPos - 1;
    }
  } else if (!wasCapturedInGapped && currentlyGapped && currentGappedSequence) {
    const col = bioToGapped(position + 1, currentGappedSequence);
    if (col >= 0) {
      position = col;
    }
  }

  return position;
}

function getYForSequencePosition(pos: number, layout: MockLayout): number | null {
  for (let i = 0; i < layout.lines.length; i++) {
    const line = layout.lines[i];
    const nextLine = layout.lines[i + 1];
    if (pos >= line.startPos && (nextLine ? pos < nextLine.startPos : true)) {
      const progressInLine = (pos - line.startPos) / line.sequence.length;
      const lineHeight = nextLine ? nextLine.y - line.y : 100;
      return line.y + progressInLine * lineHeight;
    }
  }
  return null;
}

function buildGappedSequence(bioLength: number, gapInterval: number): string {
  const bases = 'ATCGATCGATCG';
  let result = '';
  let bioIdx = 0;
  let col = 0;
  while (bioIdx < bioLength) {
    if (col > 0 && col % gapInterval === 0) {
      result += '-';
    } else {
      result += bases[bioIdx % bases.length];
      bioIdx++;
    }
    col++;
  }
  return result;
}

function buildLayout(sequence: string, charsPerLine: number, lineHeight: number): MockLayout {
  const lines: LayoutLine[] = [];
  for (let i = 0; i < sequence.length; i += charsPerLine) {
    const lineSeq = sequence.slice(i, i + charsPerLine);
    lines.push({
      startPos: i,
      endPos: i + lineSeq.length - 1,
      y: lines.length * lineHeight,
      sequence: lineSeq,
    });
  }
  return {
    lines,
    sequenceLength: sequence.length,
    totalHeight: lines.length * lineHeight,
  };
}

function buildBioLayout(bioLength: number, charsPerLine: number, lineHeight: number): MockLayout {
  const bases = 'ATCGATCGATCG';
  let seq = '';
  for (let i = 0; i < bioLength; i++) {
    seq += bases[i % bases.length];
  }
  return buildLayout(seq, charsPerLine, lineHeight);
}

describe('Scroll preservation on pane close', () => {
  const BIO_LENGTH = 82000;
  const GAP_INTERVAL = 10;
  const CHARS_PER_LINE = 80;
  const LINE_HEIGHT = 120;
  const CLIENT_HEIGHT = 800;

  const gappedSequence = buildGappedSequence(BIO_LENGTH, GAP_INTERVAL);
  const gappedLayout = buildLayout(gappedSequence, CHARS_PER_LINE, LINE_HEIGHT);
  const bioLayout = buildBioLayout(BIO_LENGTH, CHARS_PER_LINE, LINE_HEIGHT);

  describe('hasMutationTrack effect: scrollTop=0 fallback', () => {
    it('FIXED: uses lastKnownPosition when scrollTop is 0 (DOM detached)', () => {
      const lastKnownGappedPosition = 40000;

      const scrollTop = 0;

      const result = captureMutationTrackPosition_FIXED(
        scrollTop,
        CLIENT_HEIGHT,
        gappedLayout,
        lastKnownGappedPosition,
        gappedSequence
      );

      expect(result).not.toBeNull();
      expect(result!.position).toBe(lastKnownGappedPosition);
      expect(result!.capturedGappedSequence).toBe(gappedSequence);
    });

    it('BUGGY: reads scrollTop=0 and captures near-top position (REGRESSION)', () => {
      const lastKnownGappedPosition = 40000;
      const scrollTop = 0;

      const result = captureMutationTrackPosition_BUGGY(
        scrollTop,
        CLIENT_HEIGHT,
        gappedLayout,
        lastKnownGappedPosition,
        gappedSequence
      );

      expect(result).not.toBeNull();
      expect(result!.position).toBeLessThan(500);
      expect(Math.abs(result!.position - lastKnownGappedPosition)).toBeGreaterThan(30000);
    });

    it('uses live scrollTop when it is valid (> 0)', () => {
      const scrollTop = 5000;
      const lastKnownGappedPosition = 40000;

      const result = captureMutationTrackPosition_FIXED(
        scrollTop,
        CLIENT_HEIGHT,
        gappedLayout,
        lastKnownGappedPosition,
        gappedSequence
      );

      expect(result).not.toBeNull();
      expect(result!.position).not.toBe(lastKnownGappedPosition);
      const expectedCenterY = scrollTop + CLIENT_HEIGHT / 2;
      const expectedPos = getSequencePositionAtY(expectedCenterY, gappedLayout);
      expect(result!.position).toBe(expectedPos);
    });
  });

  describe('End-to-end: gapped capture → bio restore', () => {
    it('correctly converts gapped position to biological after pane close', () => {
      let lastKnownGappedPosition = 40000;
      while (gappedSequence[lastKnownGappedPosition] === '-') {
        lastKnownGappedPosition++;
      }

      const captured = captureMutationTrackPosition_FIXED(
        0,
        CLIENT_HEIGHT,
        gappedLayout,
        lastKnownGappedPosition,
        gappedSequence
      );
      expect(captured).not.toBeNull();

      const restoredBioPos = convertCapturedPosition(captured!, false, undefined);

      const expectedBioPos = gappedToBio(lastKnownGappedPosition, gappedSequence);
      expect(expectedBioPos).toBeGreaterThan(0);

      expect(restoredBioPos).toBe(expectedBioPos - 1);
    });

    it('falls back to nearest non-gap when position lands on a gap', () => {
      let gapCol = -1;
      for (let i = 1000; i < gappedSequence.length; i++) {
        if (gappedSequence[i] === '-') {
          gapCol = i;
          break;
        }
      }
      expect(gapCol).toBeGreaterThan(0);

      const captured = captureMutationTrackPosition_FIXED(
        0,
        CLIENT_HEIGHT,
        gappedLayout,
        gapCol,
        gappedSequence
      );

      const restoredBioPos = convertCapturedPosition(captured!, false, undefined);

      let nearestNonGapCol = gapCol;
      while (nearestNonGapCol > 0 && gappedSequence[nearestNonGapCol] === '-') {
        nearestNonGapCol--;
      }
      const expectedBioPos = gappedToBio(nearestNonGapCol, gappedSequence);
      expect(restoredBioPos).toBe(expectedBioPos - 1);
    });

    it('restored position maps to approximately the same Y coordinate', () => {
      const lastKnownGappedPosition = 40000;

      const captured = captureMutationTrackPosition_FIXED(
        0,
        CLIENT_HEIGHT,
        gappedLayout,
        lastKnownGappedPosition,
        gappedSequence
      );

      const restoredBioPos = convertCapturedPosition(captured!, false, undefined);

      const gappedY = getYForSequencePosition(lastKnownGappedPosition, gappedLayout);
      const bioY = getYForSequencePosition(restoredBioPos, bioLayout);

      expect(gappedY).not.toBeNull();
      expect(bioY).not.toBeNull();

      const gappedFraction = gappedY! / gappedLayout.totalHeight;
      const bioFraction = bioY! / bioLayout.totalHeight;
      expect(Math.abs(gappedFraction - bioFraction)).toBeLessThan(0.1);
    });
  });

  describe('ResizeObserver: synchronous coordinate space capture', () => {
    it('captures coordinate space before it can be overwritten', () => {
      let testPos = 40000;
      while (gappedSequence[testPos] === '-') {
        testPos++;
      }

      const capturedSyncTag = gappedSequence;

      const overwrittenTag = undefined;

      const pending: PendingScrollTarget = {
        position: testPos,
        atViewportTop: false,
        capturedGappedSequence: capturedSyncTag,
      };

      const converted = convertCapturedPosition(pending, false, undefined);
      const expectedBio = gappedToBio(testPos, gappedSequence);
      expect(expectedBio).toBeGreaterThan(0);
      expect(converted).toBe(expectedBio - 1);

      const pendingBuggy: PendingScrollTarget = {
        position: testPos,
        atViewportTop: false,
        capturedGappedSequence: overwrittenTag,
      };
      const convertedBuggy = convertCapturedPosition(pendingBuggy, false, undefined);
      expect(convertedBuggy).toBe(testPos);
      expect(convertedBuggy).not.toBe(converted);
    });
  });

  describe('Edge cases', () => {
    it('handles lastKnownPosition being null (initial state before any scroll)', () => {
      const result = captureMutationTrackPosition_FIXED(
        0,
        CLIENT_HEIGHT,
        gappedLayout,
        null,
        gappedSequence
      );

      expect(result).toBeNull();
    });

    it('handles scrollTop=0 at actual top of document (not DOM detach)', () => {
      const lastKnownPosition = 5;

      const result = captureMutationTrackPosition_FIXED(
        0,
        CLIENT_HEIGHT,
        gappedLayout,
        lastKnownPosition,
        gappedSequence
      );

      expect(result).not.toBeNull();
      expect(result!.position).toBe(5);
    });

    it('preserves position at various scroll depths', () => {
      const testPositions = [100, 5000, 20000, 40000, 60000, 80000];

      for (const gappedPos of testPositions) {
        if (gappedPos >= gappedSequence.length) continue;

        const captured = captureMutationTrackPosition_FIXED(
          0,
          CLIENT_HEIGHT,
          gappedLayout,
          gappedPos,
          gappedSequence
        );

        expect(captured).not.toBeNull();
        expect(captured!.position).toBe(gappedPos);

        const bioPos = convertCapturedPosition(captured!, false, undefined);
        const expectedBio = gappedToBio(gappedPos, gappedSequence);

        if (expectedBio > 0) {
          expect(bioPos).toBe(expectedBio - 1);
        } else {
          expect(bioPos).toBeGreaterThanOrEqual(0);
          expect(bioPos).toBeLessThan(BIO_LENGTH);
        }
      }
    });
  });
});

import { describe, it, expect } from 'vitest';
import { bioToGapped } from '../coordinate-space';

interface LayoutLine {
  startPos: number;
  endPos: number;
  y: number;
  sequence: string;
  isBottomBuffer?: boolean;
}

interface MockLayout {
  lines: LayoutLine[];
  sequenceLength: number;
  firstRealRowIndex?: number;
  firstBottomBufferIndex?: number;
}

function findLineForPosition(scrollToPosition: number, layout: MockLayout): LayoutLine | null {
  if (scrollToPosition == null || !layout.lines.length) return null;

  const pos = scrollToPosition - 1;
  const { firstRealRowIndex = 0, firstBottomBufferIndex = layout.lines.length } = layout;

  const lineContainsPos = (l: LayoutLine, idx: number): boolean => {
    const nextLine = layout.lines[idx + 1];
    const lineSpansOrigin = l.startPos > l.endPos;

    if (lineSpansOrigin) {
      return pos >= l.startPos || pos < l.endPos;
    }

    return pos >= l.startPos && (nextLine ? pos < nextLine.startPos : true);
  };

  let line =
    layout.lines.find((l, idx) => {
      if (idx < firstRealRowIndex || idx >= firstBottomBufferIndex) return false;
      return lineContainsPos(l, idx);
    }) ?? null;

  if (!line) {
    line = layout.lines.find((l, idx) => lineContainsPos(l, idx)) ?? null;
  }

  return line;
}

function buildBiologicalLayout(seqLength: number, charsPerLine: number): MockLayout {
  const lines: LayoutLine[] = [];
  const lineHeight = 60;

  for (let i = 0; i < seqLength; i += charsPerLine) {
    const endPos = Math.min(i + charsPerLine - 1, seqLength - 1);
    lines.push({
      startPos: i,
      endPos,
      y: lines.length * lineHeight,
      sequence: 'A'.repeat(endPos - i + 1),
    });
  }

  return { lines, sequenceLength: seqLength };
}

function buildGappedLayout(gappedLength: number, charsPerLine: number): MockLayout {
  const lines: LayoutLine[] = [];
  const lineHeight = 60;

  for (let i = 0; i < gappedLength; i += charsPerLine) {
    const endPos = Math.min(i + charsPerLine - 1, gappedLength - 1);
    lines.push({
      startPos: i,
      endPos,
      y: lines.length * lineHeight,
      sequence: 'A'.repeat(endPos - i + 1),
    });
  }

  return { lines, sequenceLength: gappedLength };
}

describe('scroll position line-finding in biological mode', () => {
  const layout = buildBiologicalLayout(1000, 100);

  it('finds correct line for position at start', () => {
    const line = findLineForPosition(1, layout);
    expect(line).not.toBeNull();
    expect(line!.startPos).toBe(0);
  });

  it('finds correct line for position in middle', () => {
    const line = findLineForPosition(350, layout);
    expect(line).not.toBeNull();
    expect(line!.startPos).toBe(300);
  });

  it('finds correct line for position at end', () => {
    const line = findLineForPosition(1000, layout);
    expect(line).not.toBeNull();
    expect(line!.startPos).toBe(900);
  });

  it('falls back to last line for position beyond sequence', () => {
    const line = findLineForPosition(2000, layout);
    expect(line).not.toBeNull();
    expect(line!.startPos).toBe(900);
  });
});

describe('scroll position line-finding in gapped mode', () => {
  const gappedLayout = buildGappedLayout(1200, 100);

  it('finds correct line when using gapped column + 1', () => {
    const line = findLineForPosition(501, gappedLayout);
    expect(line).not.toBeNull();
    expect(line!.startPos).toBe(500);
  });

  it('finds WRONG line when using biological position directly (THE BUG)', () => {
    const wrongLine = findLineForPosition(500, gappedLayout);
    expect(wrongLine).not.toBeNull();
    expect(wrongLine!.startPos).toBe(400);

    const correctLine = findLineForPosition(701, gappedLayout);
    expect(correctLine).not.toBeNull();
    expect(correctLine!.startPos).toBe(700);

    expect(wrongLine!.y).not.toBe(correctLine!.y);
  });
});

describe('scroll position with real coordinate conversion', () => {
  const gappedRef =
    'ATGCATGCAT' +
    '--' +
    'GCATGCATGC' +
    '---' +
    'ATGCATGCAT' +
    'GCATGCATGC' +
    '--' +
    'ATGCATGCAT' +
    'GCATGCATGC' +
    'ATGCATGCAT' +
    '---' +
    'GCATGCATGC' +
    'ATGCATGCAT';

  const gappedLayout = buildGappedLayout(gappedRef.length, 20);

  it('bioToGapped + 1 finds the correct line', () => {
    const bioPos = 50;
    const col = bioToGapped(bioPos, gappedRef);
    expect(col).toBeGreaterThanOrEqual(0);

    const correctLine = findLineForPosition(col + 1, gappedLayout);
    expect(correctLine).not.toBeNull();

    expect(col).toBeGreaterThanOrEqual(correctLine!.startPos);
    expect(col).toBeLessThanOrEqual(correctLine!.endPos);
  });

  it('passing bio position directly may find wrong line when gaps exist before it', () => {
    const bioPos = 30;
    const col = bioToGapped(bioPos, gappedRef);

    expect(col).toBeGreaterThan(bioPos - 1);

    const buggyLine = findLineForPosition(bioPos, gappedLayout);
    const correctLine = findLineForPosition(col + 1, gappedLayout);

    if (buggyLine && correctLine) {
      const buggyPos = bioPos - 1;
      const correctPos = col;
      if (Math.floor(buggyPos / 20) !== Math.floor(correctPos / 20)) {
        expect(buggyLine.startPos).not.toBe(correctLine.startPos);
      }
    }
  });

  it('both approaches agree when no gaps before the position', () => {
    const bioPos = 1;
    const col = bioToGapped(bioPos, gappedRef);
    expect(col).toBe(0);

    const buggyLine = findLineForPosition(bioPos, gappedLayout);
    const correctLine = findLineForPosition(col + 1, gappedLayout);

    expect(buggyLine!.startPos).toBe(correctLine!.startPos);
  });
});

describe('scroll position edge cases', () => {
  it('handles empty layout', () => {
    const emptyLayout: MockLayout = { lines: [], sequenceLength: 0 };
    expect(findLineForPosition(1, emptyLayout)).toBeNull();
  });

  it('handles single-line layout', () => {
    const singleLine: MockLayout = {
      lines: [{ startPos: 0, endPos: 49, y: 0, sequence: 'A'.repeat(50) }],
      sequenceLength: 50,
    };
    expect(findLineForPosition(25, singleLine)).not.toBeNull();
    expect(findLineForPosition(25, singleLine)!.startPos).toBe(0);
  });

  it('handles position at exact line boundary', () => {
    const layout = buildBiologicalLayout(200, 100);
    const line = findLineForPosition(101, layout);
    expect(line).not.toBeNull();
    expect(line!.startPos).toBe(100);
  });
});

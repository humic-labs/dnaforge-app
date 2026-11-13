import { describe, it, expect } from 'vitest';
import { bioToGapped, gappedToBio, countNonGaps } from '../coordinate-space';

function convertScrollPosition(
  capturedPosition: number,
  wasCapturedInGapped: boolean,
  capturedGappedSequence: string | undefined,
  currentlyGapped: boolean,
  currentGappedSequence: string | undefined
): number {
  let position = capturedPosition;

  if (wasCapturedInGapped && !currentlyGapped && capturedGappedSequence) {
    let col = position;
    let bioPos = gappedToBio(col, capturedGappedSequence);
    if (bioPos < 0) {
      while (col > 0 && bioPos < 0) {
        col--;
        bioPos = gappedToBio(col, capturedGappedSequence);
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

function charAtGappedCol(col: number, gappedSeq: string): string {
  return col >= 0 && col < gappedSeq.length ? gappedSeq[col] : '?';
}

function charAtBioPos(pos: number, bioSeq: string): string {
  return pos >= 0 && pos < bioSeq.length ? bioSeq[pos] : '?';
}

function stripGaps(gappedSeq: string): string {
  return gappedSeq.replace(/-/g, '');
}

describe('gapped → ungapped conversion (closing alignment)', () => {
  const gappedSeq = 'ATG--CATGC';
  const bioSeq = stripGaps(gappedSeq);

  it('converts non-gap column correctly', () => {
    const gappedCol = 6;
    expect(charAtGappedCol(gappedCol, gappedSeq)).toBe('A');

    const bioPos = convertScrollPosition(gappedCol, true, gappedSeq, false, undefined);

    expect(charAtBioPos(bioPos, bioSeq)).toBe('A');
  });

  it('converts first position correctly', () => {
    const gappedCol = 0;
    expect(charAtGappedCol(gappedCol, gappedSeq)).toBe('A');

    const bioPos = convertScrollPosition(gappedCol, true, gappedSeq, false, undefined);
    expect(bioPos).toBe(0);
    expect(charAtBioPos(bioPos, bioSeq)).toBe('A');
  });

  it('converts last position correctly', () => {
    const gappedCol = 9;
    expect(charAtGappedCol(gappedCol, gappedSeq)).toBe('C');

    const bioPos = convertScrollPosition(gappedCol, true, gappedSeq, false, undefined);
    expect(bioPos).toBe(7);
    expect(charAtBioPos(bioPos, bioSeq)).toBe('C');
  });

  it('converts position right after gaps correctly', () => {
    const gappedCol = 5;
    expect(charAtGappedCol(gappedCol, gappedSeq)).toBe('C');

    const bioPos = convertScrollPosition(gappedCol, true, gappedSeq, false, undefined);
    expect(bioPos).toBe(3);
    expect(charAtBioPos(bioPos, bioSeq)).toBe('C');
  });

  it('handles gap column by walking back to nearest non-gap', () => {
    const gappedCol = 3;
    expect(charAtGappedCol(gappedCol, gappedSeq)).toBe('-');

    const result = convertScrollPosition(gappedCol, true, gappedSeq, false, undefined);
    expect(result).toBe(2);
    expect(charAtBioPos(result, bioSeq)).toBe('G');
  });

  it('handles second gap column by walking back to nearest non-gap', () => {
    const gappedCol = 4;
    expect(charAtGappedCol(gappedCol, gappedSeq)).toBe('-');

    const result = convertScrollPosition(gappedCol, true, gappedSeq, false, undefined);
    expect(result).toBe(2);
    expect(charAtBioPos(result, bioSeq)).toBe('G');
  });

  it('handles leading gaps (no non-gap before position)', () => {
    const leadingGaps = '--ATGCATGC';
    const _leadingBio = stripGaps(leadingGaps);

    const result = convertScrollPosition(0, true, leadingGaps, false, undefined);
    expect(result).toBe(0);
  });
});

describe('ungapped → gapped conversion (opening alignment)', () => {
  const gappedSeq = 'ATG--CATGC';
  const bioSeq = stripGaps(gappedSeq);

  it('converts bio position correctly', () => {
    const bioPos = 3;
    expect(charAtBioPos(bioPos, bioSeq)).toBe('C');

    const gappedCol = convertScrollPosition(bioPos, false, undefined, true, gappedSeq);

    expect(gappedCol).toBe(5);
    expect(charAtGappedCol(gappedCol, gappedSeq)).toBe('C');
  });

  it('converts first position correctly', () => {
    const bioPos = 0;
    const gappedCol = convertScrollPosition(bioPos, false, undefined, true, gappedSeq);
    expect(gappedCol).toBe(0);
    expect(charAtGappedCol(gappedCol, gappedSeq)).toBe(charAtBioPos(bioPos, bioSeq));
  });

  it('converts last position correctly', () => {
    const bioPos = 7;
    const gappedCol = convertScrollPosition(bioPos, false, undefined, true, gappedSeq);
    expect(gappedCol).toBe(9);
    expect(charAtGappedCol(gappedCol, gappedSeq)).toBe(charAtBioPos(bioPos, bioSeq));
  });
});

describe('round-trip invariant: convert back and forth preserves position', () => {
  const gappedSeq = 'ATG--CATGC';
  const bioSeq = stripGaps(gappedSeq);

  it('bio → gapped → bio round-trips for all valid bio positions', () => {
    for (let bioPos = 0; bioPos < bioSeq.length; bioPos++) {
      const gappedCol = convertScrollPosition(bioPos, false, undefined, true, gappedSeq);
      const backToBio = convertScrollPosition(gappedCol, true, gappedSeq, false, undefined);

      expect(backToBio).toBe(bioPos);
      expect(charAtBioPos(backToBio, bioSeq)).toBe(charAtBioPos(bioPos, bioSeq));
    }
  });

  it('gapped → bio → gapped round-trips for non-gap columns', () => {
    for (let col = 0; col < gappedSeq.length; col++) {
      if (gappedSeq[col] === '-') continue;

      const bioPos = convertScrollPosition(col, true, gappedSeq, false, undefined);
      const backToGapped = convertScrollPosition(bioPos, false, undefined, true, gappedSeq);

      expect(backToGapped).toBe(col);
    }
  });
});

describe('realistic alignment: many gaps distributed throughout', () => {
  const gappedSeq =
    'ATGCATGCAT' +
    '---' +
    'GCATGCATGC' +
    '--' +
    'ATGCATGCAT' +
    'GCATGCATGC' +
    '----' +
    'ATGCATGCAT' +
    'GCATGCATGC' +
    '--' +
    'ATGCATGCAT' +
    '---' +
    'GCATGCATGC' +
    'ATGCATGCAT';

  const bioSeq = stripGaps(gappedSeq);

  it('has expected lengths', () => {
    expect(bioSeq.length).toBe(90);
    expect(gappedSeq.length).toBe(104);
    expect(countNonGaps(gappedSeq)).toBe(90);
  });

  it('gapped → bio: every non-gap column converts to the same character', () => {
    for (let col = 0; col < gappedSeq.length; col++) {
      if (gappedSeq[col] === '-') continue;

      const bioPos = convertScrollPosition(col, true, gappedSeq, false, undefined);
      const gappedChar = gappedSeq[col];
      const bioChar = bioSeq[bioPos];

      expect(bioChar).toBe(gappedChar);
    }
  });

  it('bio → gapped: every bio position converts to the same character', () => {
    for (let pos = 0; pos < bioSeq.length; pos++) {
      const gappedCol = convertScrollPosition(pos, false, undefined, true, gappedSeq);
      const bioChar = bioSeq[pos];
      const gappedChar = gappedSeq[gappedCol];

      expect(gappedChar).toBe(bioChar);
    }
  });

  it('gapped → bio conversion for position after all gaps gives correct offset', () => {
    const col = 94;
    expect(gappedSeq[col]).toBe('A');

    const bioPos = convertScrollPosition(col, true, gappedSeq, false, undefined);
    expect(bioPos).toBe(80);
    expect(bioSeq[bioPos]).toBe('A');
  });

  it('full round trip for positions spanning gap regions', () => {
    const testPositions = [9, 13, 22, 25, 44, 49, 68, 71, 80, 84, 93, 94];

    for (const col of testPositions) {
      if (gappedSeq[col] === '-') continue;

      const bioPos = convertScrollPosition(col, true, gappedSeq, false, undefined);
      const backToGapped = convertScrollPosition(bioPos, false, undefined, true, gappedSeq);

      expect(backToGapped).toBe(col);
    }
  });
});

describe('same mode: no conversion needed', () => {
  it('gapped → gapped: position unchanged', () => {
    const gappedSeq = 'ATG--CATGC';
    const result = convertScrollPosition(5, true, gappedSeq, true, gappedSeq);
    expect(result).toBe(5);
  });

  it('ungapped → ungapped: position unchanged', () => {
    const result = convertScrollPosition(5, false, undefined, false, undefined);
    expect(result).toBe(5);
  });
});

describe('layout line finding after conversion', () => {
  interface LayoutLine {
    startPos: number;
    endPos: number;
    y: number;
    sequence: string;
  }

  function buildLayout(seq: string, charsPerLine: number): LayoutLine[] {
    const lines: LayoutLine[] = [];
    for (let i = 0; i < seq.length; i += charsPerLine) {
      const end = Math.min(i + charsPerLine - 1, seq.length - 1);
      lines.push({
        startPos: i,
        endPos: end,
        y: lines.length * 60,
        sequence: seq.slice(i, end + 1),
      });
    }
    return lines;
  }

  function findLineForPos(pos: number, lines: LayoutLine[]): LayoutLine | null {
    return (
      lines.find((line, idx) => {
        const nextLine = lines[idx + 1];
        return pos >= line.startPos && (nextLine ? pos < nextLine.startPos : true);
      }) ?? null
    );
  }

  const gappedSeq = 'ATG--CATGC--ATGCATGC';
  const bioSeq = stripGaps(gappedSeq);
  const charsPerLine = 5;

  const gappedLines = buildLayout(gappedSeq, charsPerLine);
  const bioLines = buildLayout(bioSeq, charsPerLine);

  it('gapped layout has correct number of lines', () => {
    expect(gappedLines.length).toBe(4);
  });

  it('bio layout has correct number of lines', () => {
    expect(bioLines.length).toBe(4);
  });

  it('position on gapped line 1 converts to correct bio line', () => {
    const gappedCol = 6;
    expect(charAtGappedCol(gappedCol, gappedSeq)).toBe('A');

    const gappedLine = findLineForPos(gappedCol, gappedLines);
    expect(gappedLine).not.toBeNull();
    expect(gappedLine!.startPos).toBe(5);

    const bioPos = convertScrollPosition(gappedCol, true, gappedSeq, false, undefined);

    const bioLine = findLineForPos(bioPos, bioLines);
    expect(bioLine).not.toBeNull();

    expect(charAtBioPos(bioPos, bioSeq)).toBe('A');
  });

  it('position on gapped line 2 (after second gap) converts correctly', () => {
    const gappedCol = 12;
    expect(charAtGappedCol(gappedCol, gappedSeq)).toBe('A');

    const bioPos = convertScrollPosition(gappedCol, true, gappedSeq, false, undefined);
    expect(charAtBioPos(bioPos, bioSeq)).toBe('A');
  });

  it('bio position converts to correct gapped line', () => {
    const bioPos = 8;
    expect(charAtBioPos(bioPos, bioSeq)).toBe('A');

    const gappedCol = convertScrollPosition(bioPos, false, undefined, true, gappedSeq);

    expect(charAtGappedCol(gappedCol, gappedSeq)).toBe('A');

    const gappedLine = findLineForPos(gappedCol, gappedLines);
    expect(gappedLine).not.toBeNull();
  });
});

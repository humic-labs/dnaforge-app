import { describe, it, expect } from 'vitest';
import type { Annotation } from '@waypoint/sequence-utils';
import type { AnnotatedSequence } from '@waypoint/sequence-utils';
import { computeSequenceLayoutImpl } from '../useSequenceLayout';
import { DEFAULT_EDITOR_CONFIG } from '../types';

function naiveOverlap(anns: Annotation[], lineStart: number, lineEnd: number): Annotation[] {
  return anns.filter((a) => {
    if (a.start > a.end) return false;
    const aStart0 = a.start - 1;
    const aEnd0 = a.end;
    return aEnd0 > lineStart && aStart0 < lineEnd;
  });
}

function makeAnnotations(count: number, seqLen: number, seed = 1): Annotation[] {
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const anns: Annotation[] = [];
  for (let i = 0; i < count; i++) {
    const start = Math.floor(rand() * seqLen) + 1;
    const maxLen = Math.min(5000, seqLen - start);
    const len = Math.max(1, Math.floor(rand() * maxLen));
    anns.push({
      name: `a${i}`,
      type: 'misc_feature',
      start,
      end: start + len,
      direction: 1,
    });
  }
  return anns;
}

function keyOf(a: Annotation): string {
  return `${a.name}-${a.start}-${a.end}`;
}

describe('interval tree — output parity against naive filter', () => {
  it('small sequence, medium annotations', () => {
    const seqLen = 5000;
    const anns = makeAnnotations(50, seqLen);
    const seq: AnnotatedSequence = {
      id: 's',
      name: 's',
      sequence: 'A'.repeat(seqLen),
      length: seqLen,
      annotations: anns,
      circular: false,
    };
    const layout = computeSequenceLayoutImpl(seq, {
      ...DEFAULT_EDITOR_CONFIG,
      charsPerLine: 100,
    });

    for (const line of layout.lines) {
      const lineEnd = line.startPos + line.sequence.length;
      const naive = naiveOverlap(anns, line.startPos, lineEnd);
      const naiveKeys = new Set(naive.map(keyOf));
      const actualKeys = new Set(line.annotations.map(keyOf));
      expect(actualKeys).toEqual(naiveKeys);
    }
  });

  it('large sequence with 1000 annotations — interval tree correctness', () => {
    const seqLen = 100_000;
    const anns = makeAnnotations(1000, seqLen, 42);
    const seq: AnnotatedSequence = {
      id: 'big',
      name: 'big',
      sequence: 'A'.repeat(seqLen),
      length: seqLen,
      annotations: anns,
      circular: false,
    };
    const layout = computeSequenceLayoutImpl(seq, {
      ...DEFAULT_EDITOR_CONFIG,
      charsPerLine: 100,
    });
    for (const line of layout.lines) {
      const lineEnd = line.startPos + line.sequence.length;
      const naive = naiveOverlap(anns, line.startPos, lineEnd);
      const naiveKeys = new Set(naive.map(keyOf));
      const actualKeys = new Set(line.annotations.map(keyOf));
      expect(actualKeys).toEqual(naiveKeys);
    }
  });

  it('circular sequence with non-spanning annotations', () => {
    const seqLen = 10_000;
    const anns = makeAnnotations(200, seqLen, 7);
    const seq: AnnotatedSequence = {
      id: 'c',
      name: 'c',
      sequence: 'A'.repeat(seqLen),
      length: seqLen,
      annotations: anns,
      circular: true,
    };
    const layout = computeSequenceLayoutImpl(
      seq,
      { ...DEFAULT_EDITOR_CONFIG, charsPerLine: 100 },
      0,
      0,
      [],
      false,
      [],
      0
    );
    for (const line of layout.lines) {
      if (line.isTopBuffer || line.isBottomBuffer) continue;
      const lineEnd = line.startPos + line.sequence.length;
      if (lineEnd > seqLen) continue;
      const naive = naiveOverlap(anns, line.startPos, lineEnd);
      const naiveKeys = new Set(naive.map(keyOf));
      const actualKeys = new Set(line.annotations.map(keyOf));
      expect(actualKeys).toEqual(naiveKeys);
    }
  });

  it('empty annotations set', () => {
    const seq: AnnotatedSequence = {
      id: 'e',
      name: 'e',
      sequence: 'A'.repeat(1000),
      length: 1000,
      annotations: [],
      circular: false,
    };
    const layout = computeSequenceLayoutImpl(seq, {
      ...DEFAULT_EDITOR_CONFIG,
      charsPerLine: 100,
    });
    for (const line of layout.lines) {
      expect(line.annotations).toEqual([]);
    }
  });

  it('single annotation at the end of sequence', () => {
    const seqLen = 1000;
    const anns: Annotation[] = [
      { name: 'end', type: 'misc_feature', start: 990, end: 1000, direction: 1 },
    ];
    const seq: AnnotatedSequence = {
      id: 's',
      name: 's',
      sequence: 'A'.repeat(seqLen),
      length: seqLen,
      annotations: anns,
      circular: false,
    };
    const layout = computeSequenceLayoutImpl(seq, {
      ...DEFAULT_EDITOR_CONFIG,
      charsPerLine: 100,
    });
    const lastLine = layout.lines[layout.lines.length - 1];
    expect(lastLine.annotations.map(keyOf)).toEqual(['end-990-1000']);
    for (let i = 0; i < layout.lines.length - 1; i++) {
      expect(layout.lines[i].annotations).toEqual([]);
    }
  });

  it('annotation spanning many lines', () => {
    const seqLen = 1000;
    const anns: Annotation[] = [
      { name: 'long', type: 'misc_feature', start: 100, end: 800, direction: 1 },
    ];
    const seq: AnnotatedSequence = {
      id: 's',
      name: 's',
      sequence: 'A'.repeat(seqLen),
      length: seqLen,
      annotations: anns,
      circular: false,
    };
    const layout = computeSequenceLayoutImpl(seq, {
      ...DEFAULT_EDITOR_CONFIG,
      charsPerLine: 100,
    });
    for (let i = 0; i < layout.lines.length; i++) {
      const line = layout.lines[i];
      const lineEnd = line.startPos + line.sequence.length;
      const shouldHaveAnn = 800 > line.startPos && 99 < lineEnd;
      if (shouldHaveAnn) {
        expect(line.annotations.map(keyOf)).toEqual(['long-100-800']);
      } else {
        expect(line.annotations).toEqual([]);
      }
    }
  });
});

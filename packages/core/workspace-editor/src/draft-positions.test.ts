import { describe, expect, it } from 'vitest';
import { draftPositionMap } from './draft-positions';

describe('mapping a draft position back to the saved file', () => {
  it('is the identity when nothing has been typed', () => {
    const map = draftPositionMap([]);
    expect(map.originalPositionOf(0)).toBe(0);
    expect(map.originalPositionOf(766)).toBe(766);
  });

  it('leaves everything before an insertion where it was', () => {
    const map = draftPositionMap([{ start: 100, end: 103 }]);
    expect(map.originalPositionOf(0)).toBe(0);
    expect(map.originalPositionOf(99)).toBe(99);
  });

  it('shifts everything after an insertion back by its length', () => {
    const map = draftPositionMap([{ start: 100, end: 103 }]);
    expect(map.originalPositionOf(103)).toBe(100);
    expect(map.originalPositionOf(769)).toBe(766);
  });

  it('says a base you just typed came from nowhere', () => {
    const map = draftPositionMap([{ start: 100, end: 103 }]);
    expect(map.originalPositionOf(100)).toBeNull();
    expect(map.originalPositionOf(101)).toBeNull();
    expect(map.originalPositionOf(102)).toBeNull();
  });

  it('adds up several insertions', () => {
    const map = draftPositionMap([
      { start: 10, end: 12 },
      { start: 50, end: 55 },
    ]);
    expect(map.originalPositionOf(9)).toBe(9);
    expect(map.originalPositionOf(12)).toBe(10);
    expect(map.originalPositionOf(49)).toBe(47);
    expect(map.originalPositionOf(55)).toBe(48);
  });

  it('does not care what order the editor hands them over in', () => {
    const map = draftPositionMap([
      { start: 50, end: 55 },
      { start: 10, end: 12 },
    ]);
    expect(map.originalPositionOf(55)).toBe(48);
    expect(map.originalPositionOf(11)).toBeNull();
  });

  it('survives a duplicated range instead of double-counting it', () => {
    const map = draftPositionMap([
      { start: 100, end: 103 },
      { start: 100, end: 103 },
    ]);
    expect(map.originalCodonPositionOf(103, 104, 105)).toBe(100);
  });

  it('merges overlapping ranges', () => {
    const map = draftPositionMap([
      { start: 10, end: 14 },
      { start: 12, end: 18 },
    ]);
    expect(map.originalPositionOf(18)).toBe(10);
    expect(map.originalPositionOf(13)).toBeNull();
  });

  it('ignores an empty range rather than dividing by it', () => {
    const map = draftPositionMap([{ start: 10, end: 10 }]);
    expect(map.originalPositionOf(10)).toBe(10);
  });

  it('keeps deleted bases addressable, because they are still in the file', () => {
    const map = draftPositionMap([]);
    expect(map.originalPositionOf(200)).toBe(200);
  });
});

describe('mapping a whole codon back', () => {
  it('gives the position that names a codon you have not touched', () => {
    const map = draftPositionMap([{ start: 10, end: 13 }]);
    expect(map.originalCodonPositionOf(769, 770, 771)).toBe(766);
  });

  it('refuses a codon that contains a base you just typed', () => {
    const map = draftPositionMap([{ start: 767, end: 768 }]);
    expect(map.originalCodonPositionOf(766, 767, 768)).toBeNull();
  });

  it('refuses a codon pulled together across a deletion', () => {
    const map = draftPositionMap([]);
    expect(map.originalCodonPositionOf(100, 101, 105)).toBeNull();
  });

  it('refuses both halves of a codon an insertion split', () => {
    const map = draftPositionMap([{ start: 767, end: 770 }]);
    expect(map.originalCodonPositionOf(766, 767, 768)).toBeNull();
    expect(map.originalCodonPositionOf(769, 770, 771)).toBeNull();
  });

  it('reads a reverse-strand codon by its lowest base, like GenBank writes it', () => {
    const map = draftPositionMap([]);
    expect(map.originalCodonPositionOf(768, 767, 766)).toBe(766);
  });
});

describe('cost', () => {
  it('answers in time set by how much you typed, not how long the sequence is', () => {
    const edits = Array.from({ length: 1000 }, (_, i) => ({
      start: i * 1000,
      end: i * 1000 + 1,
    }));
    const map = draftPositionMap(edits);
    const started = Date.now();
    for (let i = 0; i < 200_000; i++) map.originalPositionOf(i * 23);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

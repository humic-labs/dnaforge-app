// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { diffToDecorations } from './diff-decorations';
import type { DiffResult } from './sequence-diff';

describe('diffToDecorations', () => {
  it('converts insertion to green solid decoration', () => {
    const diff: DiffResult = {
      changes: [{ type: 'insertion', position: 4, length: 2, newBases: 'CC' }],
      insertions: 1,
      deletions: 0,
      mutations: 0,
      insertedBp: 2,
      deletedBp: 0,
    };

    const result = diffToDecorations(diff);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      start: 4,
      end: 5,
      layer: 'git-diff',
      style: 'solid',
    });
    expect(result[0].color).toContain('152');
  });

  it('converts deletion to red caret decoration', () => {
    const diff: DiffResult = {
      changes: [{ type: 'deletion', position: 4, length: 2, oldBases: 'AT' }],
      insertions: 0,
      deletions: 1,
      mutations: 0,
      insertedBp: 0,
      deletedBp: 2,
    };

    const result = diffToDecorations(diff);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      start: 4,
      end: 4,
      layer: 'git-diff',
      style: 'caret',
    });
  });

  it('converts mutation to yellow solid decoration', () => {
    const diff: DiffResult = {
      changes: [{ type: 'mutation', position: 4, length: 1, oldBases: 'A', newBases: 'G' }],
      insertions: 0,
      deletions: 0,
      mutations: 1,
      insertedBp: 0,
      deletedBp: 0,
    };

    const result = diffToDecorations(diff);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      start: 4,
      end: 4,
      layer: 'git-diff',
      style: 'solid',
    });
    expect(result[0].color).toContain('42');
  });

  it('returns empty array for no changes', () => {
    const diff: DiffResult = {
      changes: [],
      insertions: 0,
      deletions: 0,
      mutations: 0,
      insertedBp: 0,
      deletedBp: 0,
    };

    expect(diffToDecorations(diff)).toEqual([]);
  });

  it('handles multiple changes', () => {
    const diff: DiffResult = {
      changes: [
        { type: 'insertion', position: 4, length: 2, newBases: 'CC' },
        { type: 'mutation', position: 10, length: 1, oldBases: 'A', newBases: 'G' },
        { type: 'deletion', position: 20, length: 3, oldBases: 'ATG' },
      ],
      insertions: 1,
      deletions: 1,
      mutations: 1,
      insertedBp: 2,
      deletedBp: 3,
    };

    const result = diffToDecorations(diff);
    expect(result).toHaveLength(3);
    expect(result[0].style).toBe('solid');
    expect(result[1].style).toBe('solid');
    expect(result[2].style).toBe('caret');
  });

  it('includes metadata on decorations', () => {
    const diff: DiffResult = {
      changes: [{ type: 'insertion', position: 0, length: 3, newBases: 'ATG' }],
      insertions: 1,
      deletions: 0,
      mutations: 0,
      insertedBp: 3,
      deletedBp: 0,
    };

    const result = diffToDecorations(diff);
    expect(result[0].metadata).toEqual({ type: 'insertion', bases: 'ATG' });
  });
});

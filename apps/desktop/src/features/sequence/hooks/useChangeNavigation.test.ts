// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { findNextChangePosition, findPrevChangePosition } from './useChangeNavigation';

describe('findNextChangePosition', () => {
  it('returns first change after current position', () => {
    const changes = [{ position: 10 }, { position: 20 }, { position: 30 }];
    expect(findNextChangePosition(changes, 15)).toBe(20);
  });

  it('wraps to first change when at the end', () => {
    const changes = [{ position: 10 }, { position: 20 }, { position: 30 }];
    expect(findNextChangePosition(changes, 35)).toBe(10);
  });

  it('returns null for empty changes', () => {
    expect(findNextChangePosition([], 0)).toBeNull();
  });

  it('returns the next even if at exact position of a change', () => {
    const changes = [{ position: 10 }, { position: 20 }];
    expect(findNextChangePosition(changes, 10)).toBe(20);
  });

  it('wraps when current is at the last change', () => {
    const changes = [{ position: 10 }, { position: 20 }];
    expect(findNextChangePosition(changes, 20)).toBe(10);
  });
});

describe('findPrevChangePosition', () => {
  it('returns last change before current position', () => {
    const changes = [{ position: 10 }, { position: 20 }, { position: 30 }];
    expect(findPrevChangePosition(changes, 25)).toBe(20);
  });

  it('wraps to last change when at the beginning', () => {
    const changes = [{ position: 10 }, { position: 20 }, { position: 30 }];
    expect(findPrevChangePosition(changes, 5)).toBe(30);
  });

  it('returns null for empty changes', () => {
    expect(findPrevChangePosition([], 0)).toBeNull();
  });

  it('returns the previous when at exact position of a change', () => {
    const changes = [{ position: 10 }, { position: 20 }];
    expect(findPrevChangePosition(changes, 20)).toBe(10);
  });
});

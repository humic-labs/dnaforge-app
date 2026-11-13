// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  formatDevAppBarChip,
  formatDevWindowTitle,
  normalizeDevInstanceLabel,
} from './dev-window-identity';

describe('dev-window-identity', () => {
  it('never surfaces bare HEAD as the label', () => {
    expect(normalizeDevInstanceLabel('HEAD', 'waypoint-TASK-7-baseline-469d7612e')).toContain(
      '7-baseline'
    );
    expect(normalizeDevInstanceLabel('HEAD', 'waypoint-TASK-7-baseline-469d7612e')).not.toBe(
      'HEAD'
    );
  });

  it('strips feature/ and TASK-7- prefix; shortens long names', () => {
    expect(normalizeDevInstanceLabel('feature/TASK-7-lod-race-b', 'x')).toBe('7-lod-race-b');
    const long = normalizeDevInstanceLabel(
      'feature/TASK-7-indexed-annotation-lod-authority',
      'wt',
      20
    );
    expect(long.length).toBeLessThanOrEqual(20);
    expect(long.endsWith('…')).toBe(true);
  });

  it('formats app bar and window title with port + sha', () => {
    const parts = { label: '7-lod-race-b', port: 1421, shortSha: '9cd2ca0' };
    expect(formatDevAppBarChip(parts)).toBe(':1421 · 7-lod-race-b · 9cd2ca0');
    expect(formatDevWindowTitle(parts)).toBe('DNAForge · :1421 · 7-lod-race-b · 9cd2ca0');
  });
});

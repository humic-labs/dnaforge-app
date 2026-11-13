import { describe, expect, it } from 'vitest';
import {
  computeCircularVirtualRowCount,
  estimateCircularBufferRowPitch,
  MIN_CIRCULAR_BUFFER_ROW_PITCH_PX,
} from '../circular-buffer-rows';
import { DEFAULT_EDITOR_CONFIG } from '../types';

describe('circular virtual buffer row sizing', () => {
  it('does not derive feature-LOD buffer rows from near-zero nucleotide row height', () => {
    const config = {
      ...DEFAULT_EDITOR_CONFIG,
      lodLevel: 'feature' as const,
      overviewLod: false,
      rowHeight: DEFAULT_EDITOR_CONFIG.rowHeight * 0.002,
    };

    expect(estimateCircularBufferRowPitch(config)).toBe(MIN_CIRCULAR_BUFFER_ROW_PITCH_PX);
    expect(computeCircularVirtualRowCount(config, 520)).toBe(30);
  });

  it('keeps circular buffers enabled for feature LOD', () => {
    const config = {
      ...DEFAULT_EDITOR_CONFIG,
      lodLevel: 'feature' as const,
      overviewLod: false,
      rowHeight: DEFAULT_EDITOR_CONFIG.rowHeight * 0.18,
    };

    expect(computeCircularVirtualRowCount(config, 520)).toBeGreaterThan(0);
  });

  it('disables circular buffers only for density overview LOD', () => {
    const config = {
      ...DEFAULT_EDITOR_CONFIG,
      lodLevel: 'density' as const,
      overviewLod: true,
    };

    expect(computeCircularVirtualRowCount(config, 520)).toBe(0);
  });
});

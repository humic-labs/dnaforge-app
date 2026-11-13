import { describe, expect, it } from 'vitest';

import { blocksOverlappingRange } from './tile-block-overlap';
import type { DirectionalBlock } from './transcript-glyph-vertices';

function block(startBp: number, endBp: number): DirectionalBlock {
  return {
    startBp,
    endBp,
    offsetCenter: 0,
    halfH: 7,
    color: 0x000000,
    role: 'transcript:intron' as const,
    alpha: 1,
    cdsFade: 0,
    dirSign: 0,
  };
}

describe('blocksOverlappingRange', () => {
  it('keeps a block fully inside the window', () => {
    const blocks = [block(100, 200)];
    expect(blocksOverlappingRange(blocks, 0, 1000)).toEqual(blocks);
  });

  it('drops a block entirely left of the window', () => {
    expect(blocksOverlappingRange([block(0, 100)], 100, 200)).toEqual([]);
  });

  it('drops a block entirely right of the window', () => {
    expect(blocksOverlappingRange([block(200, 300)], 100, 200)).toEqual([]);
  });

  it('keeps seam-straddling blocks in both adjacent tiles', () => {
    const straddler = block(180, 220);
    expect(blocksOverlappingRange([straddler], 100, 200)).toEqual([straddler]);
    expect(blocksOverlappingRange([straddler], 200, 300)).toEqual([straddler]);
  });

  it('filters a dense set to only the overlapping subset', () => {
    const all = [block(0, 10), block(50, 120), block(130, 170), block(195, 260), block(300, 400)];
    expect(blocksOverlappingRange(all, 100, 200)).toEqual([all[1], all[2], all[3]]);
  });

  it('preserves input order and does not mutate the input array', () => {
    const all = [block(110, 120), block(300, 400), block(130, 140)];
    const snapshot = [...all];
    expect(blocksOverlappingRange(all, 100, 200)).toEqual([all[0], all[2]]);
    expect(all).toEqual(snapshot);
  });
});

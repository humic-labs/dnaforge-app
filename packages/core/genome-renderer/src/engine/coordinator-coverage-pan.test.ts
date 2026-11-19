import { describe, expect, it } from 'vitest';
import { buildAssembly } from '../assembly-layout';
import { TileCoordinator } from './coordinator';
import { TileCache } from './tile-cache';
import { FakeInMemoryTileSource } from './tile-source';

describe('coverage during a pan', () => {
  it.each([
    { previousStart: 131_700, targetStart: 155_700, visibleIndex: 22, aheadIndex: 42 },
    { previousStart: 231_700, targetStart: 207_700, visibleIndex: 28, aheadIndex: 12 },
  ])(
    'keeps only visible floor tiles at current priority moving from $previousStart',
    ({ previousStart, targetStart, visibleIndex, aheadIndex }) => {
      const assembly = buildAssembly('pan', 'pan', [
        { id: 'chr1', displayName: 'chr1', length: 320_000, cytobands: [] },
        { id: 'chr2', displayName: 'chr2', length: 280_000, cytobands: [] },
      ]);
      const source = new FakeInMemoryTileSource({
        id: 'covasm:pan',
        levelRange: [0, 10],
        manual: true,
      });
      const cache = new TileCache({ maxEntries: 512, maxBytes: 16_000_000 });
      const coordinator = new TileCoordinator({ assembly, sources: [source], cache });
      const pan = (start: number) =>
        coordinator.setViewport({
          globalStart: start,
          globalEnd: start + 44_000,
          viewportPx: 1416,
        });

      pan(previousStart);
      pan(targetStart);
      expect(coordinator.level).toBe(5);
      const priority = (index: number) =>
        cache.peek({ sourceId: source.id, level: 3, index })?.priority;
      expect(priority(visibleIndex)).toMatchObject({ purpose: 'current', core: true });
      expect(priority(aheadIndex)).toMatchObject({ purpose: 'pan-lead', core: true });

      pan(aheadIndex * 8192);
      expect(priority(aheadIndex)).toMatchObject({ purpose: 'current', core: true });
    }
  );
});

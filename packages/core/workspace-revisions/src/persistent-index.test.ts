import { describe, expect, it } from 'vitest';

import { PersistentIndex } from './persistent-index';

describe('persistent graph history index', () => {
  it(
    'path-copies a bounded number of nodes across a long immutable history',
    { timeout: 30_000 },
    () => {
      let index = PersistentIndex.empty<string, Readonly<{ id: string; sequence: number }>>(
        'scale-proof',
        (value) => value.id
      );
      const checkpoints: Array<ReadonlyMap<string, Readonly<{ id: string; sequence: number }>>> =
        [];
      for (let sequence = 0; sequence < 10_000; sequence += 1) {
        if (sequence % 2_500 === 0) checkpoints.push(index);
        const id = `wv_${sequence.toString(16).padStart(64, '0')}`;
        const update = index.set(id, Object.freeze({ id, sequence }));
        expect(update.writes.length).toBeLessThanOrEqual(70);
        expect(
          update.writes.reduce(
            (bytes, write) => bytes + new TextEncoder().encode(write.canonicalJson).length,
            0
          )
        ).toBeLessThan(128 * 1_024);
        index = update.index;
      }

      expect(index.size).toBe(10_000);
      expect(index.get(`wv_${(9_999).toString(16).padStart(64, '0')}`)?.sequence).toBe(9_999);
      expect(checkpoints.map((checkpoint) => checkpoint.size)).toEqual([0, 2_500, 5_000, 7_500]);
    }
  );

  it('reuses an index when a stable key already names the same immutable identity', () => {
    const empty = PersistentIndex.empty<string, Readonly<{ id: string; trace: string }>>(
      'identity-proof',
      (value) => value.id
    );
    const first = empty.set('operation-1', { id: 'receipt-1', trace: 'first caller object' });
    const replay = first.index.set('operation-1', {
      id: 'receipt-1',
      trace: 'different caller object, same immutable identity',
    });
    expect(replay.index).toBe(first.index);
    expect(replay.writes).toEqual([]);
  });
});

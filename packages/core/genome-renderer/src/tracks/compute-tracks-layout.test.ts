import { describe, expect, it } from 'vitest';

import { computeTracksLayout, layoutMemoKey } from './compute-tracks-layout';
import { GENERIC_INTERVAL_TYPE } from './builtins';
import { TrackLayoutInputError, type Track, type TrackSizingProfile } from './types';

function track(overrides: Partial<Track> & Pick<Track, 'id'>): Track {
  return {
    type: 'annotation',
    order: 0,
    visible: true,
    assemblyId: 'chr11',
    ...overrides,
  };
}

function contentResolver(contentByTrackId: Record<string, number>): (t: Track) => number {
  return (t) => contentByTrackId[t.id] ?? 0;
}

describe('computeTracksLayout —  /  Phase 1 lane contract', () => {
  it('reserves a usable managed row even when one interval glyph needs only 18px', () => {
    const interval = track({
      id: 'cpg-islands',
      type: GENERIC_INTERVAL_TYPE.type,
      sizing: GENERIC_INTERVAL_TYPE.defaultSizing,
    });

    const [entry] = computeTracksLayout([interval], contentResolver({ 'cpg-islands': 18 }), {
      availableHeight: 400,
    });

    expect(entry.height).toBeGreaterThanOrEqual(56);
  });
  it('1. fixed-only: sum-within-budget gives each its requested pixels and stacks tops', () => {
    const tracks: Track[] = [
      track({ id: 'a', order: 0, sizing: { kind: 'fixed', pixels: 40 } }),
      track({ id: 'b', order: 1, sizing: { kind: 'fixed', pixels: 60 } }),
      track({ id: 'c', order: 2, sizing: { kind: 'fixed', pixels: 100 } }),
    ];
    const layout = computeTracksLayout(tracks, () => 0, { availableHeight: 400 });
    expect(layout.map((e) => ({ id: e.id, top: e.top, height: e.height }))).toEqual([
      { id: 'a', top: 0, height: 40 },
      { id: 'b', top: 40, height: 60 },
      { id: 'c', top: 100, height: 100 },
    ]);
    expect(layout.every((e) => !e.contentClipped)).toBe(true);
  });

  it('2. fitContent-only: each track gets its content height (no flex/fixed peers)', () => {
    const tracks: Track[] = [
      track({ id: 'a', order: 0, sizing: { kind: 'fitContent' } }),
      track({ id: 'b', order: 1, sizing: { kind: 'fitContent' } }),
    ];
    const layout = computeTracksLayout(tracks, contentResolver({ a: 30, b: 70 }), {
      availableHeight: 200,
    });
    expect(layout.map((e) => ({ id: e.id, height: e.height }))).toEqual([
      { id: 'a', height: 30 },
      { id: 'b', height: 70 },
    ]);
    expect(layout.every((e) => !e.contentClipped)).toBe(true);
  });

  it('3. flex-only: single flex track absorbs the full budget', () => {
    const tracks: Track[] = [track({ id: 'a', order: 0, sizing: { kind: 'flex' } })];
    const layout = computeTracksLayout(tracks, () => 0, { availableHeight: 240 });
    expect(layout[0]).toMatchObject({ id: 'a', top: 0, height: 240, hidden: false });
  });

  it('3b. flex-only: two flex tracks split proportionally by share', () => {
    const tracks: Track[] = [
      track({ id: 'a', order: 0, sizing: { kind: 'flex', share: 1 } }),
      track({ id: 'b', order: 1, sizing: { kind: 'flex', share: 3 } }),
    ];
    const layout = computeTracksLayout(tracks, () => 0, { availableHeight: 400 });
    expect(layout.map((e) => e.height)).toEqual([100, 300]);
  });

  it('4. mixed: fixed + fitContent + flex coexist and tile the budget', () => {
    const tracks: Track[] = [
      track({ id: 'fix', order: 0, sizing: { kind: 'fixed', pixels: 50 } }),
      track({ id: 'fit', order: 1, sizing: { kind: 'fitContent' } }),
      track({ id: 'flex', order: 2, sizing: { kind: 'flex' } }),
    ];
    const layout = computeTracksLayout(tracks, contentResolver({ fit: 80 }), {
      availableHeight: 400,
    });
    expect(layout.map((e) => ({ id: e.id, top: e.top, height: e.height }))).toEqual([
      { id: 'fix', top: 0, height: 50 },
      { id: 'fit', top: 50, height: 80 },
      { id: 'flex', top: 130, height: 270 },
    ]);
  });

  it('5. over-budget shrink: flex collapses to floor before fitContent shrinks', () => {
    const tracks: Track[] = [
      track({ id: 'fix', order: 0, sizing: { kind: 'fixed', pixels: 80 } }),
      track({ id: 'fit', order: 1, sizing: { kind: 'fitContent' } }),
      track({ id: 'flex', order: 2, sizing: { kind: 'flex', minHeight: 10 } }),
    ];
    const layout = computeTracksLayout(tracks, contentResolver({ fit: 80 }), {
      availableHeight: 120,
    });
    const byId = Object.fromEntries(layout.map((e) => [e.id, e]));
    expect(byId.fix.height).toBe(80);
    expect(byId.flex.height).toBe(10);
    expect(byId.fit.height).toBe(30);
    expect(byId.fit.contentClipped).toBe(true);
    expect(byId.flex.contentClipped).toBe(false);
    expect(byId.fix.height + byId.flex.height + byId.fit.height).toBe(120);
  });

  it('6. under-budget distribute: extra space goes to flex tracks (by share); fixed/fitContent untouched', () => {
    const tracks: Track[] = [
      track({ id: 'fix', order: 0, sizing: { kind: 'fixed', pixels: 30 } }),
      track({ id: 'flexA', order: 1, sizing: { kind: 'flex', share: 1 } }),
      track({ id: 'flexB', order: 2, sizing: { kind: 'flex', share: 2 } }),
    ];
    const layout = computeTracksLayout(tracks, () => 0, { availableHeight: 330 });
    const byId = Object.fromEntries(layout.map((e) => [e.id, e]));
    expect(byId.fix.height).toBe(30);
    expect(byId.flexA.height).toBe(100);
    expect(byId.flexB.height).toBe(200);
  });

  it('7. content-clipped flag: fitContent below content height sets contentClipped', () => {
    const tracks: Track[] = [
      track({ id: 'a', order: 0, sizing: { kind: 'fitContent', maxHeight: 50 } }),
    ];
    const layout = computeTracksLayout(tracks, contentResolver({ a: 200 }), {
      availableHeight: 400,
    });
    expect(layout[0].height).toBe(50);
    expect(layout[0].contentClipped).toBe(true);
  });

  it('8. all-hidden: visible: false tracks emit zero-height entries; result preserves input ids', () => {
    const tracks: Track[] = [
      track({ id: 'a', order: 0, visible: false, sizing: { kind: 'fixed', pixels: 100 } }),
      track({ id: 'b', order: 1, visible: false, sizing: { kind: 'fixed', pixels: 100 } }),
    ];
    const layout = computeTracksLayout(tracks, () => 0, { availableHeight: 400 });
    expect(layout.map((e) => ({ id: e.id, height: e.height, hidden: e.hidden }))).toEqual([
      { id: 'a', height: 0, hidden: true },
      { id: 'b', height: 0, hidden: true },
    ]);
  });

  it('8b. partial visibility: hidden tracks zero-height, visible tracks lay out around them', () => {
    const tracks: Track[] = [
      track({ id: 'visible1', order: 0, sizing: { kind: 'fixed', pixels: 100 } }),
      track({ id: 'hidden', order: 1, visible: false, sizing: { kind: 'fixed', pixels: 999 } }),
      track({ id: 'visible2', order: 2, sizing: { kind: 'fixed', pixels: 100 } }),
    ];
    const layout = computeTracksLayout(tracks, () => 0, { availableHeight: 400 });
    expect(layout[0]).toMatchObject({ id: 'visible1', top: 0, height: 100, hidden: false });
    expect(layout[1]).toMatchObject({ id: 'hidden', top: 0, height: 0, hidden: true });
    expect(layout[2]).toMatchObject({ id: 'visible2', top: 100, height: 100, hidden: false });
  });

  it('9. duplicate IDs: throws TrackLayoutInputError with cause "duplicate-id"', () => {
    const tracks: Track[] = [track({ id: 'a', order: 0 }), track({ id: 'a', order: 1 })];
    expect(() => computeTracksLayout(tracks, () => 0, { availableHeight: 100 })).toThrowError(
      TrackLayoutInputError
    );
    try {
      computeTracksLayout(tracks, () => 0, { availableHeight: 100 });
    } catch (err) {
      expect((err as TrackLayoutInputError).cause).toBe('duplicate-id');
    }
  });

  it('10. pane < sum(minHeight): degrades by clipping fixed tracks in input order; later ones get 0', () => {
    const tracks: Track[] = [
      track({ id: 'a', order: 0, sizing: { kind: 'fixed', pixels: 80, minHeight: 80 } }),
      track({ id: 'b', order: 1, sizing: { kind: 'fixed', pixels: 80, minHeight: 80 } }),
      track({ id: 'c', order: 2, sizing: { kind: 'fixed', pixels: 80, minHeight: 80 } }),
    ];
    const layout = computeTracksLayout(tracks, () => 0, { availableHeight: 100 });
    expect(layout.map((e) => e.height)).toEqual([80, 20, 0]);
    expect(layout.map((e) => e.contentClipped)).toEqual([false, true, true]);
  });

  it('11. zero tracks: returns empty array', () => {
    expect(computeTracksLayout([], () => 0, { availableHeight: 400 })).toEqual([]);
  });

  it('layoutMemoKey: stable across freshly-constructed track arrays with same structural shape', () => {
    const sizing: TrackSizingProfile = { kind: 'fixed', pixels: 40 };
    const k1 = layoutMemoKey([track({ id: 'a', order: 0, sizing })], () => 0, {
      availableHeight: 400,
    });
    const k2 = layoutMemoKey(
      [track({ id: 'a', order: 0, sizing: { kind: 'fixed', pixels: 40 } })],
      () => 0,
      { availableHeight: 400 }
    );
    expect(k1).toBe(k2);
  });

  it('layoutMemoKey: changes when content height changes (re-layout required)', () => {
    const t: Track = track({ id: 'a', order: 0, sizing: { kind: 'fitContent' } });
    const k1 = layoutMemoKey([t], () => 50, { availableHeight: 400 });
    const k2 = layoutMemoKey([t], () => 80, { availableHeight: 400 });
    expect(k1).not.toBe(k2);
  });

  it('layoutMemoKey: changes when availableHeight changes', () => {
    const t: Track = track({ id: 'a', order: 0, sizing: { kind: 'fixed', pixels: 40 } });
    expect(layoutMemoKey([t], () => 0, { availableHeight: 100 })).not.toBe(
      layoutMemoKey([t], () => 0, { availableHeight: 200 })
    );
  });

  it('layoutMemoKey: changes when track order changes', () => {
    const a: Track = track({ id: 'a', order: 0 });
    const b: Track = track({ id: 'b', order: 1 });
    const k1 = layoutMemoKey([a, b], () => 0, { availableHeight: 400 });
    const k2 = layoutMemoKey([{ ...a, order: 5 }, b], () => 0, { availableHeight: 400 });
    expect(k1).not.toBe(k2);
  });

  type SizingKind = 'fixed' | 'fitContent' | 'flex';
  type SweepCase = {
    name: string;
    tracks: Track[];
    availableHeight: number;
    contentHeights?: Record<string, number>;
  };
  const SWEEP_CASES: SweepCase[] = [
    {
      name: 'three fixed tracks within budget',
      tracks: [
        track({ id: 'a', order: 0, sizing: { kind: 'fixed', pixels: 30 } }),
        track({ id: 'b', order: 1, sizing: { kind: 'fixed', pixels: 60 } }),
        track({ id: 'c', order: 2, sizing: { kind: 'fixed', pixels: 90 } }),
      ],
      availableHeight: 400,
    },
    {
      name: 'fixed + fitContent + two flex (shares)',
      tracks: [
        track({ id: 'fix', order: 0, sizing: { kind: 'fixed', pixels: 40 } }),
        track({ id: 'fit', order: 1, sizing: { kind: 'fitContent' } }),
        track({ id: 'flex1', order: 2, sizing: { kind: 'flex', share: 1 } }),
        track({ id: 'flex2', order: 3, sizing: { kind: 'flex', share: 2 } }),
      ],
      availableHeight: 600,
      contentHeights: { fit: 100 },
    },
    {
      name: 'over-budget shrink (flex floor + fitContent clip)',
      tracks: [
        track({ id: 'fix', order: 0, sizing: { kind: 'fixed', pixels: 200 } }),
        track({ id: 'fit', order: 1, sizing: { kind: 'fitContent' } }),
        track({ id: 'flex', order: 2, sizing: { kind: 'flex', minHeight: 10 } }),
      ],
      availableHeight: 240,
      contentHeights: { fit: 100 },
    },
    {
      name: 'hidden track interleaved with visible (must not push visible peers)',
      tracks: [
        track({ id: 'v1', order: 0, sizing: { kind: 'fixed', pixels: 40 } }),
        track({ id: 'hidden', order: 1, visible: false, sizing: { kind: 'fixed', pixels: 999 } }),
        track({ id: 'v2', order: 2, sizing: { kind: 'fixed', pixels: 60 } }),
      ],
      availableHeight: 400,
    },
    {
      name: 'many tracks (15) with mixed sizing — stress fixture',
      tracks: Array.from({ length: 15 }, (_, i) => {
        const kinds: SizingKind[] = ['fixed', 'fitContent', 'flex'];
        const kind = kinds[i % 3];
        return track({
          id: `t${i}`,
          order: i,
          sizing:
            kind === 'fixed'
              ? { kind: 'fixed', pixels: 20 + (i % 4) * 5 }
              : kind === 'fitContent'
                ? { kind: 'fitContent' }
                : { kind: 'flex', share: 1 + (i % 3) },
        });
      }),
      availableHeight: 1000,
      contentHeights: Object.fromEntries(
        Array.from({ length: 15 }, (_, i) => [`t${i}`, 15 + (i % 5) * 4])
      ),
    },
  ];

  describe('invariant: no two visible tracks have overlapping y ranges', () => {
    for (const c of SWEEP_CASES) {
      it(`holds for: ${c.name}`, () => {
        const layout = computeTracksLayout(c.tracks, (t) => c.contentHeights?.[t.id] ?? 0, {
          availableHeight: c.availableHeight,
        });
        const visible = layout.filter((e) => !e.hidden && e.height > 0);
        for (let i = 0; i < visible.length; i++) {
          for (let j = i + 1; j < visible.length; j++) {
            const a = visible[i];
            const b = visible[j];
            const aEnd = a.top + a.height;
            const bEnd = b.top + b.height;
            const overlaps = a.top < bEnd && b.top < aEnd;
            expect(
              overlaps,
              `tracks "${a.id}" [${a.top},${aEnd}] and "${b.id}" [${b.top},${bEnd}] overlap`
            ).toBe(false);
          }
        }
      });
    }
  });

  describe('invariant: sum of visible heights ≤ availableHeight', () => {
    for (const c of SWEEP_CASES) {
      it(`holds for: ${c.name}`, () => {
        const layout = computeTracksLayout(c.tracks, (t) => c.contentHeights?.[t.id] ?? 0, {
          availableHeight: c.availableHeight,
        });
        const total = layout.filter((e) => !e.hidden).reduce((sum, e) => sum + e.height, 0);
        expect(total).toBeLessThanOrEqual(c.availableHeight);
      });
    }
  });

  describe('invariant: hidden tracks do not shift visible peers', () => {
    for (const c of SWEEP_CASES) {
      it(`holds for: ${c.name}`, () => {
        const visibleOnly = c.tracks.filter((t) => t.visible);
        const layoutWithHidden = computeTracksLayout(
          c.tracks,
          (t) => c.contentHeights?.[t.id] ?? 0,
          { availableHeight: c.availableHeight }
        );
        const layoutWithoutHidden = computeTracksLayout(
          visibleOnly,
          (t) => c.contentHeights?.[t.id] ?? 0,
          { availableHeight: c.availableHeight }
        );
        const withHiddenById = new Map(
          layoutWithHidden.filter((e) => !e.hidden).map((e) => [e.id, e])
        );
        const withoutHiddenById = new Map(layoutWithoutHidden.map((e) => [e.id, e]));
        for (const id of withoutHiddenById.keys()) {
          const a = withHiddenById.get(id);
          const b = withoutHiddenById.get(id);
          if (!a || !b) continue;
          expect(a.top, `"${id}".top differs with hidden peers`).toBe(b.top);
          expect(a.height, `"${id}".height differs with hidden peers`).toBe(b.height);
        }
      });
    }
  });

  describe('invariant: visible tracks are stacked in ascending order (no top regressions)', () => {
    for (const c of SWEEP_CASES) {
      it(`holds for: ${c.name}`, () => {
        const layout = computeTracksLayout(c.tracks, (t) => c.contentHeights?.[t.id] ?? 0, {
          availableHeight: c.availableHeight,
        });
        const inputOrderById = new Map(c.tracks.map((t) => [t.id, t.order]));
        const visible = layout
          .filter((e) => !e.hidden && e.height > 0)
          .sort((a, b) => (inputOrderById.get(a.id) ?? 0) - (inputOrderById.get(b.id) ?? 0));
        let prevTop = -Infinity;
        for (const entry of visible) {
          expect(
            entry.top,
            `track "${entry.id}".top=${entry.top} is less than previous track's top=${prevTop} despite later order`
          ).toBeGreaterThanOrEqual(prevTop);
          prevTop = entry.top;
        }
      });
    }
  });
});

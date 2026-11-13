import { describe, it, expect } from 'vitest';
import {
  onWheel,
  onTick,
  onSettle,
  computeAnchoredScrollTop,
  INITIAL_STATE,
  COMMIT_INTERVAL_MS,
  MIN_ZOOM,
  MAX_ZOOM,
  type GestureState,
  type WheelContext,
  type WheelInput,
} from '../zoom-controller';

const mkCtx = (overrides: Partial<WheelContext> = {}): WheelContext => ({
  now: 1000,
  anchorBpFromCursor: () => 42,
  currentZoom: 50,
  ...overrides,
});

const mkWheel = (overrides: Partial<WheelInput> = {}): WheelInput => ({
  deltaY: -100,
  deltaMode: 0,
  clientX: 500,
  clientY: 400,
  ...overrides,
});

describe('onWheel', () => {
  it('starts a gesture from idle', () => {
    const { state } = onWheel(INITIAL_STATE, mkWheel(), mkCtx());
    expect(state.phase).toBe('active');
    if (state.phase === 'active') {
      expect(state.cursor).toEqual({ x: 500, y: 400 });
      expect(state.anchor.bp).toBe(42);
      expect(state.anchor.cursorY).toBe(400);
      expect(state.gestureScale).toBeGreaterThan(1);
      expect(state.lastWheelAt).toBe(1000);
      expect(state.lastCommitAt).toBeNull();
    }
  });

  it('ignores wheel if cursor is not over the sequence area', () => {
    const { state, effects } = onWheel(
      INITIAL_STATE,
      mkWheel(),
      mkCtx({ anchorBpFromCursor: () => null })
    );
    expect(state.phase).toBe('idle');
    expect(effects).toEqual([]);
  });

  it('accumulates gestureScale across wheels', () => {
    const s1 = onWheel(INITIAL_STATE, mkWheel(), mkCtx({ now: 1000 })).state;
    const s2 = onWheel(s1, mkWheel(), mkCtx({ now: 1016 })).state;
    expect(s1.phase).toBe('active');
    expect(s2.phase).toBe('active');
    if (s1.phase === 'active' && s2.phase === 'active') {
      expect(s2.gestureScale).toBeGreaterThan(s1.gestureScale);
    }
  });

  it('updates cursor + lastWheelAt but freezes anchor on subsequent wheels', () => {
    const s1 = onWheel(
      INITIAL_STATE,
      mkWheel({ clientX: 500, clientY: 400 }),
      mkCtx({ now: 1000, anchorBpFromCursor: () => 100 })
    ).state;
    const s2 = onWheel(
      s1,
      mkWheel({ clientX: 510, clientY: 410 }),
      mkCtx({ now: 1020, anchorBpFromCursor: () => 999 })
    ).state;
    if (s1.phase === 'active' && s2.phase === 'active') {
      expect(s2.cursor).toEqual({ x: 510, y: 410 });
      expect(s2.anchor).toEqual(s1.anchor);
      expect(s2.lastWheelAt).toBe(1020);
    }
  });

  it('emits a single setTransform effect per wheel', () => {
    const { effects } = onWheel(INITIAL_STATE, mkWheel(), mkCtx());
    expect(effects).toHaveLength(1);
    expect(effects[0].kind).toBe('setTransform');
    if (effects[0].kind === 'setTransform') {
      expect(effects[0].scale).toBeGreaterThan(1);
      expect(effects[0].origin).toEqual({ x: 500, y: 400 });
    }
  });

  it('zoom-out wheel (positive deltaY) produces gestureScale < 1', () => {
    const { state } = onWheel(INITIAL_STATE, mkWheel({ deltaY: 100 }), mkCtx());
    if (state.phase === 'active') {
      expect(state.gestureScale).toBeLessThan(1);
    }
  });

  it('honors deltaMode=1 (line) — larger effective delta than deltaMode=0 (pixel)', () => {
    const pxState = onWheel(INITIAL_STATE, mkWheel({ deltaY: -10, deltaMode: 0 }), mkCtx()).state;
    const lineState = onWheel(INITIAL_STATE, mkWheel({ deltaY: -10, deltaMode: 1 }), mkCtx()).state;
    if (pxState.phase === 'active' && lineState.phase === 'active') {
      expect(lineState.gestureScale).toBeGreaterThan(pxState.gestureScale);
    }
  });

  it('honors deltaMode=2 (page) — largest effective delta', () => {
    const lineState = onWheel(INITIAL_STATE, mkWheel({ deltaY: -1, deltaMode: 1 }), mkCtx()).state;
    const pageState = onWheel(INITIAL_STATE, mkWheel({ deltaY: -1, deltaMode: 2 }), mkCtx()).state;
    if (lineState.phase === 'active' && pageState.phase === 'active') {
      expect(pageState.gestureScale).toBeGreaterThan(lineState.gestureScale);
    }
  });
});

describe('onTick', () => {
  it('no effects when idle', () => {
    const { effects } = onTick(INITIAL_STATE, 1000);
    expect(effects).toEqual([]);
  });

  it('commits on first tick of an active gesture (lastCommitAt is null)', () => {
    const active = onWheel(INITIAL_STATE, mkWheel(), mkCtx({ now: 1000 })).state;
    const { state, effects } = onTick(active, 1005);
    const commits = effects.filter((e) => e.kind === 'commit');
    expect(commits).toHaveLength(1);
    if (state.phase === 'active') {
      expect(state.lastCommitAt).toBe(1005);
      expect(state.gestureScale).toBe(1);
    }
  });

  it('does not commit if less than COMMIT_INTERVAL_MS since last commit', () => {
    let state: GestureState = INITIAL_STATE;
    state = onWheel(state, mkWheel(), mkCtx({ now: 1000 })).state;
    state = onTick(state, 1005).state;
    state = onWheel(state, mkWheel(), mkCtx({ now: 1030 })).state;
    const { effects } = onTick(state, 1005 + COMMIT_INTERVAL_MS - 10);
    expect(effects.filter((e) => e.kind === 'commit')).toHaveLength(0);
  });

  it('commits if ≥COMMIT_INTERVAL_MS since last commit and there is new motion', () => {
    let state: GestureState = INITIAL_STATE;
    state = onWheel(state, mkWheel(), mkCtx({ now: 1000 })).state;
    state = onTick(state, 1005).state;
    state = onWheel(state, mkWheel(), mkCtx({ now: 1050 })).state;
    const { effects } = onTick(state, 1005 + COMMIT_INTERVAL_MS + 5);
    expect(effects.filter((e) => e.kind === 'commit')).toHaveLength(1);
  });

  it('does not commit if no new wheel since last commit (nothing to flush)', () => {
    let state: GestureState = INITIAL_STATE;
    state = onWheel(state, mkWheel(), mkCtx({ now: 1000 })).state;
    state = onTick(state, 1005).state;
    const { effects } = onTick(state, 1005 + COMMIT_INTERVAL_MS + 5);
    expect(effects.filter((e) => e.kind === 'commit')).toHaveLength(0);
  });

  it('each commit is accompanied by exactly one resetTransform', () => {
    let state: GestureState = INITIAL_STATE;
    state = onWheel(state, mkWheel(), mkCtx({ now: 1000 })).state;
    const { effects } = onTick(state, 1005);
    const commits = effects.filter((e) => e.kind === 'commit');
    const resets = effects.filter((e) => e.kind === 'resetTransform');
    expect(commits).toHaveLength(1);
    expect(resets).toHaveLength(1);
  });

  it('commit carries scaleDelta = current gestureScale at commit time', () => {
    let state: GestureState = INITIAL_STATE;
    state = onWheel(state, mkWheel({ deltaY: -200 }), mkCtx({ now: 1000 })).state;
    let gestureScaleBefore = 1;
    if (state.phase === 'active') gestureScaleBefore = state.gestureScale;
    const { effects } = onTick(state, 1005);
    const commit = effects.find((e) => e.kind === 'commit');
    if (commit?.kind === 'commit') {
      expect(commit.scaleDelta).toBe(gestureScaleBefore);
      expect(commit.anchorBp).toBe(42);
      expect(commit.anchorCursorY).toBe(400);
    }
  });
});

describe('onSettle', () => {
  it('no-op when idle', () => {
    const { state, effects } = onSettle(INITIAL_STATE, 1000);
    expect(state.phase).toBe('idle');
    expect(effects).toEqual([]);
  });

  it('transitions to idle and flushes pending gestureScale', () => {
    let state: GestureState = INITIAL_STATE;
    state = onWheel(state, mkWheel(), mkCtx({ now: 1000 })).state;
    state = onTick(state, 1005).state;
    state = onWheel(state, mkWheel(), mkCtx({ now: 1050 })).state;
    const { state: finalState, effects } = onSettle(state, 1400);
    expect(finalState.phase).toBe('idle');
    expect(effects.filter((e) => e.kind === 'commit').length).toBeGreaterThanOrEqual(1);
    expect(effects.filter((e) => e.kind === 'resetTransform').length).toBeGreaterThanOrEqual(1);
  });

  it('does not emit a final commit if gestureScale is already 1', () => {
    let state: GestureState = INITIAL_STATE;
    state = onWheel(state, mkWheel(), mkCtx({ now: 1000 })).state;
    state = onTick(state, 1005).state;
    const { state: finalState, effects } = onSettle(state, 1400);
    expect(finalState.phase).toBe('idle');
    expect(effects.filter((e) => e.kind === 'commit')).toHaveLength(0);
  });
});

describe('computeAnchoredScrollTop', () => {
  it('scrollTop = rowTop(anchorBp) - anchorCursorY', () => {
    const rowTopForBp = (bp: number) => (bp === 100 ? 5000 : null);
    expect(computeAnchoredScrollTop(100, 400, rowTopForBp)).toBe(4600);
  });

  it('clamps to 0 when anchor is near top and math underflows', () => {
    const rowTopForBp = () => 100;
    expect(computeAnchoredScrollTop(0, 400, rowTopForBp)).toBe(0);
  });

  it('returns null when rowTopForBp returns null', () => {
    expect(computeAnchoredScrollTop(100, 400, () => null)).toBeNull();
  });
});

describe('gestureScale clamp (A1)', () => {
  it('caps gestureScale at the same 120% ceiling as the wrapped controls', () => {
    let state: GestureState = INITIAL_STATE;
    for (let i = 0; i < 100; i++) {
      state = onWheel(
        state,
        mkWheel({ deltaY: -500, deltaMode: 0 }),
        mkCtx({ now: 1000 + i * 16, currentZoom: 50 })
      ).state;
    }
    if (state.phase !== 'active') throw new Error('expected active');
    expect(state.gestureScale * 50).toBeCloseTo(120, 10);
  });

  it('caps gestureScale so effective zoom never goes below MIN_ZOOM', () => {
    let state: GestureState = INITIAL_STATE;
    for (let i = 0; i < 100; i++) {
      state = onWheel(
        state,
        mkWheel({ deltaY: 500, deltaMode: 0 }),
        mkCtx({ now: 1000 + i * 16, currentZoom: 50 })
      ).state;
    }
    if (state.phase !== 'active') throw new Error('expected active');
    expect(state.gestureScale).toBeGreaterThanOrEqual(MIN_ZOOM / 50 - 1e-9);
  });

  it('at the maximum, further zoom-in wheels cannot raise gestureScale above 1', () => {
    let state: GestureState = INITIAL_STATE;
    for (let i = 0; i < 20; i++) {
      state = onWheel(
        state,
        mkWheel({ deltaY: -500 }),
        mkCtx({ now: 1000 + i * 16, currentZoom: MAX_ZOOM })
      ).state;
    }
    if (state.phase !== 'active') throw new Error('expected active');
    expect(state.gestureScale).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('at currentZoom=MIN_ZOOM, further zoom-out wheels cannot drop gestureScale below 1', () => {
    let state: GestureState = INITIAL_STATE;
    for (let i = 0; i < 20; i++) {
      state = onWheel(
        state,
        mkWheel({ deltaY: 500 }),
        mkCtx({ now: 1000 + i * 16, currentZoom: MIN_ZOOM })
      ).state;
    }
    if (state.phase !== 'active') throw new Error('expected active');
    expect(state.gestureScale).toBeGreaterThanOrEqual(1 - 1e-9);
  });
});

describe('invariants — physically impossible conditions', () => {
  it('I1: 100 wheel events emit 0 commit effects', () => {
    let state: GestureState = INITIAL_STATE;
    let commitCount = 0;
    for (let i = 0; i < 100; i++) {
      const { state: s, effects } = onWheel(state, mkWheel(), mkCtx({ now: 1000 + i * 16 }));
      state = s;
      for (const e of effects) {
        if ((e as { kind: string }).kind === 'commit') commitCount++;
      }
    }
    expect(commitCount).toBe(0);
  });

  it('I2: 100 wheel events + tick after each produce ≤ ceil(elapsed / COMMIT_INTERVAL_MS) + 1 commits', () => {
    let state: GestureState = INITIAL_STATE;
    let commitCount = 0;
    const tickCount = 100;
    const spacingMs = 16;
    const elapsed = tickCount * spacingMs;
    for (let i = 0; i < tickCount; i++) {
      const now = 1000 + i * spacingMs;
      state = onWheel(state, mkWheel(), mkCtx({ now })).state;
      const { state: s2, effects } = onTick(state, now);
      state = s2;
      for (const e of effects) if (e.kind === 'commit') commitCount++;
    }
    const maxCommits = Math.ceil(elapsed / COMMIT_INTERVAL_MS) + 1;
    expect(commitCount).toBeLessThanOrEqual(maxCommits);
    expect(commitCount).toBeGreaterThan(0);
  });

  it('I3: anchor bp captured on first wheel is immutable across wheels+ticks until settle', () => {
    let state: GestureState = INITIAL_STATE;
    state = onWheel(state, mkWheel(), mkCtx({ now: 1000, anchorBpFromCursor: () => 100 })).state;
    state = onWheel(state, mkWheel(), mkCtx({ now: 1020, anchorBpFromCursor: () => 999 })).state;
    state = onTick(state, 1025).state;
    state = onWheel(state, mkWheel(), mkCtx({ now: 1150, anchorBpFromCursor: () => 888 })).state;
    state = onTick(state, 1155).state;
    if (state.phase !== 'active') throw new Error('expected active');
    expect(state.anchor.bp).toBe(100);
  });

  it('I4: after settle the state is always idle', () => {
    let state: GestureState = INITIAL_STATE;
    state = onWheel(state, mkWheel(), mkCtx({ now: 1000 })).state;
    for (let i = 0; i < 20; i++) state = onTick(state, 1000 + i * 50).state;
    state = onSettle(state, 2000).state;
    expect(state.phase).toBe('idle');
  });

  it('I5: round-trip — computeAnchoredScrollTop places anchor bp exactly at anchorCursorY', () => {
    const rowTopForBp = (bp: number) => (bp === 123 ? 7500 : null);
    const scrollTop = computeAnchoredScrollTop(123, 300, rowTopForBp);
    const anchorViewportY = 7500 - (scrollTop ?? 0);
    expect(anchorViewportY).toBe(300);
  });
});

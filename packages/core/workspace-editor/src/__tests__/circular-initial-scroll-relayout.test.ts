import { describe, it, expect } from 'vitest';
import { resolveCircularInitialScrollTop } from '../circular-initial-scroll';

interface ScrollState {
  scrollTop: number;
  lastAppliedY: number | null;
}
interface CircularLayout {
  circular: boolean;
  realRowsStartY: number;
}

function settleLayout(state: ScrollState, layout: CircularLayout): void {
  const next = resolveCircularInitialScrollTop({
    circular: layout.circular,
    realRowsStartY: layout.realRowsStartY,
    currentScrollTop: state.scrollTop,
    lastAppliedRealRowsStartY: state.lastAppliedY,
  });
  if (next !== null) {
    state.scrollTop = next;
    state.lastAppliedY = next;
  }
}

function externalScroll(state: ScrollState, to: number): void {
  state.scrollTop = to;
}

describe('circular initial scroll must follow realRowsStartY as the layout settles', () => {
  const PRE_FINAL = 4504;
  const SETTLED = 14637;

  it('does not run the boot-time tracker during a zoom commit', () => {
    expect(
      resolveCircularInitialScrollTop({
        circular: true,
        isZoomCommit: true,
        realRowsStartY: 3_506,
        currentScrollTop: 97_642,
        lastAppliedRealRowsStartY: 97_642,
      })
    ).toBeNull();
  });

  it('re-targets the scroll to the settled realRowsStartY (does not latch to the pre-final layout)', () => {
    const state: ScrollState = { scrollTop: 0, lastAppliedY: null };

    settleLayout(state, { circular: true, realRowsStartY: PRE_FINAL });
    expect(state.scrollTop).toBe(PRE_FINAL);

    settleLayout(state, { circular: true, realRowsStartY: SETTLED });
    expect(state.scrollTop).toBe(SETTLED);
  });

  it('is a no-op when the same settled layout is re-emitted (no scroll thrash)', () => {
    const state: ScrollState = { scrollTop: 0, lastAppliedY: null };
    settleLayout(state, { circular: true, realRowsStartY: SETTLED });
    const after = state.scrollTop;
    settleLayout(state, { circular: true, realRowsStartY: SETTLED });
    expect(state.scrollTop).toBe(after);
  });

  it('does not fight a real user scroll after the initial scroll is established', () => {
    const state: ScrollState = { scrollTop: 0, lastAppliedY: null };
    settleLayout(state, { circular: true, realRowsStartY: PRE_FINAL });
    externalScroll(state, 9000);
    settleLayout(state, { circular: true, realRowsStartY: SETTLED });
    expect(state.scrollTop).toBe(9000);
  });

  it('does not fight the bp-restore coordinator landing on a saved position', () => {
    const state: ScrollState = { scrollTop: 0, lastAppliedY: null };
    settleLayout(state, { circular: true, realRowsStartY: PRE_FINAL });
    externalScroll(state, SETTLED);
    settleLayout(state, { circular: true, realRowsStartY: SETTLED });
    expect(state.scrollTop).toBe(SETTLED);
  });

  it('never scrolls a linear sequence (no top buffer to skip)', () => {
    const state: ScrollState = { scrollTop: 0, lastAppliedY: null };
    settleLayout(state, { circular: false, realRowsStartY: 4504 });
    expect(state.scrollTop).toBe(0);
    expect(state.lastAppliedY).toBeNull();
  });
});

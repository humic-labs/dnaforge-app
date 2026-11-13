// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { create } from 'zustand';

import { withRevision } from './store-revision';

interface CounterState {
  revision: number;
  count: number;
  increment: () => void;
  noop: () => void;
  setBoth: (count: number) => void;
  resetWithSetState: () => void;
}

function makeCounter() {
  return create<CounterState>()(
    withRevision((set, _get, api) => ({
      revision: 0,
      count: 0,
      increment: () => set((state) => ({ count: state.count + 1 })),
      noop: () => set((state) => state),
      setBoth: (count) => set({ count }),
      resetWithSetState: () => api.setState({ count: 0 }),
    }))
  );
}

describe('withRevision middleware (per-store-invariants)', () => {
  it('starts at revision 0', () => {
    const useStore = makeCounter();
    expect(useStore.getState().revision).toBe(0);
  });

  it('function-form set bumps revision when state changes', () => {
    const useStore = makeCounter();
    useStore.getState().increment();
    expect(useStore.getState().revision).toBe(1);
    expect(useStore.getState().count).toBe(1);
    useStore.getState().increment();
    expect(useStore.getState().revision).toBe(2);
  });

  it('function-form short-circuit (return state) does NOT bump revision', () => {
    const useStore = makeCounter();
    useStore.getState().increment();
    const before = useStore.getState().revision;
    useStore.getState().noop();
    expect(useStore.getState().revision).toBe(before);
  });

  it('object-form set always bumps revision', () => {
    const useStore = makeCounter();
    useStore.getState().setBoth(42);
    expect(useStore.getState().revision).toBe(1);
    expect(useStore.getState().count).toBe(42);
  });

  it('external setState() via api also bumps revision', () => {
    const useStore = makeCounter();
    useStore.getState().resetWithSetState();
    expect(useStore.getState().revision).toBe(1);
  });

  it('useStore.setState({...}) from outside the initializer bumps revision', () => {
    const useStore = makeCounter();
    useStore.setState({ count: 7 });
    expect(useStore.getState().revision).toBe(1);
    expect(useStore.getState().count).toBe(7);
  });

  it('setState in merge mode overrides revision (middleware spreads last)', () => {
    const useStore = makeCounter();
    useStore.setState({ count: 5 });
    expect(useStore.getState().revision).toBe(1);
    useStore.setState({ count: 0, revision: 0 });
    expect(useStore.getState().revision).toBe(2);
  });

  it('replace-mode setState escapes the bump (test reset hatch)', () => {
    const useStore = makeCounter();
    useStore.setState({ count: 5 });
    expect(useStore.getState().revision).toBe(1);
    useStore.setState(
      {
        revision: 0,
        count: 0,
        increment: useStore.getState().increment,
        noop: useStore.getState().noop,
        setBoth: useStore.getState().setBoth,
        resetWithSetState: useStore.getState().resetWithSetState,
      },
      true
    );
    expect(useStore.getState().revision).toBe(0);
    expect(useStore.getState().count).toBe(0);
  });

  it('replace-mode api.setState also escapes the bump', () => {
    const useStore = makeCounter();
    useStore.setState({ count: 5 });
    expect(useStore.getState().revision).toBe(1);
    useStore.setState(
      {
        revision: 0,
        count: 0,
        increment: useStore.getState().increment,
        noop: useStore.getState().noop,
        setBoth: useStore.getState().setBoth,
        resetWithSetState: useStore.getState().resetWithSetState,
      },
      true
    );
    expect(useStore.getState().revision).toBe(0);
  });

  it('bumps revision exactly once per set() call', () => {
    const useStore = makeCounter();
    const subscriber = (() => {
      let calls = 0;
      return {
        listener: () => {
          calls += 1;
        },
        get: () => calls,
      };
    })();
    useStore.subscribe(subscriber.listener);
    useStore.getState().increment();
    expect(subscriber.get()).toBe(1);
    expect(useStore.getState().revision).toBe(1);
  });
});

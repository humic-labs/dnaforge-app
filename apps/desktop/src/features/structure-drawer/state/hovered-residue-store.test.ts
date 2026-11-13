// @vitest-environment node

import { describe, it, expect, vi } from 'vitest';
import { createHoveredResidueStore, type HoveredResidueKey } from './hovered-residue-store';

const KEY_A: HoveredResidueKey = {
  structureId: 'drawer-alphafold-P0AD86',
  chain: 'A',
  position: 47,
};

const KEY_B: HoveredResidueKey = {
  structureId: 'drawer-alphafold-P00533',
  chain: 'A',
  position: 12,
};

describe('hoveredResidueStore', () => {
  it('starts null and notifies on set', () => {
    const store = createHoveredResidueStore();
    expect(store.getSnapshot()).toBeNull();
    const listener = vi.fn();
    store.subscribe(listener);
    store.set(KEY_A);
    expect(store.getSnapshot()).toEqual(KEY_A);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('skips notifications when set is called with the same key', () => {
    const store = createHoveredResidueStore();
    store.set(KEY_A);
    const listener = vi.fn();
    store.subscribe(listener);
    store.set({ ...KEY_A });
    expect(listener).not.toHaveBeenCalled();
  });

  it('notifies when any field of the key changes', () => {
    const store = createHoveredResidueStore();
    store.set(KEY_A);
    const listener = vi.fn();
    store.subscribe(listener);
    store.set({ ...KEY_A, position: 48 });
    expect(listener).toHaveBeenCalledTimes(1);
    store.set({ ...KEY_A, chain: 'B', position: 48 });
    expect(listener).toHaveBeenCalledTimes(2);
    store.set({ ...KEY_B, position: 48 });
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('notifies on transition to/from null', () => {
    const store = createHoveredResidueStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.set(KEY_A);
    store.set(null);
    store.set(KEY_A);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('unsubscribe stops notifications', () => {
    const store = createHoveredResidueStore();
    const listener = vi.fn();
    const unsub = store.subscribe(listener);
    store.set(KEY_A);
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
    store.set(KEY_B);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('multiple subscribers all fire', () => {
    const store = createHoveredResidueStore();
    const listenerA = vi.fn();
    const listenerB = vi.fn();
    store.subscribe(listenerA);
    store.subscribe(listenerB);
    store.set(KEY_A);
    expect(listenerA).toHaveBeenCalledTimes(1);
    expect(listenerB).toHaveBeenCalledTimes(1);
  });
});

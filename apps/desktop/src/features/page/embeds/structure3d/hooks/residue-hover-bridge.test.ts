// @vitest-environment node

import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  createDeferredStructureHoverSync,
  decideOutboundWrite,
  decideInboundDispatch,
  type InboundHoverOwner,
  shouldClearInboundHover,
  shouldClearOnUnmount,
} from './residue-hover-bridge';
import type { ResidueLocation } from '../types';
import type { HoveredResidueKey } from '../../../../structure-drawer/state/hovered-residue-store';

const STRUCT_A = 'drawer-alphafold-P0AD86';
const STRUCT_B = 'drawer-alphafold-P00533';

const RESIDUE_47: ResidueLocation = { chain: 'A', position: 47 };
const RESIDUE_48: ResidueLocation = { chain: 'A', position: 48 };
const RESIDUE_47_B_CHAIN: ResidueLocation = { chain: 'B', position: 47 };
const SCOPED_PDB_RESIDUE: ResidueLocation = {
  chain: 'H',
  position: 47,
  baseChain: 'B',
  labelAsymId: 'B',
  authAsymId: 'H',
  entityId: '1',
};
const LIGAND: ResidueLocation = { chain: 'A', position: 999, compId: 'ATP' };

const KEY_A_47: HoveredResidueKey = { structureId: STRUCT_A, chain: 'A', position: 47 };
const KEY_A_48: HoveredResidueKey = { structureId: STRUCT_A, chain: 'A', position: 48 };
const KEY_B_47: HoveredResidueKey = { structureId: STRUCT_B, chain: 'A', position: 47 };
const KEY_SCOPED_PDB_47: HoveredResidueKey = {
  structureId: STRUCT_A,
  chain: 'H',
  position: 47,
  baseChain: 'B',
  labelAsymId: 'B',
  authAsymId: 'H',
  entityId: '1',
};
const INBOUND_A_47: InboundHoverOwner = { structureId: STRUCT_A, residue: RESIDUE_47 };
const INBOUND_B_47: InboundHoverOwner = { structureId: STRUCT_B, residue: RESIDUE_47 };

function createStore(initial: HoveredResidueKey | null = null) {
  let current = initial;
  const set = vi.fn((next: HoveredResidueKey | null) => {
    current = next;
  });
  return {
    getSnapshot: () => current,
    set,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('decideOutboundWrite (structure pointer → cross-surface store)', () => {
  it('null residue → null', () => {
    expect(decideOutboundWrite(null, STRUCT_A)).toBeNull();
    expect(decideOutboundWrite(undefined, STRUCT_A)).toBeNull();
  });

  it('ligand (compId set) → null', () => {
    expect(decideOutboundWrite(LIGAND, STRUCT_A)).toBeNull();
  });

  it('normal residue → key with our structureId + the residue chain/position', () => {
    expect(decideOutboundWrite(RESIDUE_47, STRUCT_A)).toEqual({
      structureId: STRUCT_A,
      chain: 'A',
      position: 47,
    });
  });

  it('preserves chain when residue is on a non-A chain', () => {
    expect(decideOutboundWrite(RESIDUE_47_B_CHAIN, STRUCT_A)).toEqual({
      structureId: STRUCT_A,
      chain: 'B',
      position: 47,
    });
  });

  it('preserves PDB label/auth/entity scope when writing to the cross-surface store', () => {
    expect(decideOutboundWrite(SCOPED_PDB_RESIDUE, STRUCT_A)).toEqual(KEY_SCOPED_PDB_47);
  });
});

describe('decideInboundDispatch (cross-surface store → structure-3d setHovered)', () => {
  it('null store value → no dispatch', () => {
    expect(decideInboundDispatch(null, STRUCT_A, null)).toBeNull();
    expect(decideInboundDispatch(null, STRUCT_A, RESIDUE_47)).toBeNull();
  });

  it('store value belongs to a different structure → no dispatch', () => {
    expect(decideInboundDispatch(KEY_B_47, STRUCT_A, null)).toBeNull();
    expect(decideInboundDispatch(KEY_B_47, STRUCT_A, RESIDUE_47)).toBeNull();
  });

  it('store value matches local hover (loop guard) → no dispatch', () => {
    expect(decideInboundDispatch(KEY_A_47, STRUCT_A, RESIDUE_47)).toBeNull();
  });

  it('store value differs from local hover → dispatch the new residue', () => {
    expect(decideInboundDispatch(KEY_A_48, STRUCT_A, RESIDUE_47)).toEqual({
      chain: 'A',
      position: 48,
    });
  });

  it('local hover is null but store has our key → dispatch (sequence-side write)', () => {
    expect(decideInboundDispatch(KEY_A_47, STRUCT_A, null)).toEqual({
      chain: 'A',
      position: 47,
    });
  });

  it('dispatches scoped PDB residue metadata from sequence-side hover', () => {
    expect(decideInboundDispatch(KEY_SCOPED_PDB_47, STRUCT_A, null)).toEqual(SCOPED_PDB_RESIDUE);
  });

  it('local hover is a ligand (compId) → still dispatch even if positions match', () => {
    const ligandLocal = { ...LIGAND, position: 47 };
    expect(decideInboundDispatch(KEY_A_47, STRUCT_A, ligandLocal)).toEqual({
      chain: 'A',
      position: 47,
    });
  });

  it('different chain on same position → dispatch (chain matters)', () => {
    expect(decideInboundDispatch(KEY_A_47, STRUCT_A, RESIDUE_47_B_CHAIN)).toEqual({
      chain: 'A',
      position: 47,
    });
  });
});

describe('shouldClearInboundHover (sequence-side clear → structure-3d clear)', () => {
  it('clears when the local hover was last set by an inbound sequence-side write', () => {
    expect(shouldClearInboundHover(null, STRUCT_A, RESIDUE_47, INBOUND_A_47)).toBe(true);
  });

  it('does not clear a local hover owned by the structure pointer', () => {
    expect(shouldClearInboundHover(null, STRUCT_A, RESIDUE_48, INBOUND_A_47)).toBe(false);
    expect(shouldClearInboundHover(null, STRUCT_A, RESIDUE_47, null)).toBe(false);
  });

  it('does not clear while the cross-surface store still contains a residue', () => {
    expect(shouldClearInboundHover(KEY_A_47, STRUCT_A, RESIDUE_47, INBOUND_A_47)).toBe(false);
  });

  it('does not clear when the last inbound hover belongs to another structure', () => {
    expect(shouldClearInboundHover(null, STRUCT_A, RESIDUE_47, INBOUND_B_47)).toBe(false);
  });
});

describe('shouldClearOnUnmount', () => {
  it('returns true when store entry belongs to this structure', () => {
    expect(shouldClearOnUnmount(KEY_A_47, STRUCT_A)).toBe(true);
  });

  it('returns false when store entry belongs to a different structure', () => {
    expect(shouldClearOnUnmount(KEY_B_47, STRUCT_A)).toBe(false);
  });

  it('returns false when the store is already null', () => {
    expect(shouldClearOnUnmount(null, STRUCT_A)).toBe(false);
  });
});

describe('createDeferredStructureHoverSync', () => {
  it('defers structure hover writes so Mol* local hover is not blocked by sequence mirrors', () => {
    vi.useFakeTimers();
    const store = createStore();
    const sync = createDeferredStructureHoverSync(store, { delayMs: 25 });

    sync.schedule(KEY_A_47);

    expect(store.set).not.toHaveBeenCalled();
    vi.advanceTimersByTime(25);
    expect(store.set).toHaveBeenCalledOnce();
    expect(store.getSnapshot()).toEqual(KEY_A_47);
  });

  it('coalesces rapid residue hovers to the latest residue', () => {
    vi.useFakeTimers();
    const store = createStore();
    const sync = createDeferredStructureHoverSync(store, { delayMs: 25 });

    sync.schedule(KEY_A_47);
    vi.advanceTimersByTime(10);
    sync.schedule(KEY_A_48);
    vi.advanceTimersByTime(25);

    expect(store.set).toHaveBeenCalledOnce();
    expect(store.getSnapshot()).toEqual(KEY_A_48);
  });

  it('does not let a stale structure hover clobber another surface hover', () => {
    vi.useFakeTimers();
    const store = createStore();
    const sync = createDeferredStructureHoverSync(store, { delayMs: 25 });

    sync.schedule(KEY_A_47);
    store.set(KEY_B_47);
    vi.advanceTimersByTime(25);

    expect(store.getSnapshot()).toEqual(KEY_B_47);
  });

  it('writes after an older value from another surface when that value is unchanged', () => {
    vi.useFakeTimers();
    const store = createStore(KEY_B_47);
    const sync = createDeferredStructureHoverSync(store, { delayMs: 25 });

    sync.schedule(KEY_A_47);
    vi.advanceTimersByTime(25);

    expect(store.getSnapshot()).toEqual(KEY_A_47);
  });

  it('does not let a delayed structure clear remove another surface hover', () => {
    vi.useFakeTimers();
    const store = createStore();
    const sync = createDeferredStructureHoverSync(store, { delayMs: 25 });

    sync.schedule(KEY_A_47);
    vi.advanceTimersByTime(25);
    expect(store.getSnapshot()).toEqual(KEY_A_47);

    sync.schedule(null);
    store.set(KEY_B_47);
    vi.advanceTimersByTime(25);

    expect(store.getSnapshot()).toEqual(KEY_B_47);
  });
});

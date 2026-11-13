// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createElement, type PropsWithChildren } from 'react';
import {
  createHoveredCodonStore,
  HoveredCodonProvider,
  useHoveredCodon,
  useEffectiveHoveredCodon,
} from './hovered-codon-store';

describe('hoveredCodonStore — source field', () => {
  it('preserves source on round-trip', () => {
    const store = createHoveredCodonStore();
    store.set({ start: 100, end: 102, strand: 1, source: 'structure' });
    expect(store.getSnapshot()?.source).toBe('structure');
  });

  it('dedups identical writes including source', () => {
    const store = createHoveredCodonStore();
    let notifications = 0;
    store.subscribe(() => {
      notifications++;
    });
    store.set({ start: 100, end: 102, strand: 1, source: 'sequence' });
    store.set({ start: 100, end: 102, strand: 1, source: 'sequence' });
    expect(notifications).toBe(1);
  });

  it('does NOT dedup when source differs (chevron-cell stroke must propagate)', () => {
    const store = createHoveredCodonStore();
    store.set({ start: 100, end: 102, strand: 1, source: 'sequence' });
    let notifications = 0;
    store.subscribe(() => {
      notifications++;
    });
    store.set({ start: 100, end: 102, strand: 1, source: 'structure' });
    expect(notifications).toBe(1);
    expect(store.getSnapshot()?.source).toBe('structure');
  });

  it('null source field is preserved (legacy callers)', () => {
    const store = createHoveredCodonStore();
    store.set({ start: 100, end: 102, strand: 1 });
    expect(store.getSnapshot()?.source).toBeUndefined();
  });
});

describe('useHoveredCodon — context bridge', () => {
  beforeEach(() => {});

  it('returns null with no provider', () => {
    const { result } = renderHook(() => useHoveredCodon());
    expect(result.current).toBeNull();
  });

  it('returns the store snapshot when wrapped', () => {
    const store = createHoveredCodonStore();
    store.set({ start: 100, end: 102, strand: 1, source: 'structure' });
    function wrapper({ children }: PropsWithChildren) {
      return createElement(HoveredCodonProvider, { value: store }, children);
    }
    const { result } = renderHook(() => useHoveredCodon(), { wrapper });
    expect(result.current).toMatchObject({ start: 100, end: 102, source: 'structure' });
  });
});

describe('useEffectiveHoveredCodon — store-wins resolver', () => {
  it('returns store value when set, ignoring local', () => {
    const store = createHoveredCodonStore();
    store.set({ start: 200, end: 202, strand: 1, source: 'structure' });
    function wrapper({ children }: PropsWithChildren) {
      return createElement(HoveredCodonProvider, { value: store }, children);
    }
    const { result } = renderHook(
      () => useEffectiveHoveredCodon({ start: 999, end: 1001, strand: 1 }),
      { wrapper }
    );
    expect(result.current?.start).toBe(200);
  });

  it('falls back to local when store is null', () => {
    const store = createHoveredCodonStore();
    function wrapper({ children }: PropsWithChildren) {
      return createElement(HoveredCodonProvider, { value: store }, children);
    }
    const { result } = renderHook(
      () => useEffectiveHoveredCodon({ start: 999, end: 1001, strand: 1 }),
      { wrapper }
    );
    expect(result.current?.start).toBe(999);
  });

  it('returns null when both store and local are null', () => {
    const { result } = renderHook(() => useEffectiveHoveredCodon(null));
    expect(result.current).toBeNull();
  });
});

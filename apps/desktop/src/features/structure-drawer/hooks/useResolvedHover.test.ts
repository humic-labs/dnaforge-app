// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createElement, type PropsWithChildren } from 'react';
import { createHoveredResidueStore, HoveredResidueProvider } from '../state/hovered-residue-store';
import { useStructureLinkRegistry } from '../state/use-structure-link-registry';
import { useResolvedHover } from './useResolvedHover';

const STRUCTURE_ID = 'drawer-alphafold-P0AD86';
const FILE_PATH = '/tmp/genome.gb';

beforeEach(() => {
  useStructureLinkRegistry.setState({ links: {} });
  useStructureLinkRegistry.getState().registerLink({
    structureId: STRUCTURE_ID,
    sequenceDocumentId: FILE_PATH,
    cdsLabel: 'thrL',
    translation: 'MKRISTTITTTITITTGNGAG',
    cdsStart: 100,
    cdsEnd: 162,
    strand: 1,
  });
});

describe('useResolvedHover — explicit-store path (the WorkspaceViewer fix)', () => {
  it('returns null when no residue is hovered', () => {
    const store = createHoveredResidueStore();
    const { result } = renderHook(() => useResolvedHover(FILE_PATH, store));
    expect(result.current).toBeNull();
  });

  it('returns the resolved bp range when the structure-side writer fires', () => {
    const store = createHoveredResidueStore();
    const { result, rerender } = renderHook(() => useResolvedHover(FILE_PATH, store));
    store.set({ structureId: STRUCTURE_ID, chain: 'A', position: 5 });
    rerender();
    expect(result.current).toMatchObject({
      filePath: FILE_PATH,
      bpRange: { start: 112, end: 114 },
      sourceStructureId: STRUCTURE_ID,
    });
  });

  it('returns null when the explicit store has a hover but the filePath does not match a registered link', () => {
    const store = createHoveredResidueStore();
    store.set({ structureId: STRUCTURE_ID, chain: 'A', position: 5 });
    const { result } = renderHook(() => useResolvedHover('/other/file.gb', store));
    expect(result.current).toBeNull();
  });

  it('does NOT read from React context when an explicit store is passed', () => {
    const contextStore = createHoveredResidueStore();
    const explicitStore = createHoveredResidueStore();
    contextStore.set({ structureId: STRUCTURE_ID, chain: 'A', position: 5 });
    explicitStore.set({ structureId: STRUCTURE_ID, chain: 'A', position: 10 });

    function wrapper({ children }: PropsWithChildren) {
      return createElement(HoveredResidueProvider, { value: contextStore }, children);
    }

    const { result } = renderHook(() => useResolvedHover(FILE_PATH, explicitStore), {
      wrapper,
    });

    expect(result.current?.bpRange.start).toBe(127);
  });
});

describe('useResolvedHover — context-fallback path (consumers inside the provider)', () => {
  it('reads from context when no explicit store is passed', () => {
    const store = createHoveredResidueStore();
    store.set({ structureId: STRUCTURE_ID, chain: 'A', position: 7 });

    function wrapper({ children }: PropsWithChildren) {
      return createElement(HoveredResidueProvider, { value: store }, children);
    }

    const { result } = renderHook(() => useResolvedHover(FILE_PATH), { wrapper });

    expect(result.current?.bpRange.start).toBe(118);
  });

  it('returns null when no provider is mounted (catches the original bug shape)', () => {
    const { result } = renderHook(() => useResolvedHover(FILE_PATH));
    expect(result.current).toBeNull();
  });
});

// @vitest-environment jsdom

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  computeResidueLinkBpRange,
  useResidueLinkOverlays,
  useResidueLinkBpHighlights,
} from './useResidueLinkOverlays';
import {
  useStructureLinkRegistry,
  type StructureLinkEntry,
} from '../state/use-structure-link-registry';
import type { HoveredResidueKey } from '../state/hovered-residue-store';

let mockHovered: HoveredResidueKey | null = null;
vi.mock('../state/hovered-residue-store', async (importOriginal) => {
  const real = await importOriginal<typeof import('../state/hovered-residue-store')>();
  return {
    ...real,
    useHoveredResidue: () => mockHovered,
  };
});

const FILE_PATH = '/tmp/genome.gb';
const STRUCTURE_ID = 'drawer-alphafold-P0AD86';

const FORWARD_LINK: StructureLinkEntry = {
  structureId: STRUCTURE_ID,
  sequenceDocumentId: FILE_PATH,
  cdsLabel: 'thrL',
  translation: 'MKRISTTITTTITITTGNGAG',
  cdsStart: 100,
  cdsEnd: 162,
  strand: 1,
};

const REVERSE_LINK: StructureLinkEntry = {
  ...FORWARD_LINK,
  structureId: 'drawer-alphafold-P00533',
  cdsStart: 200,
  cdsEnd: 262,
  strand: -1,
};

function reset() {
  mockHovered = null;
  useStructureLinkRegistry.setState({ links: {} });
}

describe('useResidueLinkOverlays', () => {
  beforeEach(reset);

  it('returns null when nothing is hovered', () => {
    useStructureLinkRegistry.getState().registerLink(FORWARD_LINK);
    const { result } = renderHook(() => useResidueLinkOverlays(FILE_PATH));
    expect(result.current).toBeNull();
  });

  it('returns null when filePath is null/undefined', () => {
    mockHovered = { structureId: STRUCTURE_ID, chain: 'A', position: 1 };
    useStructureLinkRegistry.getState().registerLink(FORWARD_LINK);
    const { result } = renderHook(() => useResidueLinkOverlays(null));
    expect(result.current).toBeNull();
  });

  it('returns null when no link matches the hovered structureId', () => {
    mockHovered = { structureId: 'unknown-struct', chain: 'A', position: 1 };
    useStructureLinkRegistry.getState().registerLink(FORWARD_LINK);
    const { result } = renderHook(() => useResidueLinkOverlays(FILE_PATH));
    expect(result.current).toBeNull();
  });

  it('returns null when the matched link points to a different file', () => {
    mockHovered = { structureId: STRUCTURE_ID, chain: 'A', position: 1 };
    useStructureLinkRegistry.getState().registerLink({
      ...FORWARD_LINK,
      sequenceDocumentId: '/tmp/other-genome.gb',
    });
    const { result } = renderHook(() => useResidueLinkOverlays(FILE_PATH));
    expect(result.current).toBeNull();
  });

  it('forward strand: residue 1 → bp [cdsStart, cdsStart+2]', () => {
    mockHovered = { structureId: STRUCTURE_ID, chain: 'A', position: 1 };
    useStructureLinkRegistry.getState().registerLink(FORWARD_LINK);
    const { result } = renderHook(() => useResidueLinkOverlays(FILE_PATH));
    expect(result.current).toHaveLength(1);
    expect(result.current?.[0].columns).toEqual([100, 101, 102]);
    expect(result.current?.[0].target).toBe('sequenceBand');
    expect(result.current?.[0].kind).toBe('columnWash');
  });

  it('forward strand: residue 5 → bp [cdsStart+12, cdsStart+14]', () => {
    mockHovered = { structureId: STRUCTURE_ID, chain: 'A', position: 5 };
    useStructureLinkRegistry.getState().registerLink(FORWARD_LINK);
    const { result } = renderHook(() => useResidueLinkOverlays(FILE_PATH));
    expect(result.current?.[0].columns).toEqual([112, 113, 114]);
  });

  it('reverse strand: residue 1 → bp [cdsEnd-2, cdsEnd]', () => {
    mockHovered = { structureId: REVERSE_LINK.structureId, chain: 'A', position: 1 };
    useStructureLinkRegistry.getState().registerLink(REVERSE_LINK);
    const { result } = renderHook(() => useResidueLinkOverlays(FILE_PATH));
    expect(result.current?.[0].columns).toEqual([260, 261, 262]);
  });

  it('overlay id is stable across re-renders for the same hover', () => {
    mockHovered = { structureId: STRUCTURE_ID, chain: 'A', position: 7 };
    useStructureLinkRegistry.getState().registerLink(FORWARD_LINK);
    const { result, rerender } = renderHook(() => useResidueLinkOverlays(FILE_PATH));
    const firstId = result.current?.[0].id;
    rerender();
    expect(result.current?.[0].id).toBe(firstId);
  });

  it('returns null for residue 0 (out of bounds; 1-indexed convention)', () => {
    mockHovered = { structureId: STRUCTURE_ID, chain: 'A', position: 0 };
    useStructureLinkRegistry.getState().registerLink(FORWARD_LINK);
    const { result } = renderHook(() => useResidueLinkOverlays(FILE_PATH));
    expect(result.current).toBeNull();
  });

  it('returns null for residue past CDS end (codon out of range)', () => {
    mockHovered = { structureId: STRUCTURE_ID, chain: 'A', position: 22 };
    useStructureLinkRegistry.getState().registerLink(FORWARD_LINK);
    const { result } = renderHook(() => useResidueLinkOverlays(FILE_PATH));
    expect(result.current).toBeNull();
  });
});

describe('computeResidueLinkBpRange — owner-scoped structure links', () => {
  it('finds a uniquely matching owner-scoped link without relying on a bare structure id alias', () => {
    const hovered = { structureId: STRUCTURE_ID, chain: 'A', position: 1 };
    const ownerScopedLink: StructureLinkEntry = {
      ...FORWARD_LINK,
      ownerId: 'translated-cds:/tmp/genome.gb:thrL:101-163:1',
    };

    expect(
      computeResidueLinkBpRange(
        hovered,
        {
          [`${STRUCTURE_ID}\u0000owner\u0000${ownerScopedLink.ownerId}`]: ownerScopedLink,
        },
        FILE_PATH
      )
    ).toEqual({
      id: `residue-${STRUCTURE_ID}-A-1`,
      start: 100,
      end: 102,
    });
  });

  it('fails closed when the same structure and file have multiple biological owners', () => {
    const hovered = { structureId: STRUCTURE_ID, chain: 'A', position: 1 };
    const atpDLink: StructureLinkEntry = {
      ...FORWARD_LINK,
      ownerId: 'translated-cds:/tmp/genome.gb:atpD:101-163:1',
      cdsLabel: 'atpD',
    };
    const atpELink: StructureLinkEntry = {
      ...FORWARD_LINK,
      ownerId: 'translated-cds:/tmp/genome.gb:atpE:401-463:1',
      cdsLabel: 'atpE',
      cdsStart: 400,
      cdsEnd: 462,
    };

    expect(
      computeResidueLinkBpRange(
        hovered,
        {
          [`${STRUCTURE_ID}\u0000owner\u0000${atpDLink.ownerId}`]: atpDLink,
          [`${STRUCTURE_ID}\u0000owner\u0000${atpELink.ownerId}`]: atpELink,
        },
        FILE_PATH
      )
    ).toBeNull();
  });
});

describe('useResidueLinkBpHighlights', () => {
  beforeEach(reset);

  it('returns null when nothing is hovered', () => {
    useStructureLinkRegistry.getState().registerLink(FORWARD_LINK);
    const { result } = renderHook(() => useResidueLinkBpHighlights(FILE_PATH));
    expect(result.current).toBeNull();
  });

  it('forward strand: residue 1 → bp range [cdsStart, cdsStart+2]', () => {
    mockHovered = { structureId: STRUCTURE_ID, chain: 'A', position: 1 };
    useStructureLinkRegistry.getState().registerLink(FORWARD_LINK);
    const { result } = renderHook(() => useResidueLinkBpHighlights(FILE_PATH));
    expect(result.current).toHaveLength(1);
    expect(result.current?.[0]).toMatchObject({
      start: 100,
      end: 102,
    });
    expect(result.current?.[0].color).toBeTruthy();
    expect(result.current?.[0].alpha).toBeGreaterThan(0);
    expect(result.current?.[0].alpha).toBeLessThan(1);
  });

  it('reverse strand: residue 1 → bp range [cdsEnd-2, cdsEnd]', () => {
    mockHovered = {
      structureId: REVERSE_LINK.structureId,
      chain: 'A',
      position: 1,
    };
    useStructureLinkRegistry.getState().registerLink(REVERSE_LINK);
    const { result } = renderHook(() => useResidueLinkBpHighlights(FILE_PATH));
    expect(result.current?.[0]).toMatchObject({ start: 260, end: 262 });
  });

  it('forward + reverse highlights share the same color (one cross-surface signal)', () => {
    mockHovered = { structureId: STRUCTURE_ID, chain: 'A', position: 3 };
    useStructureLinkRegistry.getState().registerLink(FORWARD_LINK);
    const { result: result1d } = renderHook(() => useResidueLinkOverlays(FILE_PATH));
    const { result: result2d } = renderHook(() => useResidueLinkBpHighlights(FILE_PATH));
    expect(result1d.current?.[0].color).toBe(result2d.current?.[0].color);
  });

  it('returns null when the matched link points to a different file', () => {
    mockHovered = { structureId: STRUCTURE_ID, chain: 'A', position: 1 };
    useStructureLinkRegistry.getState().registerLink({
      ...FORWARD_LINK,
      sequenceDocumentId: '/tmp/other-genome.gb',
    });
    const { result } = renderHook(() => useResidueLinkBpHighlights(FILE_PATH));
    expect(result.current).toBeNull();
  });
});

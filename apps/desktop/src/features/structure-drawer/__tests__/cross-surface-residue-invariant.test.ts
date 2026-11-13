/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  useResidueLinkOverlays,
  useResidueLinkBpHighlights,
} from '../hooks/useResidueLinkOverlays';
import { useResolvedHover } from '../hooks/useResolvedHover';
import {
  useStructureLinkRegistry,
  type StructureLinkEntry,
} from '../state/use-structure-link-registry';
import { codonToBpRange } from '../utils/codon-residue-mapping';
import type { HoveredResidueKey } from '../state/hovered-residue-store';

let mockHovered: HoveredResidueKey | null = null;
vi.mock('../state/hovered-residue-store', async (importOriginal) => {
  const real = await importOriginal<typeof import('../state/hovered-residue-store')>();
  return { ...real, useHoveredResidue: () => mockHovered };
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
  cdsStart: 200,
  cdsEnd: 262,
  strand: -1,
};

function reset() {
  mockHovered = null;
  useStructureLinkRegistry.setState({ links: {} });
}

type Surface = 'oneD-overlay' | 'twoD-bp-highlight' | 'webgl-minimap';

function surfaceBpRanges(): Record<Surface, [number, number] | null> {
  const { result: r1D } = renderHook(() => useResidueLinkOverlays(FILE_PATH));
  const oneD = r1D.current?.[0]?.columns ?? null;
  const { result: r2D } = renderHook(() => useResidueLinkBpHighlights(FILE_PATH));
  const twoD = r2D.current?.[0] ?? null;
  const { result: rWebGL } = renderHook(() => useResolvedHover(FILE_PATH));
  const webgl = rWebGL.current?.bpRange ?? null;
  return {
    'oneD-overlay': oneD ? [Math.min(...oneD), Math.max(...oneD)] : null,
    'twoD-bp-highlight': twoD ? [twoD.start, twoD.end] : null,
    'webgl-minimap': webgl ? [webgl.start, webgl.end] : null,
  };
}

function expectInvariantHolds(expected: [number, number] | null) {
  const ranges = surfaceBpRanges();
  for (const [surface, range] of Object.entries(ranges)) {
    expect(range, `surface "${surface}" diverged from expected`).toEqual(expected);
  }
}

describe('cross-surface residue hover invariant — all surfaces emit the same bp range', () => {
  beforeEach(reset);

  describe('forward strand', () => {
    beforeEach(() => {
      useStructureLinkRegistry.getState().registerLink(FORWARD_LINK);
    });

    it.each([1, 2, 5, 10, 15, 21])(
      'residue %i produces consistent bp range across surfaces',
      (residuePosition) => {
        mockHovered = { structureId: STRUCTURE_ID, chain: 'A', position: residuePosition };
        const expected = codonToBpRange(residuePosition - 1, {
          cdsStart: FORWARD_LINK.cdsStart,
          cdsEnd: FORWARD_LINK.cdsEnd,
          strand: FORWARD_LINK.strand,
        });
        expect(expected).not.toBeNull();
        expectInvariantHolds(expected ? [expected.start, expected.end] : null);
      }
    );
  });

  describe('reverse strand', () => {
    beforeEach(() => {
      useStructureLinkRegistry.getState().registerLink(REVERSE_LINK);
    });

    it.each([1, 2, 5, 10, 15, 21])(
      'residue %i produces consistent bp range across surfaces',
      (residuePosition) => {
        mockHovered = {
          structureId: REVERSE_LINK.structureId,
          chain: 'A',
          position: residuePosition,
        };
        const expected = codonToBpRange(residuePosition - 1, {
          cdsStart: REVERSE_LINK.cdsStart,
          cdsEnd: REVERSE_LINK.cdsEnd,
          strand: REVERSE_LINK.strand,
        });
        expect(expected).not.toBeNull();
        expectInvariantHolds(expected ? [expected.start, expected.end] : null);
      }
    );
  });

  describe('mapped structure residues', () => {
    beforeEach(() => {
      useStructureLinkRegistry.getState().registerLink({
        ...REVERSE_LINK,
        residueTarget: {
          chain: 'H',
          labelAsymId: 'H',
          authAsymId: 'F',
          entityId: '6',
          residues: [{ residueIndex: 2, position: 2 }],
        },
      });
    });

    it('uses explicit residue maps for structure-origin hover instead of position-minus-one', () => {
      mockHovered = {
        structureId: REVERSE_LINK.structureId,
        chain: 'H',
        labelAsymId: 'H',
        authAsymId: 'F',
        entityId: '6',
        position: 2,
      };
      const expected = codonToBpRange(2, {
        cdsStart: REVERSE_LINK.cdsStart,
        cdsEnd: REVERSE_LINK.cdsEnd,
        strand: REVERSE_LINK.strand,
      });
      expect(expected).not.toBeNull();
      expectInvariantHolds(expected ? [expected.start, expected.end] : null);
    });
  });

  describe('null-case parity (every surface returns null on every drop-out)', () => {
    it('no hover → all surfaces null', () => {
      useStructureLinkRegistry.getState().registerLink(FORWARD_LINK);
      mockHovered = null;
      expectInvariantHolds(null);
    });

    it('hover but no registered link → all surfaces null', () => {
      mockHovered = { structureId: STRUCTURE_ID, chain: 'A', position: 1 };
      expectInvariantHolds(null);
    });

    it('hover + registered link but mismatched structureId → all surfaces null', () => {
      useStructureLinkRegistry.getState().registerLink(FORWARD_LINK);
      mockHovered = { structureId: 'different-structure', chain: 'A', position: 1 };
      expectInvariantHolds(null);
    });

    it('hover + link present but link points to a different file → all surfaces null', () => {
      useStructureLinkRegistry.getState().registerLink({
        ...FORWARD_LINK,
        sequenceDocumentId: '/tmp/other-file.gb',
      });
      mockHovered = { structureId: STRUCTURE_ID, chain: 'A', position: 1 };
      expectInvariantHolds(null);
    });

    it('residue position 0 (pre-CDS) → all surfaces null', () => {
      useStructureLinkRegistry.getState().registerLink(FORWARD_LINK);
      mockHovered = { structureId: STRUCTURE_ID, chain: 'A', position: 0 };
      expectInvariantHolds(null);
    });

    it('residue past CDS end → all surfaces null', () => {
      useStructureLinkRegistry.getState().registerLink(FORWARD_LINK);
      mockHovered = { structureId: STRUCTURE_ID, chain: 'A', position: 100 };
      expectInvariantHolds(null);
    });
  });

  describe('color parity — cross-surface signal is one signal', () => {
    it('1D overlay color === 2D highlight color', () => {
      useStructureLinkRegistry.getState().registerLink(FORWARD_LINK);
      mockHovered = { structureId: STRUCTURE_ID, chain: 'A', position: 5 };
      const { result: r1D } = renderHook(() => useResidueLinkOverlays(FILE_PATH));
      const { result: r2D } = renderHook(() => useResidueLinkBpHighlights(FILE_PATH));
      expect(r1D.current?.[0].color).toBe(r2D.current?.[0].color);
    });

    it('1D overlay alpha and 2D highlight alpha are both in (0, 1)', () => {
      useStructureLinkRegistry.getState().registerLink(FORWARD_LINK);
      mockHovered = { structureId: STRUCTURE_ID, chain: 'A', position: 5 };
      const { result: r1D } = renderHook(() => useResidueLinkOverlays(FILE_PATH));
      const { result: r2D } = renderHook(() => useResidueLinkBpHighlights(FILE_PATH));
      const a1 = r1D.current?.[0].alpha;
      const a2 = r2D.current?.[0].alpha;
      expect(a1).toBeGreaterThan(0);
      expect(a1).toBeLessThanOrEqual(1);
      expect(a2).toBeGreaterThan(0);
      expect(a2).toBeLessThanOrEqual(1);
    });
  });
});

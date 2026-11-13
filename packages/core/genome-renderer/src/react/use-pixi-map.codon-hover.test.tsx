// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { usePixiMap } from './use-pixi-map';

type Props = {
  hoveredCodon: { start: number; end: number; strand: 1 | -1 } | null;
  selectedCodons?: ReadonlyArray<{ start: number; end: number; strand: 1 | -1 }>;
};

describe('usePixiMap codon hover bridge', () => {
  it('syncs external hovered codon props into Pixi render state without requiring a mounted Pixi app', () => {
    const initialProps: Props = {
      hoveredCodon: { start: 300, end: 302, strand: -1 },
    };
    const { result, rerender } = renderHook<ReturnType<typeof usePixiMap>, Props>(
      ({ hoveredCodon }: Props) =>
        usePixiMap({
          genome: null,
          circular: false,
          width: 800,
          height: 220,
          hoveredCodon,
        }),
      {
        initialProps,
      }
    );

    expect(result.current.handle.getState()?.hoveredCodon).toEqual({
      start: 300,
      end: 302,
      strand: -1,
    });

    rerender({ hoveredCodon: null });

    expect(result.current.handle.getState()?.hoveredCodon).toBeNull();
  });

  it('syncs external selected codon props into Pixi render state without requiring a mounted Pixi app', () => {
    const { result, rerender } = renderHook<ReturnType<typeof usePixiMap>, Props>(
      ({ hoveredCodon, selectedCodons }: Props) =>
        usePixiMap({
          genome: null,
          circular: false,
          width: 800,
          height: 220,
          hoveredCodon,
          selectedCodons,
        }),
      {
        initialProps: {
          hoveredCodon: null,
          selectedCodons: [{ start: 300, end: 302, strand: -1 }],
        },
      }
    );

    expect(result.current.handle.getState()?.selectedCodons).toEqual([
      { start: 300, end: 302, strand: -1 },
    ]);

    rerender({ hoveredCodon: null, selectedCodons: [] });

    expect(result.current.handle.getState()?.selectedCodons).toEqual([]);
  });

  it('syncs imperative hovered codon, selected codon, and residue-link updates without React props', () => {
    const { result } = renderHook(() =>
      usePixiMap({
        genome: null,
        circular: false,
        width: 800,
        height: 220,
      })
    );

    result.current.handle.setHoveredCodon({ start: 300, end: 302, strand: -1 });
    result.current.handle.setResidueLinkRange([300, 302]);
    result.current.handle.setSelectedCodons([{ start: 303, end: 305, strand: -1 }]);

    expect(result.current.handle.getState()?.hoveredCodon).toEqual({
      start: 300,
      end: 302,
      strand: -1,
    });
    expect(result.current.handle.getState()?.residueLinkRange).toEqual([300, 302]);
    expect(result.current.handle.getState()?.selectedCodons).toEqual([
      { start: 303, end: 305, strand: -1 },
    ]);

    result.current.handle.setHoveredCodon(null);
    result.current.handle.setResidueLinkRange(null);
    result.current.handle.setSelectedCodons([]);

    expect(result.current.handle.getState()?.hoveredCodon).toBeNull();
    expect(result.current.handle.getState()?.residueLinkRange).toBeNull();
    expect(result.current.handle.getState()?.selectedCodons).toEqual([]);
  });
});

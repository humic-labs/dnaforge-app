import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ComparisonProjection } from '../comparison-projection';
import { comparisonFixture } from '../test-support/comparison-projection-fixture';
import { usePixiMap } from './use-pixi-map';

const projection = comparisonFixture();

describe('native comparison camera transport', () => {
  it('uses aligned columns through the existing native navigation handle without rewriting the linear camera', () => {
    const changed = vi.fn();
    const { result } = renderHook(() =>
      usePixiMap({
        genome: null,
        circular: false,
        width: 800,
        height: 500,
        comparisonProjection: projection,
        onComparisonCameraChange: changed,
      })
    );
    act(() =>
      result.current.handle.setComparisonCamera({
        projectionId: projection.id,
        startColumn: 1,
        endColumn: 9,
      })
    );
    expect(result.current.handle.getViewportRange()).toEqual({ start: 1, end: 9 });
    expect(result.current.handle.getViewCenter()).toBe(5);
    expect(result.current.handle.getCameraCenter()).toBe(5);
    expect(result.current.handle.getZoomBounds()).toEqual({ min: 1, max: 44 });
    act(() => result.current.handle.setCameraViewport(10, 20));
    expect(result.current.handle.getComparisonCamera()).toEqual({
      projectionId: projection.id,
      startColumn: 10,
      endColumn: 20,
    });
    act(() => result.current.handle.setViewCenter(30));
    expect(result.current.handle.getViewportRange()).toEqual({ start: 25, end: 35 });
    expect(changed).toHaveBeenLastCalledWith(
      expect.objectContaining({ startColumn: 25 }),
      'scroll'
    );
    expect(result.current.handle.getState().zoom).toBe(1);
  });

  it('zooms the gapped shared axis and resets projection state when the comparison source changes', () => {
    const { result, rerender } = renderHook(
      ({ current }: { current: ComparisonProjection | null }) =>
        usePixiMap({
          genome: null,
          circular: false,
          width: 800,
          height: 500,
          comparisonProjection: current,
        }),
      { initialProps: { current: projection } }
    );
    act(() => result.current.handle.setZoom(4));
    expect(result.current.handle.getComparisonCamera()).toEqual({
      projectionId: projection.id,
      startColumn: 16.5,
      endColumn: 27.5,
    });
    expect(result.current.handle.getState().zoom).toBe(1);
    rerender({ current: { ...projection, id: 'replacement' } });
    expect(result.current.handle.getComparisonCamera()).toEqual({
      projectionId: 'replacement',
      startColumn: 0,
      endColumn: 44,
    });
    rerender({ current: null });
    expect(result.current.handle.getComparisonCamera()).toBeNull();
    expect(result.current.handle.getState().zoom).toBe(1);
  });
});

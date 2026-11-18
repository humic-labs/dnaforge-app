import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ContactProjection } from '../contact-projection';
import { usePixiMap } from './use-pixi-map';

const projection: ContactProjection = {
  kind: 'contact-matrix',
  id: 'contact-source',
  xReference: { id: 'reference-x', chrom: 'x', length: 1_000 },
  yReference: { id: 'reference-y', chrom: 'y', length: 2_000 },
  cells: [],
  colorScale: {
    kind: 'continuous',
    domain: [0, 10],
    colors: ['#ffffff', '#ff0000'],
    missingColor: '#cccccc',
    transform: 'linear',
  },
};

describe('native contact projection camera transport', () => {
  it('uses the contact X range for native coordinate navigation while retaining its Y range', () => {
    const changed = vi.fn();
    const { result } = renderHook(() =>
      usePixiMap({
        genome: null,
        circular: false,
        width: 800,
        height: 500,
        contactProjection: projection,
        onContactCameraChange: changed,
      })
    );
    act(() => {
      result.current.handle.setContactCamera({
        projectionId: projection.id,
        xStart: 100,
        xEnd: 500,
        yStart: 500,
        yEnd: 1_000,
      });
    });
    expect(result.current.handle.getViewportRange()).toEqual({ start: 100, end: 500 });
    expect(result.current.handle.getViewCenter()).toBe(300);
    expect(result.current.handle.getCameraCenter()).toBe(300);
    expect(result.current.handle.getZoomBounds()?.min).toBe(1);
    act(() => {
      result.current.handle.setCameraViewport(300, 700);
    });
    expect(result.current.handle.getContactCamera()).toEqual({
      projectionId: projection.id,
      xStart: 300,
      xEnd: 700,
      yStart: 500,
      yEnd: 1_000,
    });
    act(() => result.current.handle.setViewCenter(700));
    expect(result.current.handle.getViewportRange()).toEqual({ start: 500, end: 900 });
    expect(changed).toHaveBeenLastCalledWith(
      expect.objectContaining({ xStart: 500, yStart: 500 }),
      'scroll'
    );
  });

  it('zooms both axes through the existing handle and clears old projection state on replacement', () => {
    const { result, rerender } = renderHook(
      ({ current }: { current: ContactProjection | null }) =>
        usePixiMap({
          genome: null,
          circular: false,
          width: 800,
          height: 500,
          contactProjection: current,
        }),
      { initialProps: { current: projection } }
    );
    act(() => result.current.handle.setZoom(4));
    expect(result.current.handle.getContactCamera()).toEqual({
      projectionId: projection.id,
      xStart: 375,
      xEnd: 625,
      yStart: 750,
      yEnd: 1_250,
    });
    expect(result.current.handle.getState()?.zoom).toBe(1);
    rerender({ current: { ...projection, id: 'replacement' } });
    expect(result.current.handle.getContactCamera()).toMatchObject({
      projectionId: 'replacement',
      xStart: 0,
      xEnd: 1_000,
      yStart: 0,
      yEnd: 2_000,
    });
    rerender({ current: null });
    expect(result.current.handle.getContactCamera()).toBeNull();
  });
});

// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { usePixiMap } from './use-pixi-map';

describe('Canvas viewport marker state', () => {
  it('updates visibility without clearing the tracked range or moving the camera', () => {
    const { result, rerender } = renderHook(
      ({ visible }: { visible: boolean | undefined }) =>
        usePixiMap({
          genome: null,
          circular: true,
          width: 800,
          height: 400,
          viewportIndicatorVisible: visible,
        }),
      { initialProps: { visible: undefined as boolean | undefined } }
    );
    expect(result.current.handle.getState()?.viewportIndicatorVisible).toBe(false);
    act(() => result.current.handle.setViewport(100, 300));
    const before = result.current.handle.getState()!;
    const camera = { zoom: before.zoom, viewOffset: before.viewOffset };
    for (const visible of [true, false, true]) {
      rerender({ visible });
      expect(result.current.handle.getState()).toMatchObject({
        ...camera,
        viewportRange: [100, 300],
        viewportIndicatorVisible: visible,
      });
    }
  });
});

// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { expect, it } from 'vitest';
import { usePixiMap } from './use-pixi-map';

it('applies the destination zoom with its geometry and keeps manual zoom during resizing', () => {
  const { result, rerender } = renderHook(
    ({ width, layoutZoom }) =>
      usePixiMap({ genome: null, circular: true, width, height: 400, layoutZoom }),
    { initialProps: { width: 800, layoutZoom: { key: 'stacked', zoom: 3 } } }
  );
  rerender({ width: 400, layoutZoom: { key: 'side', zoom: 2 } });
  expect(result.current.handle.getState()).toMatchObject({ width: 400, zoom: 2 });
  act(() => result.current.handle.setZoom(4));
  rerender({ width: 420, layoutZoom: { key: 'side', zoom: 2 } });
  expect(result.current.handle.getState()).toMatchObject({ width: 420, zoom: 4 });
  rerender({ width: 800, layoutZoom: { key: 'stacked', zoom: 3 } });
  expect(result.current.handle.getState()).toMatchObject({ width: 800, zoom: 3 });
});

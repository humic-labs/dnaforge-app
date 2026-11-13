/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SequenceScrollbar1D } from '../SequenceScrollbar1D';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('resizes the thumb without feeding an older scroll pose back into the viewer', () => {
  let width = 800;
  const callbacks: Array<() => void> = [];
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        callbacks.push(callback);
      }
      observe() {}
      disconnect() {}
    }
  );
  const onScrollChange = vi.fn();
  const props = { totalWidth: 2000, viewportWidth: 400, scrollLeft: 100, onScrollChange };
  const view = render(<SequenceScrollbar1D {...props} />);
  view.rerender(<SequenceScrollbar1D {...props} scrollLeft={140} />);
  width = 500;
  act(() => {
    for (const notify of callbacks) notify();
  });
  expect(onScrollChange).not.toHaveBeenCalled();
  const thumb = view.getByTestId('sequence-scrollbar-1d-thumb');
  expect(thumb.style.width).toBe('100px');
  expect(thumb.style.left).toBe('35px');
  fireEvent.pointerDown(view.getByTestId('sequence-scrollbar-1d'), { clientX: 480 });
  expect(onScrollChange).toHaveBeenCalledExactlyOnceWith(540);
});

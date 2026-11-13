/** @vitest-environment jsdom */
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SequenceViewer } from '../SequenceViewer';
import {
  installRecordingCanvas,
  uninstallRecordingCanvas,
} from '../testing/recording-canvas-context';

const tiny = {
  id: 'short-zoom-boundary',
  name: 'short-zoom-boundary',
  sequence: 'ACGT'.repeat(30),
  length: 120,
  annotations: [],
};

class MeasuredResizeObserver implements ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element) {
    const size = { inlineSize: 800, blockSize: 600 };
    this.callback(
      [
        {
          target,
          contentRect: new DOMRectReadOnly(0, 0, 800, 600),
          borderBoxSize: [size],
          contentBoxSize: [size],
          devicePixelContentBoxSize: [size],
        },
      ],
      this
    );
  }
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  installRecordingCanvas();
  vi.stubGlobal('ResizeObserver', MeasuredResizeObserver);
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(0, 0, 800, 600)
  );
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value(this: HTMLElement, options: ScrollToOptions) {
      this.scrollTop = options.top ?? 0;
    },
  });
});

afterEach(() => {
  cleanup();
  uninstallRecordingCanvas();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTo;
});

describe('wrapped fit boundary during zoom-dependent metric changes', () => {
  it('retains its minimum when zooming in changes glyph sizes and visible detail tracks', () => {
    const onMinZoomChange = vi.fn();
    const sequence = { ...tiny, circular: true };
    const view = (zoom: number) => (
      <SequenceViewer
        sequence={sequence}
        zoomLevel={zoom}
        onMinZoomChange={onMinZoomChange}
        config={{
          charWidth: (8 * zoom) / 100,
          rowHeight: (20 * zoom) / 100,
          fontSize: (11 * zoom) / 100,
          showReverseComplement: zoom > 30,
          showPrimers: zoom > 30,
          showResidueNumbers: zoom > 30,
        }}
      />
    );
    const { rerender } = render(view(20));
    expect(onMinZoomChange).toHaveBeenLastCalledWith(20);
    rerender(view(40));
    expect(onMinZoomChange).toHaveBeenLastCalledWith(20);
    rerender(view(20));
    expect(onMinZoomChange).toHaveBeenLastCalledWith(20);
  });
});

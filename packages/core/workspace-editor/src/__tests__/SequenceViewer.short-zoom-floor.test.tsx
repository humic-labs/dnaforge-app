/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
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

describe('short wrapped sequence zoom boundary', () => {
  it.each([false, true])(
    'does not automatically zoom in an already-fitting sequence (circular=%s)',
    (circular) => {
      const onZoomLevelChange = vi.fn();
      render(
        <SequenceViewer
          sequence={{ ...tiny, circular }}
          zoomLevel={20}
          onZoomLevelChange={onZoomLevelChange}
        />
      );
      expect(onZoomLevelChange).not.toHaveBeenCalled();
    }
  );

  it('stops repeated zoom-out requests at one boundary without ratcheting upward', () => {
    const reported: number[] = [];
    const sequence = { ...tiny, circular: true };
    function Controlled() {
      const [zoom, setZoom] = useState(20);
      return (
        <>
          <output data-testid="current-zoom">{zoom}</output>
          <button onClick={() => setZoom((current) => current / 2)}>Zoom out request</button>
          <SequenceViewer
            sequence={sequence}
            zoomLevel={zoom}
            onZoomLevelChange={(next) => {
              reported.push(next);
              setZoom(next);
            }}
          />
        </>
      );
    }
    render(<Controlled />);
    expect(screen.getByTestId('current-zoom').textContent).toBe('20');
    for (let attempt = 0; attempt < 5; attempt++) {
      fireEvent.click(screen.getByRole('button', { name: 'Zoom out request' }));
      expect(screen.getByTestId('current-zoom').textContent).toBe('20');
    }
    expect(reported.every((zoom) => zoom <= 20)).toBe(true);
  });
});

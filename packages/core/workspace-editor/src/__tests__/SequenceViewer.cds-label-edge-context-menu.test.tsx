/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SequenceViewer } from '../SequenceViewer';
import {
  installRecordingCanvas,
  uninstallRecordingCanvas,
} from '../testing/recording-canvas-context';

const sequence = {
  id: 'cds-label-edge',
  name: 'cds-label-edge',
  sequence: `${'ATGGCCGAC'.repeat(33)}TAA`,
  length: 300,
  circular: false,
  annotations: [{ name: 'M744_RS09680', type: 'CDS', start: 1, end: 300, direction: 1 as const }],
};

beforeEach(() => {
  installRecordingCanvas();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        this.callback(
          [{ target, contentRect: { width: 1024, height: 350 } } as ResizeObserverEntry],
          this as unknown as ResizeObserver
        );
      }
      unobserve() {}
      disconnect() {}
    }
  );
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1024);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(350);
  vi.stubGlobal('__enableDiag', true);
});

afterEach(() => {
  cleanup();
  uninstallRecordingCanvas();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('opens the CDS context menu at every sub-pixel point the viewer reports as that CDS', async () => {
  const onContextMenu = vi.fn();
  const { container } = render(
    <SequenceViewer sequence={sequence} onContextMenu={onContextMenu} />
  );
  const canvas = await waitFor(() => {
    const found = container.querySelector<HTMLCanvasElement>(
      'canvas[data-testid="sequence-canvas-interactive"]'
    );
    if (!found) throw new Error('interactive canvas missing');
    return found;
  });
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(338, 113.75, 1024, 350));
  const viewer = (window as any).__sequenceViewerDiagnostics;
  await waitFor(() => expect(viewer.hitTargetAt(742, 160)).not.toBeNull());

  const reported: Array<[number, number]> = [];
  for (let y = 113.75; y < 113.75 + 200; y += 0.25) {
    for (let x = 400; x < 1300; x += 37) {
      const hit = viewer.hitTargetAt(x, y);
      if (hit?.type === 'annotation' && hit.annotation?.type === 'CDS') reported.push([x, y]);
    }
  }
  expect(reported.length).toBeGreaterThan(0);

  const missed = reported.filter(([x, y]) => {
    onContextMenu.mockClear();
    fireEvent.contextMenu(canvas, { clientX: Math.floor(x), clientY: Math.floor(y), button: 2 });
    return onContextMenu.mock.calls[0]?.[2]?.annotation?.type !== 'CDS';
  });
  expect(missed.slice(0, 5)).toEqual([]);
});

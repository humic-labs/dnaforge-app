/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createElement, useMemo, useRef, useState } from 'react';
import { DEFAULT_EDITOR_CONFIG, type WorkspaceEditorHandle } from '../types';
import { findORFs } from '@waypoint/sequence-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SequenceViewer } from '../SequenceViewer';
import {
  installRecordingCanvas,
  uninstallRecordingCanvas,
} from '../testing/recording-canvas-context';

const canvasHooks = vi.hoisted(() => ({ anchor: null as ((bp: number) => void) | null }));
vi.mock('../rendering/webgl-drawing-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../rendering/webgl-drawing-context')>()),
  getSequenceWebGLContext: (canvas: HTMLCanvasElement) =>
    Object.assign(canvas.getContext('2d')!, {
      beginFrame: () => true,
      endFrame: () => undefined,
      setPresentationShiftBounds: () => undefined,
    }),
}));
vi.mock('../SequenceCanvas', async (importOriginal) => {
  const original = await importOriginal<typeof import('../SequenceCanvas')>();
  return {
    ...original,
    SequenceCanvas: (props: React.ComponentProps<typeof original.SequenceCanvas>) => {
      canvasHooks.anchor = props.onCdsExtensionAnchor ?? null;
      return createElement(original.SequenceCanvas, props);
    },
  };
});

beforeEach(() => {
  installRecordingCanvas();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        this.callback(
          [{ target, contentRect: { width: 800, height: 600 } } as ResizeObserverEntry],
          this as unknown as ResizeObserver
        );
      }
      unobserve() {}
      disconnect() {}
    }
  );
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(20000);
});

afterEach(() => {
  cleanup();
  uninstallRecordingCanvas();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('presents an accepted empty ORF model on the real Canvas path', async () => {
  const onOrfsPresented = vi.fn();
  render(
    <SequenceViewer
      sequence={{
        id: 'accepted-empty-orf-model',
        name: 'accepted-empty-orf-model',
        sequence: 'ATGAAATAA',
        length: 9,
        circular: false,
        annotations: [],
      }}
      config={{ charsPerLine: 100 }}
      orfs={[]}
      onOrfsPresented={onOrfsPresented}
    />
  );
  await waitFor(() =>
    expect(onOrfsPresented).toHaveBeenCalledWith({
      surface: 'sequence_canvas',
      kind: 'empty_model',
    })
  );
});

it('keeps a short ORF model presented across controlled fractional zoom replacement', async () => {
  vi.stubGlobal('__enableDiag', true);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(942);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(732);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(0, 0, 942, 732)
  );
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    const content = this.firstElementChild?.firstElementChild as HTMLElement | null;
    return Math.max(this.clientHeight, Math.round(Number.parseFloat(content?.style.height || '0')));
  });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        this.callback(
          [{ target, contentRect: { width: 942, height: 732 } } as ResizeObserverEntry],
          this as unknown as ResizeObserver
        );
      }
      unobserve() {}
      disconnect() {}
    }
  );
  const bases = 'atg'.repeat(40) + 'taa';
  const sequence = {
    id: 'orf-fractional-zoom',
    name: 'orf-fractional-zoom',
    sequence: bases,
    length: bases.length,
    circular: false,
    annotations: [],
  };
  const orfs = findORFs(bases, 100, { geneticCode: 1 });
  expect(orfs).toHaveLength(1);
  const onOrfsPresented = vi.fn();
  function ControlledViewer() {
    const [zoom, setZoom] = useState(100);
    const viewer = useRef<WorkspaceEditorHandle>(null);
    const config = useMemo(
      () => ({
        charsPerLine: 0,
        charWidth: (DEFAULT_EDITOR_CONFIG.charWidth * zoom) / 100,
        fontSize: (DEFAULT_EDITOR_CONFIG.fontSize * zoom) / 100,
        rowHeight: (DEFAULT_EDITOR_CONFIG.rowHeight * zoom) / 100,
      }),
      [zoom]
    );
    return (
      <>
        <button onClick={() => expect(viewer.current?.zoomTo?.(99.8)).toBe(true)}>Zoom out</button>
        <button onClick={() => expect(viewer.current?.zoomTo?.(100)).toBe(true)}>
          Restore zoom
        </button>
        <output data-testid="zoom-level">{zoom}</output>
        <SequenceViewer
          ref={viewer}
          sequence={sequence}
          config={config}
          orfs={orfs}
          onOrfsPresented={onOrfsPresented}
          zoomLevel={zoom}
          onZoomLevelChange={setZoom}
        />
      </>
    );
  }
  const view = render(<ControlledViewer />);
  await waitFor(() => expect(onOrfsPresented).toHaveBeenCalled());
  const beforeZoom = onOrfsPresented.mock.calls.length;
  fireEvent.click(view.getByRole('button', { name: 'Zoom out' }));
  await waitFor(() => expect(view.getByTestId('zoom-level').textContent).toBe('99.8'));
  fireEvent.click(view.getByRole('button', { name: 'Restore zoom' }));
  await waitFor(() => {
    expect(view.getByTestId('zoom-level').textContent).toBe('100');
    expect(onOrfsPresented.mock.calls.length).toBeGreaterThan(beforeZoom);
    expect(view.getByTestId('sequence-canvas-main').tagName).toBe('CANVAS');
    expect(view.queryByTestId('sequence-render-error')).toBeNull();
  });
});

it('publishes a changed viewport center while the visible boundary rows stay the same', async () => {
  const onViewportChange = vi.fn();
  const { container } = render(
    <SequenceViewer
      sequence={{
        id: 'viewport-publication',
        name: 'viewport-publication',
        sequence: 'ACGT'.repeat(1000),
        length: 4000,
        circular: false,
        annotations: [],
      }}
      config={{ charsPerLine: 100 }}
      onViewportChange={onViewportChange}
    />
  );
  await waitFor(() => expect(onViewportChange).toHaveBeenCalled());
  const scroll = container.querySelector<HTMLElement>('[data-testid="sequence-scroll-container"]')!;
  onViewportChange.mockClear();

  scroll.scrollTop = 1000.8;
  fireEvent.scroll(scroll);
  expect(onViewportChange).toHaveBeenCalledTimes(1);
  const first = onViewportChange.mock.calls[0][0];
  expect(first.centerColumn).toEqual(expect.any(Number));

  scroll.scrollTop = 1000.9;
  fireEvent.scroll(scroll);
  expect(onViewportChange, 'pane handoff consumers need the current center').toHaveBeenCalledTimes(
    2
  );
  const second = onViewportChange.mock.calls[1][0];
  expect({ start: second.start, end: second.end, wraps: second.wraps }).toEqual({
    start: first.start,
    end: first.end,
    wraps: first.wraps,
  });
  expect(second.centerColumn).not.toBe(first.centerColumn);
});

it('prepares the actual DOM viewport after a layout settle without waiting for a scroll event', async () => {
  vi.stubGlobal('__enableDiag', true);
  const sequence = {
    id: 'viewport-settle',
    name: 'viewport-settle',
    sequence: 'ACGT'.repeat(50_000),
    length: 200_000,
    circular: false,
    annotations: [],
  };
  const { container, rerender } = render(
    <SequenceViewer sequence={sequence} config={{ charsPerLine: 100 }} />
  );
  const scroll = container.querySelector<HTMLElement>('[data-testid="sequence-scroll-container"]')!;
  scroll.scrollTop = 5000;
  rerender(
    <SequenceViewer sequence={sequence} config={{ charsPerLine: 100, showPrimers: false }} />
  );
  await waitFor(() => {
    const geometry = (window as any).__sequenceViewerDiagnostics.layoutGeometry();
    const prepared = new Set(geometry.rows.map((row: any) => row.lineIndex));
    const missing = Array.from(geometry.summary.rowHeights as ArrayLike<number>).flatMap(
      (height, index) => {
        const top = geometry.summary.rowYOffsets[index];
        return top < scroll.scrollTop + scroll.clientHeight &&
          top + height > scroll.scrollTop &&
          !prepared.has(index)
          ? [index]
          : [];
      }
    );
    expect(missing, 'every row in the physical viewport must be prepared').toEqual([]);
    expect(geometry.rows.length).toBeGreaterThan(0);
  });
});

it('a CDS preview row anchor owns restoration instead of a second generic center restore', async () => {
  vi.stubGlobal('__enableDiag', true);
  const sequence = {
    id: 'cds-preview-anchor',
    name: 'cds-preview-anchor',
    sequence: 'CCC'.repeat(300),
    length: 900,
    circular: true,
    annotations: [{ name: 'extension', type: 'CDS', start: 400, end: 900, strand: 1 as const }],
  };
  const config = { charsPerLine: 30 };
  const { container, rerender } = render(<SequenceViewer sequence={sequence} config={config} />);
  const geometry = () => (window as any).__sequenceViewerDiagnostics.layoutGeometry();
  const scroll = container.querySelector<HTMLElement>('[data-testid="sequence-scroll-container"]')!;
  await waitFor(() => expect(geometry().rows.length).toBeGreaterThan(0));
  const row = geometry().rows.find(
    (candidate: any) =>
      candidate.startPos <= 899 && (candidate.endPos > 899 || candidate.endPos < candidate.startPos)
  );
  expect(row).toBeTruthy();
  scroll.scrollTop = row.y - 260;
  fireEvent.scroll(scroll);
  const before = geometry().rows.find((candidate: any) => candidate.lineIndex === row.lineIndex);
  const screenY = before.y - scroll.scrollTop;
  canvasHooks.anchor!(899);
  rerender(
    <SequenceViewer
      sequence={{ ...sequence, annotations: [{ ...sequence.annotations[0], end: 303 }] }}
      config={config}
    />
  );
  await waitFor(() => {
    const after = geometry().rows.find((candidate: any) => candidate.lineIndex === row.lineIndex);
    expect(after.y - scroll.scrollTop).toBeCloseTo(screenY, 0);
  });
});

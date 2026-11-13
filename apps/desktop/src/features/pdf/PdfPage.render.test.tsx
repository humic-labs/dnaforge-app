import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createRef, type ComponentProps } from 'react';
import { PdfPage } from './PdfPage';
import { resetPdfTestControls } from './pdf-test-controls';

const state = vi.hoisted(() => ({
  layers: [] as Array<{ container: HTMLElement; cancelled: boolean }>,
  tasks: [] as Array<{ cancel: () => void }>,
  renderLayer: null as null | (() => Promise<void>),
}));
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  TextLayer: class {
    private layer: { container: HTMLElement; cancelled: boolean };
    constructor(options: {
      container: HTMLElement;
      textContentSource: { items: Array<{ str: string }> };
    }) {
      this.layer = { container: options.container, cancelled: false };
      state.layers.push(this.layer);
      options.container.textContent = options.textContentSource.items
        .map((item) => item.str)
        .join(' ');
    }
    render() {
      return state.renderLayer?.() ?? Promise.resolve();
    }
    cancel() {
      this.layer.cancelled = true;
    }
  },
}));
function deferred<T>() {
  let release!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolve, fail) => {
    release = resolve;
    reject = fail;
  });
  return { promise, release, reject };
}
type PageDocument = ComponentProps<typeof PdfPage>['document'];
type PageProxy = Awaited<ReturnType<PageDocument['getPage']>>;
function viewportFor(scale: number): ReturnType<PageProxy['getViewport']> {
  const unused = () => {
    throw new Error('Viewport operation is outside this controlled page fixture');
  };
  return {
    viewBox: [0, 0, 600, 800],
    userUnit: 1,
    scale,
    rotation: 0,
    offsetX: 0,
    offsetY: 0,
    transform: [scale, 0, 0, -scale, 0, 800 * scale],
    width: 600 * scale,
    height: 800 * scale,
    rawDims: { pageWidth: 600, pageHeight: 800, pageX: 0, pageY: 0 },
    clone: unused,
    convertToViewportPoint: unused,
    convertToPdfPoint: unused,
  };
}
function documentFor(
  getText: (page: number) => ReturnType<PageProxy['getTextContent']>,
  renderPage = () => Promise.resolve()
) {
  return {
    getPage: async (number: number) => ({
      getViewport: ({ scale }: { scale: number }) => viewportFor(scale),
      getTextContent: () => getText(number),
      render: () => {
        const task = {
          _internalRenderTask: null,
          onContinue: () => {},
          onError: () => {},
          promise: renderPage(),
          cancel: vi.fn(),
          separateAnnots: false,
          imageCoordinates: null,
        } satisfies RenderTask;
        state.tasks.push(task);
        return task;
      },
    }),
  } satisfies PageDocument;
}
const text = (str: string) => ({
  items: [
    {
      str,
      dir: 'ltr',
      transform: [1, 0, 0, 1, 0, 0],
      width: 600,
      height: 12,
      fontName: 'synthetic',
      hasEOL: false,
    },
  ],
  styles: {},
  lang: null,
});
beforeEach(() => {
  state.layers.length = 0;
  state.tasks.length = 0;
  state.renderLayer = null;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    {} as CanvasRenderingContext2D
  );
});
afterEach(() => {
  resetPdfTestControls();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function presentationSurface() {
  const viewportRef = createRef<HTMLElement>();
  const geometry = {
    viewportTop: 0,
    viewportWidth: 600,
    viewportHeight: 400,
    clipHeight: 768,
    targetTop: 650,
    targetWidth: 180,
    scrollWorks: true,
    documentVisible: true,
  };
  let nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id);
  });
  vi.spyOn(window.document, 'visibilityState', 'get').mockImplementation(() =>
    geometry.documentVisible ? 'visible' : 'hidden'
  );
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    const top = geometry.viewportTop;
    const scroll = viewportRef.current?.scrollTop ?? 0;
    if (this.dataset.testid === 'presentation-viewport')
      return new DOMRect(0, top, geometry.viewportWidth, geometry.viewportHeight);
    if (this.dataset.testid === 'presentation-clip')
      return new DOMRect(0, 0, 1024, geometry.clipHeight);
    if (this.dataset.testid === 'pdf-page') return new DOMRect(0, top - scroll, 600, 800);
    if (this.hasAttribute('data-pdf-evidence-anchor'))
      return new DOMRect(
        60,
        top + geometry.targetTop - (geometry.scrollWorks ? scroll : 0),
        geometry.targetWidth,
        40
      );
    return new DOMRect(0, 0, 1024, 768);
  });
  const element = (props: ComponentProps<typeof PdfPage>) => (
    <section data-testid="presentation-clip" style={{ overflow: 'hidden' }}>
      <main ref={viewportRef} data-testid="presentation-viewport">
        <PdfPage {...props} viewportRef={viewportRef} />
      </main>
    </section>
  );
  const advance = async (count: number) => {
    for (let index = 0; index < count; index += 1) {
      await act(async () => {
        const pending = Array.from(frames.values());
        frames.clear();
        pending.forEach((callback) => callback(performance.now()));
      });
    }
  };
  return { geometry, viewportRef, frames, element, advance };
}

const citationOverlay = {
  id: 'controlled-anchor',
  protocolPath: '/controlled/protocol',
  stepId: 'controlled-step',
  label: 'Step 1: Controlled target',
  rects: [{ x: 0.1, y: 0.8, width: 0.3, height: 0.05 }],
  selected: true,
  highlighted: false,
};

describe('PDF physical page and citation presentation', () => {
  it('keeps inactive readiness separate, reveals the exact anchor and acknowledges one visible arrival', async () => {
    const surface = presentationSurface();
    const report = vi.fn();
    const arrived = vi.fn();
    const props = {
      document: documentFor(async () => text('current page')),
      pageNumber: 1,
      scale: 1,
      generationId: 'current',
      overlays: [citationOverlay],
      isActive: false,
      onReport: report,
      citationTarget: { requestId: 'request', anchorId: 'controlled-anchor' },
      onCitationPresented: arrived,
    };
    const view = render(surface.element(props));
    await waitFor(() =>
      expect(screen.getByTestId('pdf-page')).toHaveAttribute('data-render-phase', 'paint_pending')
    );
    await surface.advance(6);
    expect(report).toHaveBeenCalledWith({
      generationId: 'current',
      phase: 'ready',
      textAvailable: true,
    });
    expect(report.mock.calls.some(([value]) => value.phase === 'presented')).toBe(false);
    expect(arrived).not.toHaveBeenCalled();
    expect(surface.viewportRef.current?.scrollTop).toBe(0);

    view.rerender(surface.element({ ...props, isActive: true }));
    await surface.advance(2);
    expect(surface.viewportRef.current?.scrollTop).toBeGreaterThan(0);
    expect(arrived).not.toHaveBeenCalled();
    await surface.advance(2);
    expect(arrived.mock.calls).toEqual([['current', 'request', 'controlled-anchor']]);
    fireEvent.scroll(surface.viewportRef.current!);
    await surface.advance(4);
    expect(arrived).toHaveBeenCalledTimes(1);
    expect(report.mock.calls.filter(([value]) => value.phase === 'presented')).toEqual([
      [{ generationId: 'current', phase: 'presented' }],
    ]);
  });

  it.each([
    'hidden',
    'hidden-target',
    'document-hidden',
    'zero-viewport',
    'zero-target',
    'offscreen-viewport',
    'clipped-ancestor',
    'unrevealed-target',
  ] as const)(
    'withholds arrival for %s and accepts the same request only after actual visibility',
    async (condition) => {
      const surface = presentationSurface();
      const arrived = vi.fn();
      const report = vi.fn();
      if (condition === 'document-hidden') surface.geometry.documentVisible = false;
      if (condition === 'zero-viewport') surface.geometry.viewportWidth = 0;
      if (condition === 'zero-target') surface.geometry.targetWidth = 0;
      if (condition === 'offscreen-viewport') surface.geometry.viewportTop = 2000;
      if (condition === 'clipped-ancestor') surface.geometry.clipHeight = 0;
      if (condition === 'unrevealed-target') surface.geometry.scrollWorks = false;
      render(
        surface.element({
          document: documentFor(async () => text('current')),
          pageNumber: 1,
          scale: 1,
          generationId: 'current',
          overlays: [citationOverlay],
          onReport: report,
          citationTarget: { requestId: 'request', anchorId: 'controlled-anchor' },
          onCitationPresented: arrived,
        })
      );
      if (condition === 'hidden') surface.viewportRef.current!.hidden = true;
      await waitFor(() =>
        expect(screen.getByTestId('pdf-page')).toHaveAttribute('data-render-phase', 'paint_pending')
      );
      await surface.advance(2);
      const target = screen
        .getByTestId('pdf-page')
        .querySelector<HTMLButtonElement>('[data-pdf-evidence-anchor="controlled-anchor"]');
      expect(target).not.toBeNull();
      if (condition === 'hidden-target') target!.hidden = true;
      await surface.advance(4);
      expect(screen.getByTestId('pdf-page')).toHaveAttribute('data-render-phase', 'ready');
      expect(arrived).not.toHaveBeenCalled();
      expect(report.mock.calls.some(([value]) => value.phase === 'presented')).toBe(
        ['hidden-target', 'zero-target', 'unrevealed-target'].includes(condition)
      );
      surface.viewportRef.current!.hidden = false;
      target!.hidden = false;
      Object.assign(surface.geometry, {
        viewportTop: 0,
        viewportWidth: 600,
        targetWidth: 180,
        clipHeight: 768,
        scrollWorks: true,
        documentVisible: true,
      });
      fireEvent(window, new Event('resize'));
      await surface.advance(6);
      expect(arrived.mock.calls).toEqual([['current', 'request', 'controlled-anchor']]);
      expect(report.mock.calls.filter(([value]) => value.phase === 'presented')).toHaveLength(1);
    }
  );

  it('rechecks visibility after reveal instead of accepting a scroll assignment', async () => {
    const surface = presentationSurface();
    const arrived = vi.fn();
    render(
      surface.element({
        document: documentFor(async () => text('current')),
        pageNumber: 1,
        scale: 1,
        generationId: 'current',
        overlays: [citationOverlay],
        citationTarget: { requestId: 'request', anchorId: 'controlled-anchor' },
        onCitationPresented: arrived,
      })
    );
    await waitFor(() =>
      expect(screen.getByTestId('pdf-page')).toHaveAttribute('data-render-phase', 'paint_pending')
    );
    await surface.advance(4);
    expect(surface.viewportRef.current?.scrollTop).toBeGreaterThan(0);
    expect(arrived).not.toHaveBeenCalled();
    surface.viewportRef.current!.hidden = true;
    await surface.advance(2);
    expect(arrived).not.toHaveBeenCalled();
    surface.viewportRef.current!.hidden = false;
    fireEvent.scroll(surface.viewportRef.current!);
    await surface.advance(2);
    expect(arrived).toHaveBeenCalledTimes(1);
  });

  it('reveals into the visible part of a clipped viewport instead of its offscreen center', async () => {
    const surface = presentationSurface();
    const arrived = vi.fn();
    surface.geometry.viewportTop = 700;
    surface.geometry.targetTop = 100;
    render(
      surface.element({
        document: documentFor(async () => text('current')),
        pageNumber: 1,
        scale: 1,
        generationId: 'current',
        overlays: [citationOverlay],
        citationTarget: { requestId: 'request', anchorId: 'controlled-anchor' },
        onCitationPresented: arrived,
      })
    );
    await waitFor(() =>
      expect(screen.getByTestId('pdf-page')).toHaveAttribute('data-render-phase', 'paint_pending')
    );
    await surface.advance(6);
    const rect = screen
      .getByRole('button', { name: 'Step 1: Controlled target' })
      .getBoundingClientRect();
    expect(surface.viewportRef.current?.scrollTop).toBeGreaterThan(0);
    expect(rect.top).toBeGreaterThanOrEqual(700);
    expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight);
    expect(arrived.mock.calls).toEqual([['current', 'request', 'controlled-anchor']]);
  });

  it.each(['page', 'zoom', 'anchor', 'inactive', 'unmount'] as const)(
    'retires a queued old acknowledgement on %s',
    async (change) => {
      const surface = presentationSurface();
      const arrived = vi.fn();
      const props = {
        document: documentFor(async () => text('current')),
        pageNumber: 1,
        scale: 1,
        generationId: 'old',
        overlays: [citationOverlay],
        isActive: true,
        citationTarget: { requestId: 'old-request', anchorId: 'controlled-anchor' },
        onCitationPresented: arrived,
      };
      const view = render(surface.element(props));
      await waitFor(() =>
        expect(screen.getByTestId('pdf-page')).toHaveAttribute('data-render-phase', 'paint_pending')
      );
      await surface.advance(3);
      const late = Array.from(surface.frames.values());
      expect(late.length).toBeGreaterThan(0);
      if (change === 'unmount') view.unmount();
      else
        view.rerender(
          surface.element({
            ...props,
            generationId: change === 'page' || change === 'zoom' ? 'new' : 'old',
            pageNumber: change === 'page' ? 2 : 1,
            scale: change === 'zoom' ? 1.2 : 1,
            isActive: change !== 'inactive',
            overlays:
              change === 'anchor' ? [{ ...citationOverlay, id: 'new-anchor' }] : props.overlays,
            citationTarget:
              change === 'anchor'
                ? { requestId: 'new-request', anchorId: 'new-anchor' }
                : props.citationTarget,
          })
        );
      await act(async () => {
        late.forEach((callback) => callback(performance.now()));
      });
      expect(arrived).not.toHaveBeenCalled();
      if (change === 'anchor') {
        await surface.advance(6);
        expect(arrived.mock.calls).toEqual([['old', 'new-request', 'new-anchor']]);
      }
      if (change === 'inactive' || change === 'unmount') expect(surface.frames.size).toBe(0);
    }
  );
});

describe('PDF render generation ownership', () => {
  it('cannot create a stale text layer after old getTextContent resolves behind a newer page', async () => {
    const old = deferred<ReturnType<typeof text>>();
    const getText = vi.fn((page: number) =>
      page === 1 ? old.promise : Promise.resolve(text('harmless current page'))
    );
    const document = documentFor(getText);
    const view = render(
      <PdfPage document={document} pageNumber={1} scale={1} generationId="old" />
    );
    await waitFor(() => expect(getText).toHaveBeenCalledWith(1));
    const oldCanvas = screen.getByTestId('pdf-page-canvas');
    view.rerender(<PdfPage document={document} pageNumber={2} scale={1} generationId="current" />);
    await waitFor(() =>
      expect(screen.getByTestId('pdf-page')).toHaveAttribute('data-render-phase', 'ready')
    );
    expect(screen.getByTestId('pdf-page-canvas')).not.toBe(oldCanvas);
    await act(async () => {
      old.release(text('harmless obsolete page'));
      await old.promise;
    });
    expect(state.layers).toHaveLength(1);
    expect(screen.queryByText('harmless obsolete page')).not.toBeInTheDocument();
    expect(screen.getByText('harmless current page')).toBeInTheDocument();
  });
  it('keeps evidence controls unavailable until matching canvas and text complete', async () => {
    const canvas = deferred<void>();
    const document = documentFor(
      async () => text('harmless current page'),
      () => canvas.promise
    );
    render(
      <PdfPage
        document={document}
        pageNumber={1}
        scale={1}
        generationId="current"
        overlays={[
          {
            id: 'anchor',
            protocolPath: '/controlled/protocol',
            stepId: 'step',
            label: 'Controlled evidence',
            rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.1 }],
            selected: false,
            highlighted: false,
          },
        ]}
      />
    );
    expect(screen.queryByRole('button', { name: 'Controlled evidence' })).not.toBeInTheDocument();
    await act(async () => {
      canvas.release();
    });
    const control = await screen.findByRole('button', { name: 'Controlled evidence' });
    expect(control).toHaveStyle({ left: '10%', top: '20%', width: '30%', height: '10%' });
    expect(screen.getByTestId('pdf-page-canvas')).toHaveAttribute('width', '600');
  });
  it('exposes a real retry after a canvas failure without enabling evidence', async () => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);
    const retry = vi.fn();
    const report = vi.fn();
    render(
      <PdfPage
        document={documentFor(async () => text('harmless'))}
        pageNumber={1}
        scale={1}
        generationId="failed"
        onRetry={retry}
        onReport={report}
      />
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Retry page' }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith({
      generationId: 'failed',
      phase: 'failed',
      failure: 'canvas',
    });
    expect(screen.getByTestId('pdf-page-canvas')).toHaveStyle({ visibility: 'hidden' });
  });
  it('reports an empty text capability after a real canvas completion instead of a parser failure', async () => {
    const report = vi.fn();
    render(
      <PdfPage
        document={documentFor(async () => ({ items: [], styles: {}, lang: null }))}
        pageNumber={1}
        scale={1}
        generationId="empty"
        onReport={report}
      />
    );
    await waitFor(() =>
      expect(report).toHaveBeenCalledWith({
        generationId: 'empty',
        phase: 'ready',
        textAvailable: false,
      })
    );
    expect(screen.queryByTestId('pdf-page-error')).not.toBeInTheDocument();
  });

  it('does not start rendering a page acquired after its document was replaced', async () => {
    const acquired = deferred<PageProxy>();
    const oldGetPage = vi.fn(() => acquired.promise);
    const oldRender = vi.fn<PageProxy['render']>();
    const oldText = vi.fn<PageProxy['getTextContent']>();
    const oldViewport = vi.fn<PageProxy['getViewport']>();
    const report = vi.fn();
    const view = render(
      <PdfPage
        document={{ getPage: oldGetPage } satisfies PageDocument}
        pageNumber={1}
        scale={1}
        generationId="old-document"
        onReport={report}
      />
    );
    await waitFor(() => expect(oldGetPage).toHaveBeenCalledWith(1));

    view.rerender(
      <PdfPage
        document={documentFor(async () => text('current document'))}
        pageNumber={1}
        scale={1}
        generationId="new-document"
        onReport={report}
      />
    );
    await waitFor(() =>
      expect(screen.getByTestId('pdf-page')).toHaveAttribute('data-render-phase', 'ready')
    );
    await act(async () => {
      acquired.release({ getViewport: oldViewport, render: oldRender, getTextContent: oldText });
      await acquired.promise;
    });

    expect(oldViewport).not.toHaveBeenCalled();
    expect(oldRender).not.toHaveBeenCalled();
    expect(oldText).not.toHaveBeenCalled();
    expect(screen.getByText('current document')).toBeInTheDocument();
    expect(report.mock.calls.every(([result]) => result.generationId === 'new-document')).toBe(
      true
    );
  });

  it('cancels old page and scale tasks and ignores their late canvas completions', async () => {
    const firstCanvas = deferred<void>();
    const secondCanvas = deferred<void>();
    const pending = [firstCanvas.promise, secondCanvas.promise];
    const getText = vi.fn(async (page: number) => text(`current page ${page}`));
    const document = documentFor(getText, () => pending.shift() ?? Promise.resolve());
    const report = vi.fn();
    const view = render(
      <PdfPage
        document={document}
        pageNumber={1}
        scale={1}
        generationId="old-page"
        onReport={report}
      />
    );
    await waitFor(() => expect(state.tasks).toHaveLength(1));
    view.rerender(
      <PdfPage
        document={document}
        pageNumber={2}
        scale={1}
        generationId="old-scale"
        onReport={report}
      />
    );
    await waitFor(() => expect(state.tasks).toHaveLength(2));
    view.rerender(
      <PdfPage
        document={document}
        pageNumber={2}
        scale={1.4}
        generationId="current-scale"
        onReport={report}
      />
    );
    await waitFor(() =>
      expect(screen.getByTestId('pdf-page')).toHaveAttribute('data-render-phase', 'ready')
    );
    await act(async () => {
      firstCanvas.release();
      secondCanvas.release();
      await Promise.all([firstCanvas.promise, secondCanvas.promise]);
    });

    expect(state.tasks[0].cancel).toHaveBeenCalledTimes(1);
    expect(state.tasks[1].cancel).toHaveBeenCalledTimes(1);
    expect(getText.mock.calls).toEqual([[2]]);
    expect(state.layers).toHaveLength(1);
    expect(screen.getByTestId('pdf-page-canvas')).toHaveAttribute('width', '840');
    expect(screen.getByText('current page 2')).toBeInTheDocument();
    expect(report.mock.calls.every(([result]) => result.generationId === 'current-scale')).toBe(
      true
    );
  });

  it.each(['resolve', 'reject'] as const)(
    'ignores a text acquisition that will %s after unmount',
    async (completion) => {
      const content = deferred<ReturnType<typeof text>>();
      const getText = vi.fn(() => content.promise);
      const report = vi.fn();
      const view = render(
        <PdfPage
          document={documentFor(getText)}
          pageNumber={1}
          scale={1}
          generationId="closed"
          onReport={report}
        />
      );
      await waitFor(() => expect(getText).toHaveBeenCalledWith(1));
      const beforeCleanup = report.mock.calls.length;
      view.unmount();
      await act(async () => {
        if (completion === 'resolve') content.release(text('obsolete closed text'));
        else content.reject(new Error('obsolete closed text failure'));
        await content.promise.catch(() => undefined);
      });

      expect(state.layers).toHaveLength(0);
      expect(state.tasks[0].cancel).toHaveBeenCalledTimes(1);
      expect(report).toHaveBeenCalledTimes(beforeCleanup);
      expect(screen.queryByText('obsolete closed text')).not.toBeInTheDocument();
    }
  );

  it('cancels and detaches an owned text layer whose rendering outlives cleanup', async () => {
    const oldLayer = deferred<void>();
    let layerCalls = 0;
    state.renderLayer = () => (layerCalls++ === 0 ? oldLayer.promise : Promise.resolve());
    const document = documentFor(async (page) => text(`page ${page} text`));
    const report = vi.fn();
    const view = render(
      <PdfPage
        document={document}
        pageNumber={1}
        scale={1}
        generationId="old-layer"
        onReport={report}
      />
    );
    await waitFor(() => expect(state.layers).toHaveLength(1));
    const oldContainer = state.layers[0].container;
    view.rerender(
      <PdfPage
        document={document}
        pageNumber={2}
        scale={1}
        generationId="current-layer"
        onReport={report}
      />
    );
    await waitFor(() =>
      expect(screen.getByTestId('pdf-page')).toHaveAttribute('data-render-phase', 'ready')
    );
    await act(async () => {
      oldLayer.release();
      await oldLayer.promise;
    });

    expect(state.layers[0].cancelled).toBe(true);
    expect(oldContainer.isConnected).toBe(false);
    expect(screen.queryByText('page 1 text')).not.toBeInTheDocument();
    expect(screen.getByText('page 2 text')).toBeInTheDocument();
    expect(
      report.mock.calls
        .filter(([result]) => result.phase === 'ready')
        .map(([result]) => result.generationId)
    ).toEqual(['current-layer']);
  });
});

import { webcrypto } from 'node:crypto';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ renderedPages: [] as number[] }));

vi.mock('./telemetry', () => ({
  claimPdfRead: () => ({ emit: () => true, cancel: () => {} }),
  subscribePdfRead: () => () => {},
}));
vi.mock('../../platform', () => ({
  platform: () => ({
    on: () => () => {},
    fs: {
      readFile: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      watchFile: async () => undefined,
      unwatchFile: async () => undefined,
    },
  }),
}));
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: { workerPort: null },
  PDFWorker: { create: () => ({ destroy: vi.fn() }) },
  TextLayer: class {
    cancel() {}
    async render() {}
  },
  getDocument: () => ({
    destroy: async () => {},
    promise: Promise.resolve({
      numPages: 40,
      getPage: async (pageNumber: number) => ({
        getTextContent: async () => ({ items: [], styles: {}, lang: null }),
        getViewport: ({ scale }: { scale: number }) => ({
          height: 800 * scale,
          width: 600 * scale,
        }),
        render: () => {
          state.renderedPages.push(pageNumber);
          return { cancel() {}, promise: Promise.resolve() };
        },
      }),
    }),
  }),
}));
vi.mock('pdfjs-dist/legacy/build/pdf.worker.min.mjs?worker&inline', () => ({
  default: class extends EventTarget {
    terminate() {}
  },
}));

import { PdfTab } from './PdfTab';
import { usePaperProtocolReviewStore } from '../paper-protocol-review/public/store';
import { CommandScopeProvider } from '../../commands';
import { useCanvasStore } from '../canvas/public/store';

beforeEach(() => {
  state.renderedPages.length = 0;
  vi.stubGlobal('crypto', webcrypto);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    {} as CanvasRenderingContext2D
  );
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return this.dataset.testid === 'pdf-viewport' ? 400 : 800;
  });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    const viewport = document.querySelector<HTMLElement>('[data-testid="pdf-viewport"]');
    if (this.dataset.testid === 'pdf-viewport') return new DOMRect(0, 0, 800, 400);
    const number = Number(this.dataset.pdfPage ?? this.dataset.pdfPageSlot ?? 1);
    return new DOMRect(0, (number - 1) * 824 - (viewport?.scrollTop ?? 0), 600, 800);
  });
  usePaperProtocolReviewStore.setState({
    protocols: {},
    pdfs: {},
    pdfInstances: {},
    selectedStep: null,
    hoveredStep: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('scrolls into the next PDF page without using the page navigation controls', async () => {
  render(<PdfTab filePath="/workspace/continuous.pdf" />);
  const viewport = await screen.findByTestId('pdf-viewport');
  await waitFor(() => expect(state.renderedPages).toContain(1));
  await act(async () => {
    viewport.scrollTop = 850;
    fireEvent.scroll(viewport);
  });
  await waitFor(() => expect(state.renderedPages).toContain(2));
  await waitFor(() => expect(screen.getByLabelText('Current PDF page')).toHaveValue(2));
  expect(screen.getAllByTestId('pdf-page-canvas').length).toBeLessThanOrEqual(5);
});

it('paints both adjacent PDF pages when the scroll viewport crosses their boundary', async () => {
  render(<PdfTab filePath="/workspace/continuous.pdf" />);
  const viewport = await screen.findByTestId('pdf-viewport');
  await waitFor(() => expect(state.renderedPages).toContain(1));
  await act(async () => {
    viewport.scrollTop = 650;
    fireEvent.scroll(viewport);
  });
  await waitFor(() => {
    const pages = screen.getAllByTestId('pdf-page');
    expect(pages.map((page) => page.dataset.pdfPage)).toEqual(expect.arrayContaining(['1', '2']));
    for (const page of pages) expect(page).toHaveAttribute('data-render-phase', 'ready');
  });
  expect(screen.getAllByTestId('pdf-page-canvas').length).toBeLessThanOrEqual(5);
});

it('zooms the focused PDF with standard keyboard shortcuts and resets to actual size', async () => {
  useCanvasStore.getState().reset();
  const tabId = useCanvasStore.getState().openTab('main', {
    type: 'pdf',
    entityId: '/workspace/continuous.pdf',
    label: 'continuous.pdf',
  });
  useCanvasStore.getState().focusPanel('main');
  render(
    <CommandScopeProvider>
      <PdfTab filePath="/workspace/continuous.pdf" tabId={tabId} />
    </CommandScopeProvider>
  );
  await screen.findByTestId('pdf-viewport');
  const modifier = /Mac|iPhone|iPad/.test(navigator.platform)
    ? { metaKey: true }
    : { ctrlKey: true };
  fireEvent.keyDown(window, { key: '=', code: 'Equal', ...modifier });
  expect(screen.getByText('120%')).toBeVisible();
  fireEvent.keyDown(window, { key: '+', code: 'Equal', shiftKey: true, ...modifier });
  expect(screen.getByText('140%')).toBeVisible();
  fireEvent.keyDown(window, { key: '+', code: 'NumpadAdd', ...modifier });
  expect(screen.getByText('160%')).toBeVisible();
  fireEvent.keyDown(window, { key: '-', code: 'Minus', ...modifier });
  expect(screen.getByText('140%')).toBeVisible();
  fireEvent.keyDown(window, { key: '0', code: 'Digit0', ...modifier });
  expect(screen.getByText('100%')).toBeVisible();
});

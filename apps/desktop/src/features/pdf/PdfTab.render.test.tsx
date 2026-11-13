import { createHash, webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  failPdfPhaseOnce,
  holdPdfPhase,
  releasePdfPhase,
  pdfPhaseEntered,
  resetPdfTestControls,
} from './pdf-test-controls';

const PDF_INPUT = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
const PDF_SHA = createHash('sha256').update(PDF_INPUT).digest('hex');

const state = vi.hoisted(() => ({
  getDocumentInputs: [] as unknown[],
  detachedInputs: [] as Uint8Array[],
  sourceBytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
  transferInput: false,
  pathnameHashReads: [] as string[],
  destroyCount: 0,
  workers: [] as Array<EventTarget & { terminate: ReturnType<typeof vi.fn> }>,
  pageNumbers: [] as number[],
  readPaths: [] as string[],
  renderCount: 0,
  readFailure: false,
  changed: null as null | ((...args: unknown[]) => void),
  textLayerRenderCount: 0,
  events: [] as Array<{ stage: string; generationId: string; citationId?: string }>,
}));

vi.mock('./telemetry', () => ({
  claimPdfRead: () => ({
    emit: (stage: string, generationId: string, _reason?: string, citationId?: string) => {
      state.events.push({ stage, generationId, citationId });
      return true;
    },
    cancel: () => {},
  }),
  subscribePdfRead: () => () => {},
}));

vi.mock('../../platform', () => ({
  platform: () => ({
    on: (_channel: string, listener: (...args: unknown[]) => void) => {
      state.changed = listener;
      return () => {
        state.changed = null;
      };
    },
    fs: {
      readFile: async (path: string) => {
        state.readPaths.push(path);
        if (state.readFailure) throw new Error('Controlled source failure');
        return new Uint8Array(state.sourceBytes);
      },
      sha256File: async (path: string) => {
        state.pathnameHashReads.push(path);
        return `sha256:${'a'.repeat(64)}`;
      },
      watchFile: async () => undefined,
      unwatchFile: async () => undefined,
    },
  }),
}));

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: { workerPort: null },
  PDFWorker: { create: ({ port }: { port: unknown }) => ({ port, destroy: vi.fn() }) },
  TextLayer: class {
    cancel() {}
    async render() {
      state.textLayerRenderCount += 1;
    }
  },
  getDocument: (input: { data: Uint8Array<ArrayBuffer> }) => {
    state.getDocumentInputs.push({ data: new Uint8Array(input.data) });
    if (state.transferInput) {
      state.detachedInputs.push(input.data);
      structuredClone(input.data, { transfer: [input.data.buffer] });
    }
    return {
      destroy: async () => {
        state.destroyCount += 1;
      },
      promise: Promise.resolve({
        numPages: 2,
        getPage: async (pageNumber: number) => {
          state.pageNumbers.push(pageNumber);
          return {
            getTextContent: async () => ({ items: [], styles: {}, lang: null }),
            getViewport: ({ scale }: { scale: number }) => ({
              height: 800 * scale,
              width: 600 * scale,
            }),
            render: () => {
              state.renderCount += 1;
              return { cancel() {}, promise: Promise.resolve() };
            },
          };
        },
      }),
    };
  },
}));

vi.mock('pdfjs-dist/legacy/build/pdf.worker.min.mjs?worker&inline', () => ({
  default: class PdfWorker extends EventTarget {
    terminate = vi.fn();
    constructor() {
      super();
      state.workers.push(this);
    }
  },
}));

import { PdfTab } from './PdfTab';
import {
  usePaperProtocolReviewStore,
  type ProtocolReviewRegistration,
} from '../paper-protocol-review/store';

const REVIEW_METADATA: Pick<
  ProtocolReviewRegistration,
  'candidate' | 'draftRevision' | 'draftState' | 'gapCount' | 'sourceKinds'
> = {
  candidate: {
    candidateSetId: 'controlled-candidate-set',
    candidateId: 'controlled-candidate',
    ordinal: 1,
    label: 'Controlled candidate',
    status: 'proposed',
  },
  draftRevision: 0,
  draftState: 'draft',
  gapCount: 0,
  sourceKinds: ['pdf'],
};

function registerControlledEvidence(page: number) {
  const target = {
    protocolPath: '/workspace/controlled.dnaforge-protocol.json',
    stepId: 'controlled-step',
  };
  usePaperProtocolReviewStore.getState().registerProtocol({
    ...REVIEW_METADATA,
    protocolPath: target.protocolPath,
    title: 'Controlled protocol',
    sources: [
      {
        sourceId: 'controlled-source',
        title: 'Controlled paper',
        workspacePath: 'paper.pdf',
        absolutePath: '/workspace/paper.pdf',
        sha256: PDF_SHA,
        pageCount: 2,
      },
    ],
    steps: [
      {
        id: target.stepId,
        ordinal: 1,
        title: 'Controlled step',
        anchors: [
          {
            anchorId: 'controlled-anchor',
            sourceId: 'controlled-source',
            page,
            quote: 'Harmless synthetic passage.',
            rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.1 }],
          },
        ],
      },
    ],
  });
  return target;
}

function measurePdfPresentation() {
  const geometry = { viewportWidth: 600 };
  vi.spyOn(window.document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    const viewport = window.document.querySelector<HTMLElement>('[data-testid="pdf-viewport"]');
    const scroll = viewport?.scrollTop ?? 0;
    if (this.dataset.testid === 'pdf-viewport')
      return new DOMRect(0, 0, geometry.viewportWidth, 400);
    if (this.dataset.testid === 'pdf-page') return new DOMRect(0, -scroll, 600, 800);
    if (this.hasAttribute('data-pdf-evidence-anchor'))
      return new DOMRect(60, 160 - scroll, 180, 80);
    return new DOMRect(0, 0, 1024, 768);
  });
  return geometry;
}

async function settlePresentationFrames() {
  for (let frame = 0; frame < 6; frame += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
  }
}

describe('PdfTab rendering', () => {
  afterEach(() => {
    resetPdfTestControls();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  beforeEach(() => {
    vi.stubGlobal('crypto', webcrypto);
    state.getDocumentInputs.length = 0;
    state.detachedInputs.length = 0;
    state.sourceBytes = PDF_INPUT.slice();
    state.transferInput = false;
    state.pathnameHashReads.length = 0;
    state.destroyCount = 0;
    state.workers.length = 0;
    state.pageNumbers.length = 0;
    state.readPaths.length = 0;
    state.renderCount = 0;
    state.readFailure = false;
    state.changed = null;
    state.textLayerRenderCount = 0;
    state.events.length = 0;
    usePaperProtocolReviewStore.setState({
      protocols: {},
      pdfs: {},
      pdfInstances: {},
      selectedStep: null,
      hoveredStep: null,
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      {} as CanvasRenderingContext2D
    );
  });

  it('renders literal PDF bytes to a page canvas and exposes page navigation', async () => {
    render(<PdfTab filePath="/workspace/paper.pdf" />);

    expect(await screen.findByTestId('pdf-tab')).toBeInTheDocument();
    await waitFor(() => expect(state.renderCount).toBe(1));
    expect(state.readPaths).toEqual(['/workspace/paper.pdf']);
    expect(state.getDocumentInputs).toEqual([{ data: new Uint8Array([0x25, 0x50, 0x44, 0x46]) }]);
    expect(screen.getByTestId('pdf-page-canvas')).toHaveAttribute('width', '600');
    expect(screen.getByTestId('pdf-page-canvas')).toHaveAttribute('height', '800');

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(state.pageNumbers.at(-1)).toBe(2));
    expect(screen.getByLabelText('Current PDF page')).toHaveValue(2);
  });

  it('rerenders the actual page at the requested zoom', async () => {
    render(<PdfTab filePath="/workspace/paper.pdf" />);
    expect(await screen.findByTestId('pdf-tab')).toBeInTheDocument();
    await waitFor(() => expect(state.renderCount).toBe(1));

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    await waitFor(() => expect(screen.getByText('120%')).toBeInTheDocument());
    await waitFor(() => expect(state.renderCount).toBe(2));
    expect(screen.getByTestId('pdf-page-canvas')).toHaveAttribute('width', '720');
    expect(screen.getByTestId('pdf-page-canvas')).toHaveAttribute('height', '960');
  });

  it('shows exact linked evidence and navigates both directions between PDF and protocol', async () => {
    usePaperProtocolReviewStore.getState().registerProtocol({
      ...REVIEW_METADATA,
      protocolPath: '/workspace/source.dnaforge-protocol.json',
      title: 'Source protocol',
      sources: [
        {
          sourceId: 'paper-main',
          title: 'Source paper',
          workspacePath: 'paper.pdf',
          absolutePath: '/workspace/paper.pdf',
          sha256: PDF_SHA,
          pageCount: 2,
        },
      ],
      steps: [
        {
          id: 'step-1',
          ordinal: 1,
          title: 'Lyse cells',
          anchors: [
            {
              anchorId: 'anchor-1',
              sourceId: 'paper-main',
              page: 1,
              quote: 'Cells were lysed.',
              rects: [{ x: 0.1, y: 0.2, width: 0.6, height: 0.03 }],
            },
          ],
        },
        {
          id: 'step-2',
          ordinal: 2,
          title: 'Amplify DNA',
          anchors: [
            {
              anchorId: 'anchor-2',
              sourceId: 'paper-main',
              page: 2,
              quote: 'DNA was amplified.',
              rects: [{ x: 0.12, y: 0.18, width: 0.5, height: 0.03 }],
            },
          ],
        },
      ],
    });

    render(<PdfTab filePath="/workspace/paper.pdf" />);

    const firstEvidence = await screen.findByRole('button', { name: 'Step 1: Lyse cells' });
    fireEvent.click(firstEvidence);
    expect(usePaperProtocolReviewStore.getState().selectedStep).toEqual({
      protocolPath: '/workspace/source.dnaforge-protocol.json',
      stepId: 'step-1',
    });

    act(() => {
      usePaperProtocolReviewStore.getState().selectStep({
        protocolPath: '/workspace/source.dnaforge-protocol.json',
        stepId: 'step-2',
      });
    });
    await waitFor(() => expect(screen.getByLabelText('Current PDF page')).toHaveValue(2));
    expect(await screen.findByRole('button', { name: 'Step 2: Amplify DNA' })).toBeInTheDocument();
  });

  it('refuses to overlay evidence when the open PDF bytes do not match the protocol source', async () => {
    usePaperProtocolReviewStore.getState().registerProtocol({
      ...REVIEW_METADATA,
      protocolPath: '/workspace/source.dnaforge-protocol.json',
      title: 'Source protocol',
      sources: [
        {
          sourceId: 'paper-main',
          title: 'Source paper',
          workspacePath: 'paper.pdf',
          absolutePath: '/workspace/paper.pdf',
          sha256: 'b'.repeat(64),
          pageCount: 2,
        },
      ],
      steps: [
        {
          id: 'step-1',
          ordinal: 1,
          title: 'Lyse cells',
          anchors: [
            {
              anchorId: 'anchor-1',
              sourceId: 'paper-main',
              page: 1,
              quote: 'Cells were lysed.',
              rects: [{ x: 0.1, y: 0.2, width: 0.6, height: 0.03 }],
            },
          ],
        },
      ],
    });

    render(<PdfTab filePath="/workspace/paper.pdf" />);

    expect(await screen.findByTestId('pdf-evidence-mismatch')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Step 1: Lyse cells' })).not.toBeInTheDocument();
  });
  it('registers the digest of the exact PDF.js input without a second pathname hash read', async () => {
    render(<PdfTab filePath="/workspace/paper.pdf" />);
    await screen.findByTestId('pdf-tab');
    await waitFor(() =>
      expect(usePaperProtocolReviewStore.getState().pdfs['/workspace/paper.pdf']?.sha256).toBe(
        PDF_SHA
      )
    );
    expect(state.pathnameHashReads).toEqual([]);
  });
  it('offers a load retry and retains page, zoom and selected evidence across source reload', async () => {
    const selected = registerControlledEvidence(2);
    state.readFailure = true;
    render(<PdfTab filePath="/workspace/paper.pdf" />);
    expect(await screen.findByTestId('pdf-tab-error')).toBeInTheDocument();
    state.readFailure = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry PDF' }));
    await screen.findByTestId('pdf-tab');
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    act(() => usePaperProtocolReviewStore.getState().selectStep(selected));
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    await waitFor(() => expect(screen.getByLabelText('Current PDF page')).toHaveValue(2));
    act(() => state.changed?.('/workspace/paper.pdf'));
    await waitFor(() => expect(state.readPaths).toHaveLength(3));
    await screen.findByTestId('pdf-tab');
    expect(screen.getByLabelText('Current PDF page')).toHaveValue(2);
    expect(screen.getByText('120%')).toBeInTheDocument();
    expect(usePaperProtocolReviewStore.getState().selectedStep).toEqual(selected);
    expect(
      await screen.findByRole('button', { name: 'Step 1: Controlled step' })
    ).toBeInTheDocument();
  });

  it('refuses equal-page-count replacement evidence using the exact transferred PDF.js bytes', async () => {
    const geometry = measurePdfPresentation();
    geometry.viewportWidth = 0;
    const selected = registerControlledEvidence(1);
    state.transferInput = true;
    const view = render(<PdfTab filePath="/workspace/paper.pdf" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Step 1: Controlled step' }));
    const first = usePaperProtocolReviewStore.getState().pdfs['/workspace/paper.pdf'];
    expect(first).toMatchObject({ sha256: PDF_SHA, pageCount: 2 });
    await waitFor(() =>
      expect(state.events.filter((event) => event.stage === 'citation_requested')).toHaveLength(1)
    );
    await settlePresentationFrames();
    expect(state.events.some((event) => event.stage === 'citation_arrived')).toBe(false);

    const replacement = new Uint8Array([0x25, 0x50, 0x44, 0x47]);
    const replacementSha = createHash('sha256').update(replacement).digest('hex');
    state.sourceBytes = replacement;
    act(() => state.changed?.('/workspace/paper.pdf'));

    expect(await screen.findByTestId('pdf-evidence-mismatch')).toBeInTheDocument();
    await waitFor(() =>
      expect(usePaperProtocolReviewStore.getState().pdfs['/workspace/paper.pdf']).toMatchObject({
        sha256: replacementSha,
        pageCount: 2,
      })
    );
    expect(state.getDocumentInputs).toEqual([{ data: PDF_INPUT }, { data: replacement }]);
    expect(state.detachedInputs).toHaveLength(2);
    expect(state.detachedInputs.every((input) => input.byteLength === 0)).toBe(true);
    expect(state.pathnameHashReads).toEqual([]);
    expect(state.destroyCount).toBe(1);
    expect(state.workers).toHaveLength(2);
    await waitFor(() => expect(state.workers[0].terminate).toHaveBeenCalledTimes(1));
    expect(state.workers[1].terminate).not.toHaveBeenCalled();
    expect(usePaperProtocolReviewStore.getState().selectedStep).toEqual(selected);
    expect(
      screen.queryByRole('button', { name: 'Step 1: Controlled step' })
    ).not.toBeInTheDocument();
    geometry.viewportWidth = 600;
    fireEvent(window, new Event('resize'));
    await settlePresentationFrames();
    expect(state.events.some((event) => event.stage === 'citation_arrived')).toBe(false);
    view.unmount();
    await waitFor(() => expect(state.workers[1].terminate).toHaveBeenCalledTimes(1));
    expect(state.workers[0].terminate).toHaveBeenCalledTimes(1);
    expect(state.destroyCount).toBe(2);
  });

  it('retries an actual text-stage failure on the intended page and zoom without reloading bytes', async () => {
    const selected = registerControlledEvidence(2);
    render(<PdfTab filePath="/workspace/paper.pdf" />);
    await screen.findByTestId('pdf-tab');
    act(() => usePaperProtocolReviewStore.getState().selectStep(selected));
    await screen.findByRole('button', { name: 'Step 1: Controlled step' });

    failPdfPhaseOnce('text');
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(await screen.findByTestId('pdf-page-error')).toHaveTextContent('text layer');
    expect(
      screen.queryByRole('button', { name: 'Step 1: Controlled step' })
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText('Current PDF page')).toHaveValue(2);
    expect(screen.getByText('120%')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry page' }));

    expect(
      await screen.findByRole('button', { name: 'Step 1: Controlled step' })
    ).toBeInTheDocument();
    expect(screen.queryByTestId('pdf-page-error')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Current PDF page')).toHaveValue(2);
    expect(screen.getByText('120%')).toBeInTheDocument();
    expect(screen.getByTestId('pdf-page-canvas')).toHaveAttribute('width', '720');
    expect(usePaperProtocolReviewStore.getState().selectedStep).toEqual(selected);
    expect(state.readPaths).toEqual(['/workspace/paper.pdf']);
    expect(state.getDocumentInputs).toHaveLength(1);
  });

  it('reports active measured presentation separately from inactive canvas/text readiness', async () => {
    measurePdfPresentation();
    const selected = registerControlledEvidence(1);
    act(() => usePaperProtocolReviewStore.getState().selectStep(selected));
    const view = render(<PdfTab filePath="/workspace/paper.pdf" isActive={false} />);
    await waitFor(() =>
      expect(screen.getByTestId('pdf-page')).toHaveAttribute('data-render-phase', 'ready')
    );
    await settlePresentationFrames();
    expect(state.events.some((event) => event.stage === 'text_unavailable')).toBe(true);
    expect(
      state.events.some((event) =>
        ['page_presented', 'first_page_presented', 'citation_arrived'].includes(event.stage)
      )
    ).toBe(false);
    const request = state.events.find((event) => event.stage === 'citation_requested');
    expect(request?.citationId).toBeDefined();

    view.rerender(<PdfTab filePath="/workspace/paper.pdf" isActive />);
    await waitFor(() =>
      expect(state.events.filter((event) => event.stage === 'citation_arrived')).toHaveLength(1)
    );
    expect(state.events.find((event) => event.stage === 'citation_arrived')?.citationId).toBe(
      request?.citationId
    );
    expect(state.events.filter((event) => event.stage === 'page_presented')).toHaveLength(1);
    expect(state.events.filter((event) => event.stage === 'first_page_presented')).toHaveLength(1);
    fireEvent.scroll(screen.getByTestId('pdf-viewport'));
    await settlePresentationFrames();
    expect(state.events.filter((event) => event.stage === 'citation_arrived')).toHaveLength(1);
    expect(state.events.filter((event) => event.stage === 'citation_requested')).toHaveLength(1);
  });

  it('can acknowledge only the current selected anchor after an offscreen request is superseded', async () => {
    const geometry = measurePdfPresentation();
    geometry.viewportWidth = 0;
    const selected = registerControlledEvidence(1);
    const registration = usePaperProtocolReviewStore.getState().protocols[selected.protocolPath];
    usePaperProtocolReviewStore.getState().registerProtocol({
      ...registration,
      steps: [
        ...registration.steps,
        {
          ...registration.steps[0],
          id: 'next-step',
          ordinal: 2,
          title: 'Next controlled step',
          anchors: [{ ...registration.steps[0].anchors[0], anchorId: 'next-anchor' }],
        },
      ],
    });
    usePaperProtocolReviewStore.getState().selectStep(selected);
    render(<PdfTab filePath="/workspace/paper.pdf" />);
    await screen.findByRole('button', { name: 'Step 1: Controlled step' });
    await waitFor(() =>
      expect(state.events.filter((event) => event.stage === 'citation_requested')).toHaveLength(1)
    );
    const oldRequest = state.events.find((event) => event.stage === 'citation_requested')!;
    act(() =>
      usePaperProtocolReviewStore
        .getState()
        .selectStep({ protocolPath: selected.protocolPath, stepId: 'next-step' })
    );
    await waitFor(() =>
      expect(state.events.filter((event) => event.stage === 'citation_requested')).toHaveLength(2)
    );
    const requests = state.events.filter((event) => event.stage === 'citation_requested');
    expect(requests[1].citationId).not.toBe(oldRequest.citationId);
    await settlePresentationFrames();
    expect(state.events.some((event) => event.stage === 'citation_arrived')).toBe(false);
    geometry.viewportWidth = 600;
    fireEvent(window, new Event('resize'));
    await waitFor(() =>
      expect(state.events.filter((event) => event.stage === 'citation_arrived')).toHaveLength(1)
    );
    expect(state.events.find((event) => event.stage === 'citation_arrived')?.citationId).toBe(
      requests[1].citationId
    );
    expect(screen.getByRole('button', { name: 'Step 2: Next controlled step' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });
  it.each(['error', 'messageerror'] as const)(
    'recovers from current raw %s with page, zoom and selected evidence intact',
    async (kind) => {
      const selected = registerControlledEvidence(2);
      render(<PdfTab filePath="/workspace/paper.pdf" />);
      await screen.findByTestId('pdf-tab');
      act(() => usePaperProtocolReviewStore.getState().selectStep(selected));
      fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
      await screen.findByRole('button', { name: 'Step 1: Controlled step' });
      const event = new Event(kind, { cancelable: true });
      if (kind === 'error')
        Object.defineProperty(event, 'error', {
          value: new Error('Harmless worker detail must stay private'),
        });
      act(() => state.workers[0].dispatchEvent(event));
      const error = await screen.findByTestId('pdf-tab-error');
      expect(error).not.toHaveTextContent('Harmless worker detail');
      expect(screen.queryByTestId('pdf-page-canvas')).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Step 1: Controlled step' })
      ).not.toBeInTheDocument();
      await waitFor(() =>
        expect(usePaperProtocolReviewStore.getState().pdfs['/workspace/paper.pdf']).toBeUndefined()
      );
      expect(state.events.filter((row) => row.stage === 'failed')).toHaveLength(1);
      act(() => state.workers[0].dispatchEvent(new Event('messageerror')));
      fireEvent.click(screen.getByRole('button', { name: 'Retry PDF' }));
      const evidence = await screen.findByRole('button', { name: 'Step 1: Controlled step' });
      expect(evidence).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByLabelText('Current PDF page')).toHaveValue(2);
      expect(screen.getByText('120%')).toBeInTheDocument();
      expect(usePaperProtocolReviewStore.getState().selectedStep).toEqual(selected);
      expect(usePaperProtocolReviewStore.getState().pdfs['/workspace/paper.pdf']).toMatchObject({
        sha256: PDF_SHA,
        pageCount: 2,
      });
      expect(state.workers).toHaveLength(2);
      expect(state.workers[0].terminate).toHaveBeenCalledTimes(1);
      expect(state.workers[1].terminate).not.toHaveBeenCalled();
      expect(state.events.filter((row) => row.stage === 'failed')).toHaveLength(1);
    }
  );

  it('rejects a failed held document and its late publication after a normal retry', async () => {
    const selected = registerControlledEvidence(1);
    usePaperProtocolReviewStore.getState().selectStep(selected);
    holdPdfPhase('document');
    render(<PdfTab filePath="/workspace/paper.pdf" />);
    await waitFor(() => expect(pdfPhaseEntered('document')).toBe(1));
    const event = new Event('error');
    Object.defineProperty(event, 'error', {
      value: new Error('Controlled pending-worker failure'),
    });
    act(() => state.workers[0].dispatchEvent(event));
    await screen.findByTestId('pdf-tab-error');
    fireEvent.click(screen.getByRole('button', { name: 'Retry PDF' }));
    await screen.findByRole('button', { name: 'Step 1: Controlled step' });
    const current = usePaperProtocolReviewStore.getState().pdfs['/workspace/paper.pdf'];
    await act(async () => releasePdfPhase('document'));
    expect(usePaperProtocolReviewStore.getState().pdfs['/workspace/paper.pdf']).toEqual(current);
    expect(screen.queryByTestId('pdf-tab-error')).not.toBeInTheDocument();
    expect(state.workers).toHaveLength(2);
    expect(state.workers[1].terminate).not.toHaveBeenCalled();
    expect(state.events.filter((row) => row.stage === 'failed')).toHaveLength(1);
  });
});

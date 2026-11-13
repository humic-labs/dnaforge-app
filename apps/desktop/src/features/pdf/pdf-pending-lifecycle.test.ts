import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCanvasStore } from '../canvas/public/store';
import { openDocument } from '../document-opening/public/open-document';
import { claimPdfRead } from './telemetry';

const metrics = vi.hoisted(() => ({
  ready: true,
  captures: vi.fn<(event: string, properties?: Record<string, unknown>) => boolean>(() => true),
  changed: new Set<() => void>(),
}));

vi.mock('../../platform', () => ({
  platform: () => ({ fs: { stat: async () => ({ isFile: true, isDirectory: false }) } }),
}));
vi.mock('../../lib/analytics', () => ({
  isAnalyticsCaptureReady: () => metrics.ready,
  subscribeAnalyticsCaptureReady: (callback: () => void) => {
    metrics.changed.add(callback);
    return () => metrics.changed.delete(callback);
  },
  trackRendererEvent: metrics.captures,
}));
vi.mock('../../lib/workflow-telemetry', () => ({
  observeWorkflowAction: () => false,
  beginWorkflowAction: () => null,
}));

const opened = new Set<string>();
const receipts = () =>
  metrics.captures.mock.calls
    .filter(([event]) => event === 'pdf_stage')
    .map(([, properties]) => properties);
const stages = (operationId: unknown) =>
  receipts().filter((properties) => properties?.operation_id === operationId);

async function openUnclaimedPdf(name: string, panelId = 'main') {
  const result = await openDocument({
    target: { kind: 'file', path: `/synthetic/${name}.pdf` },
    placement: { kind: 'panel', panelId },
  });
  if (result.status !== 'presented') throw new Error('Canonical PDF open was not presented');
  opened.add(result.tabId);
  const accepted = receipts().findLast((properties) => properties?.pdf_stage === 'accepted');
  expect(accepted).toMatchObject({ pdf_origin: 'explicit', pdf_stage: 'accepted' });
  expect(useCanvasStore.getState().panels[panelId].tabs).toContainEqual(
    expect.objectContaining({ id: result.tabId, type: 'pdf' })
  );
  return { ...result, operationId: accepted?.operation_id };
}

function expectClosed(tabId: string, operationId: unknown) {
  expect(
    Object.values(useCanvasStore.getState().panels).flatMap((panel) => panel.tabs)
  ).not.toContainEqual(expect.objectContaining({ id: tabId }));
  expect(stages(operationId).map((properties) => properties?.pdf_stage)).toEqual([
    'accepted',
    'cancelled',
  ]);
  expect(stages(operationId)[1]).toMatchObject({ pdf_reason: 'closed' });
  const retired = claimPdfRead(tabId, false);
  expect(retired.id).not.toBe(operationId);
  expect(retired.origin).toBe('restored');
}

beforeEach(() => {
  useCanvasStore.getState().reset();
  metrics.ready = true;
  metrics.captures.mockClear();
});

afterEach(() => {
  for (const tabId of opened) claimPdfRead(tabId, false);
  opened.clear();
  useCanvasStore.getState().reset();
});

describe('unclaimed PDF operation lifetime at real canvas removals', () => {
  it.each(['tab', 'panel', 'all', 'reset'] as const)(
    'retires an accepted operation removed by %s before a PdfTab effect runs',
    async (removal) => {
      const store = useCanvasStore.getState();
      const panelId = removal === 'panel' ? store.splitPanel('main', 'vertical') : 'main';
      const pdf = await openUnclaimedPdf(removal, panelId);
      if (removal === 'tab') store.closeTab(panelId, pdf.tabId);
      if (removal === 'panel') store.closePanel(panelId);
      if (removal === 'all') store.closeAllTabs(panelId);
      if (removal === 'reset') store.reset();
      expectClosed(pdf.tabId, pdf.operationId);
    }
  );

  it.each(['others', 'right'] as const)(
    'retires only the PDFs removed by closing tabs to %s',
    async (removal) => {
      const keep = await openUnclaimedPdf('keep');
      const removed = await openUnclaimedPdf('removed');
      const store = useCanvasStore.getState();
      if (removal === 'others') store.closeOtherTabs('main', keep.tabId);
      if (removal === 'right') store.closeTabsToRight('main', keep.tabId);
      expectClosed(removed.tabId, removed.operationId);
      expect(stages(keep.operationId).map((properties) => properties?.pdf_stage)).toEqual([
        'accepted',
      ]);
      expect(claimPdfRead(keep.tabId, false)).toMatchObject({
        id: keep.operationId,
        origin: 'explicit',
      });
    }
  );

  it('preserves pending ownership through moves, reorders and refused removals', async () => {
    const pdf = await openUnclaimedPdf('move');
    const store = useCanvasStore.getState();
    const otherPanel = store.splitPanel('main', 'vertical');
    store.moveTab('main', otherPanel, pdf.tabId);
    store.reorderTab(otherPanel, pdf.tabId, 0);
    store.closeTab(otherPanel, 'missing');
    store.closePanel('missing');
    expect(stages(pdf.operationId).map((properties) => properties?.pdf_stage)).toEqual([
      'accepted',
    ]);
    expect(claimPdfRead(pdf.tabId, false)).toMatchObject({
      id: pdf.operationId,
      origin: 'explicit',
    });
  });

  it('leaves a claimed operation to its PdfTab owner without duplicate cancellation', async () => {
    const pdf = await openUnclaimedPdf('claimed');
    const operation = claimPdfRead(pdf.tabId, false);
    const generation = crypto.randomUUID();
    useCanvasStore.getState().closeTab('main', pdf.tabId);
    expect(stages(pdf.operationId)).toHaveLength(1);
    operation.cancel(generation, 'closed');
    operation.cancel(generation, 'closed');
    expect(stages(pdf.operationId).map((properties) => properties?.pdf_stage)).toEqual([
      'accepted',
      'cancelled',
    ]);
  });

  it('retires pending ownership after consent revocation without emitting an optional outcome', async () => {
    const pdf = await openUnclaimedPdf('revoked');
    metrics.ready = false;
    metrics.changed.forEach((callback) => callback());
    useCanvasStore.getState().closeTab('main', pdf.tabId);
    expect(stages(pdf.operationId).map((properties) => properties?.pdf_stage)).toEqual([
      'accepted',
    ]);
    const retired = claimPdfRead(pdf.tabId, false);
    expect(retired.id).not.toBe(pdf.operationId);
    expect(retired.origin).toBe('restored');
  });
});

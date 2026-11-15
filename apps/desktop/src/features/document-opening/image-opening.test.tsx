// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { ImageViewerTab } from '../../components/ImageViewerTab';
import { openDocument } from './open-document';
import { useCanvasStore } from '../canvas/public/store';
import { resetImageViewLifecycleForTests } from './image-view-lifecycle';
import { installAnalyticsFirehose } from '../../lib/analytics-firehose';
import { sanitizeSdkEvent } from '@waypoint/analytics-policy';

const ports = vi.hoisted(() => ({
  read: vi.fn(),
  capture: vi.fn<(event: string, properties: Record<string, unknown>) => boolean>(() => true),
}));
vi.mock('../../platform', () => ({
  platform: () => ({
    fs: {
      readFileBounded: ports.read,
      stat: async () => ({ isFile: true, isDirectory: false }),
    },
  }),
  initPlatform: vi.fn(),
}));
vi.mock('../../lib/analytics', () => ({
  trackRendererEvent: ports.capture,
  isAnalyticsCaptureReady: () => true,
  isAnalyticsIdentityIdentified: () => true,
  getAnalyticsIdentifiedAccountId: () => null,
  getMeaningfulActivityAuthority: () => ({
    actorKind: 'test',
    executionMode: 'automated',
    impersonated: false,
  }),
  subscribeAnalyticsCaptureReady: () => () => undefined,
}));
const A = '/synthetic/custody-A.png';
const B = '/synthetic/custody-B.png';
const terminals = () =>
  ports.capture.mock.calls.filter(
    ([event, props]) =>
      event === 'workflow_action_observed' &&
      props.workflow === 'image' &&
      ['result', 'error', 'cancel'].includes(String(props.action_phase))
  );
async function decode() {
  const image = await screen.findByTestId<HTMLImageElement>('image-viewer-img');
  Object.defineProperties(image, {
    naturalWidth: { configurable: true, value: 320 },
    naturalHeight: { configurable: true, value: 240 },
  });
  fireEvent.load(image);
  return image;
}
beforeEach(() => {
  resetImageViewLifecycleForTests();
  useCanvasStore.getState().reset();
  ports.capture.mockReset().mockReturnValue(true);
  ports.read.mockReset().mockResolvedValue(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn(() => 'blob:opening');
      static revokeObjectURL = vi.fn();
    }
  );
});
afterEach(() => {
  cleanup();
  resetImageViewLifecycleForTests();
  useCanvasStore.getState().reset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('I1 real routing/presentation/owner composition', () => {
  it('does not qualify A as B when a synchronous store listener replaces the target before admission', async () => {
    let replaced = false;
    const unsubscribe = useCanvasStore.subscribe((state) => {
      const tab = state.panels.main.tabs.find(
        (item) => item.type === 'image' && item.entityId === A
      );
      if (tab && !replaced) {
        replaced = true;
        state.retargetTab('main', tab.id, { type: 'image', entityId: B });
      }
    });
    const result = await openDocument({ target: { kind: 'file', path: A } });
    unsubscribe();
    if (result.status !== 'presented') throw new Error('Synthetic presentation failed');
    render(<ImageViewerTab canvasTabId={result.tabId} filePath={B} />);
    await decode();
    expect(terminals()).toHaveLength(1);
    expect(terminals()[0][1].action_phase).toBe('cancel');
    expect(ports.capture.mock.calls.some(([, props]) => props.workflow_status === 'ready')).toBe(
      false
    );
    await act(async () => {
      await openDocument({ target: { kind: 'file', path: B } });
    });
    expect(terminals()).toHaveLength(2);
    expect(terminals()[1][1].outcome_kind).toBe('image_reuse_ready');
    expect(ports.read).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(ports.capture.mock.calls)).not.toContain('/synthetic');
  });

  it('fences late owner attachment after the real admitted tab is retargeted', async () => {
    const result = await openDocument({ target: { kind: 'file', path: A } });
    if (result.status !== 'presented') throw new Error('Synthetic presentation failed');
    useCanvasStore
      .getState()
      .retargetTab(result.panelId, result.tabId, { type: 'image', entityId: B });
    render(<ImageViewerTab canvasTabId={result.tabId} filePath={B} />);
    await decode();
    expect(terminals()).toHaveLength(1);
    expect(terminals()[0][1].action_phase).toBe('cancel');
    expect(
      ports.capture.mock.calls.some(([, props]) => props.outcome_kind === 'image_decode_ready')
    ).toBe(false);
  });

  it('keeps cancellation and unavailable destination outcomes separate from read/decode', async () => {
    const abort = new AbortController();
    abort.abort();
    expect(
      await openDocument({ target: { kind: 'file', path: A }, signal: abort.signal })
    ).toMatchObject({ status: 'cancelled' });
    expect(ports.capture).not.toHaveBeenCalled();
    expect(
      await openDocument({
        target: { kind: 'file', path: A },
        placement: { kind: 'panel', panelId: 'absent' },
      })
    ).toMatchObject({ status: 'failed' });
    expect(terminals()).toHaveLength(1);
    expect(terminals()[0][1].outcome_kind).toBe('image_open_refused');
    expect(ports.read).not.toHaveBeenCalled();
    expect(useCanvasStore.getState().panels.main.tabs).toHaveLength(0);
  });

  it('keeps a created tab, read completion and actual browser load distinct on the real route', async () => {
    const result = await openDocument({ target: { kind: 'file', path: A } });
    if (result.status !== 'presented') throw new Error('Synthetic presentation failed');
    expect(terminals()).toHaveLength(0);
    render(<ImageViewerTab canvasTabId={result.tabId} filePath={A} />);
    await screen.findByTestId('image-viewer-img');
    expect(terminals()).toHaveLength(0);
    await decode();
    expect(terminals()).toHaveLength(1);
    expect(terminals()[0][1].outcome_kind).toBe('image_decode_ready');
  });
});

describe('I1 image privacy composition contracts', () => {
  it('marks local image metadata for the real SDK exclusion policy', async () => {
    const result = await openDocument({ target: { kind: 'file', path: A } });
    if (result.status !== 'presented') throw new Error('Synthetic presentation failed');
    const view = render(<ImageViewerTab canvasTabId={result.tabId} filePath={A} />);
    const image = await decode();
    const root = view.container.firstElementChild;
    expect(root).toHaveAttribute('data-ph-no-capture');
    expect(root).toHaveClass('ph-no-capture');
    expect(root).toHaveAttribute('data-analytics-block');
    expect(root).toHaveAttribute('data-ph-mask');
    expect(
      sanitizeSdkEvent(
        {
          event: '$autocapture',
          properties: {
            $elements: [
              { tag_name: 'img', attr__src: image.src, attr__alt: image.alt },
              { tag_name: 'div', attr__data_ph_no_capture: 'true' },
            ],
          },
        },
        'desktop'
      )
    ).toBeNull();
  });

  it('excludes image metadata through the actual authored collector on the coherent F27 privacy candidate', async () => {
    const result = await openDocument({ target: { kind: 'file', path: A } });
    if (result.status !== 'presented') throw new Error('Synthetic presentation failed');
    render(<ImageViewerTab canvasTabId={result.tabId} filePath={A} />);
    await decode();
    const captured = vi.fn();
    const dispose = installAnalyticsFirehose({ capture: captured, isEnabled: () => true });
    try {
      fireEvent.click(screen.getByText('custody-A.png'));
      fireEvent.click(screen.getByText('320 × 240'));
      fireEvent.click(screen.getByTestId('image-viewer-img'));
      fireEvent.wheel(screen.getByTestId('image-viewer-img'), { ctrlKey: true, deltaY: -1 });
      const text = JSON.stringify(captured.mock.calls);
      expect(text).not.toContain('custody-A.png');
      expect(text).not.toContain('320 × 240');
      expect(text).not.toContain(A);
      expect(text).not.toContain('blob:opening');
    } finally {
      dispose();
    }
  });
});

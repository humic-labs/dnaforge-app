// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { useLayoutEffect, useRef } from 'react';
import { ImageViewerTab } from './ImageViewerTab';
import { openDocument } from '../features/document-opening/open-document';
import { useCanvasStore } from '../features/canvas/store';
import { resetImageViewLifecycleForTests } from '../features/document-opening/image-view-lifecycle';
import {
  __resetReadableContentTelemetryForTests,
  registerCanvasReadRequest,
  commitCanvasReadPlacement,
} from '../lib/readable-content-telemetry';

const ports = vi.hoisted(() => ({
  read: vi.fn(),
  capture: vi.fn<(event: string, props: Record<string, unknown>) => boolean>(() => true),
}));
vi.mock('../platform', () => ({
  platform: () => ({
    fs: {
      readFileBounded: ports.read,
      stat: async () => ({ isFile: true, isDirectory: false }),
    },
  }),
  initPlatform: vi.fn(),
}));
vi.mock('../lib/analytics', () => ({
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
const path = '/synthetic/private-figure.png';
const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
let viewport = { width: 800, height: 600 };
const resizeObservers = new Set<TestResizeObserver>();
class TestResizeObserver implements ResizeObserver {
  targets = new Set<Element>();
  constructor(private callback: ResizeObserverCallback) {
    resizeObservers.add(this);
  }
  observe(target: Element) {
    this.targets.add(target);
    this.deliver();
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
    resizeObservers.delete(this);
  }
  deliver() {
    const size = { inlineSize: viewport.width, blockSize: viewport.height };
    this.callback(
      [...this.targets].map((target) => ({
        target,
        contentRect: new DOMRect(0, 0, viewport.width, viewport.height),
        borderBoxSize: [size],
        contentBoxSize: [size],
        devicePixelContentBoxSize: [size],
      })),
      this
    );
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function open(filePath = path) {
  const result = await openDocument({
    target: { kind: 'file', path: filePath },
    source: 'file_tree',
  });
  if (result.status !== 'presented') throw new Error('Synthetic image open failed');
  return result;
}
async function mount(filePath = path) {
  const result = await open(filePath);
  const view = render(<ImageViewerTab canvasTabId={result.tabId} filePath={filePath} />);
  return { ...view, result };
}
async function image() {
  return screen.findByTestId<HTMLImageElement>('image-viewer-img');
}
function load(target: HTMLImageElement, width = 400, height = 200) {
  Object.defineProperties(target, {
    naturalWidth: { value: width, configurable: true },
    naturalHeight: { value: height, configurable: true },
  });
  fireEvent.load(target);
}
function scale(target: HTMLImageElement, naturalWidth: number) {
  return Number.parseFloat(getComputedStyle(target).width) / naturalWidth;
}
function terminals() {
  return ports.capture.mock.calls.filter(
    ([event, props]) =>
      event === 'workflow_action_observed' &&
      props.workflow === 'image' &&
      ['result', 'error', 'cancel'].includes(String(props.action_phase))
  );
}
function resize(width: number, height: number) {
  act(() => {
    viewport = { width, height };
    for (const observer of resizeObservers) observer.deliver();
  });
}
function wheel(surface: HTMLElement, deltaY: number, modifier: 'ctrl' | 'meta' | 'none' = 'ctrl') {
  const event = new WheelEvent('wheel', {
    deltaY,
    ctrlKey: modifier === 'ctrl',
    metaKey: modifier === 'meta',
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    surface.dispatchEvent(event);
  });
  return event;
}
beforeEach(() => {
  __resetReadableContentTelemetryForTests();
  resetImageViewLifecycleForTests();
  useCanvasStore.getState().reset();
  ports.capture.mockReset().mockReturnValue(true);
  ports.read.mockReset().mockResolvedValue(bytes);
  viewport = { width: 800, height: 600 };
  resizeObservers.clear();
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
  let url = 0;
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn(() => `blob:synthetic-${++url}`);
      static revokeObjectURL = vi.fn();
    }
  );
});
afterEach(() => {
  cleanup();
  __resetReadableContentTelemetryForTests();
  resetImageViewLifecycleForTests();
  useCanvasStore.getState().reset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('I1/I2 actual image component recovery and resource ownership', () => {
  it('joins canvas placement only to decoded current image readiness and supports readable return without rereading', async () => {
    const { result } = await mount();
    const operation = { id: '550e8400-e29b-41d4-a716-446655440005', initiatedAtMs: 100 };
    const next = { id: '550e8400-e29b-41d4-a716-446655440006', initiatedAtMs: 200 };
    const views = () =>
      ports.capture.mock.calls.filter(
        ([, props]) => props.workflow === 'content' && props.operation_id === operation.id
      );
    registerCanvasReadRequest({ panelId: result.panelId, tabId: result.tabId, operation });
    expect(commitCanvasReadPlacement(operation)).toBe(false);
    expect(views()).toHaveLength(0);
    const target = await image();
    expect(views()).toHaveLength(0);
    load(target);
    load(target);
    expect(views()).toHaveLength(1);
    expect(views()[0][1]).toMatchObject({
      workflow_status: 'viewed',
      success: true,
      action_id: expect.stringMatching(/^[a-f0-9-]{36}$/u),
    });
    registerCanvasReadRequest({ panelId: result.panelId, tabId: result.tabId, operation: next });
    expect(commitCanvasReadPlacement(next)).toBe(true);
    const returned = ports.capture.mock.calls.filter(
      ([, props]) => props.workflow === 'content' && props.operation_id === next.id
    );
    expect(returned).toHaveLength(1);
    expect(returned[0][1].action_id).toBe(views()[0][1].action_id);
    expect(ports.read).toHaveBeenCalledTimes(1);
  });

  it('settles decode failure as failed and a retried generation as readable for its own later navigation', async () => {
    const { result } = await mount();
    const operation = { id: '550e8400-e29b-41d4-a716-446655440005', initiatedAtMs: 100 };
    const next = { id: '550e8400-e29b-41d4-a716-446655440006', initiatedAtMs: 200 };
    registerCanvasReadRequest({ panelId: result.panelId, tabId: result.tabId, operation });
    expect(commitCanvasReadPlacement(operation)).toBe(false);
    fireEvent.error(await image());
    const failed = ports.capture.mock.calls.filter(
      ([, props]) => props.workflow === 'content' && props.operation_id === operation.id
    );
    expect(failed).toHaveLength(1);
    expect(failed[0][1]).toMatchObject({ workflow_status: 'failed', success: false });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    registerCanvasReadRequest({ panelId: result.panelId, tabId: result.tabId, operation: next });
    expect(commitCanvasReadPlacement(next)).toBe(false);
    load(await image());
    const recovered = ports.capture.mock.calls.filter(
      ([, props]) => props.workflow === 'content' && props.operation_id === next.id
    );
    expect(recovered).toHaveLength(1);
    expect(recovered[0][1]).toMatchObject({ workflow_status: 'viewed', success: true });
    expect(recovered[0][1].action_id).not.toBe(failed[0][1].action_id);
    expect(
      ports.capture.mock.calls.filter(
        ([, props]) => props.workflow === 'content' && props.operation_id === operation.id
      )
    ).toHaveLength(1);
  });

  it('does not call a mounted img decoded, then settles one genuine current load event', async () => {
    await mount();
    const target = await image();
    expect(terminals()).toHaveLength(0);
    load(target);
    load(target);
    fireEvent.error(target);
    expect(terminals()).toHaveLength(1);
    expect(terminals()[0][1]).toMatchObject({
      outcome_kind: 'image_decode_ready',
      workflow_status: 'ready',
    });
    expect(screen.getByText('400 × 200')).toBeInTheDocument();
  });

  it('recovers a refused read in the same tab with a new read/decode attempt and unchanged byte ceiling', async () => {
    ports.read.mockRejectedValueOnce(new Error('Denied private path /sensitive/native.png'));
    const view = await mount();
    expect(await screen.findByText('Failed to load image')).toBeInTheDocument();
    expect(screen.queryByText(/sensitive\/native/)).not.toBeInTheDocument();
    expect(terminals()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    const target = await image();
    load(target);
    expect(ports.read.mock.calls).toEqual([
      [path, 256 * 1024 * 1024],
      [path, 256 * 1024 * 1024],
    ]);
    expect(useCanvasStore.getState().panels.main.tabs.map((tab) => tab.id)).toEqual([
      view.result.tabId,
    ]);
    expect(terminals()).toHaveLength(2);
    expect(terminals()[0][1]).toMatchObject({
      outcome_kind: 'image_read_failed',
      error_class: 'read_unknown',
    });
    expect(terminals()[1][1]).toMatchObject({ outcome_kind: 'image_decode_ready' });
    expect(terminals()[0][1].action_id).not.toBe(terminals()[1][1].action_id);
    expect(terminals()[0][1].operation_id).not.toBe(terminals()[1][1].operation_id);
  });

  it.each([
    'EACCES',
    'ENOENT',
    'File exceeds bounded read limit',
    'File changed during bounded read',
  ])(
    'keeps persistent %s honest and does not infer an IPC reason or automatically retry',
    async (message) => {
      ports.read.mockRejectedValue(new Error(`${message}: /private/sentinel.png`));
      await mount();
      await screen.findByRole('button', { name: 'Retry' });
      expect(ports.read).toHaveBeenCalledTimes(1);
      expect(terminals()[0][1].error_class).toBe('read_unknown');
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      await screen.findByRole('button', { name: 'Retry' });
      expect(ports.read).toHaveBeenCalledTimes(2);
      expect(terminals()).toHaveLength(2);
      expect(JSON.stringify(ports.capture.mock.calls)).not.toContain('/private/sentinel');
    }
  );

  it('keeps unsupported/corrupt decode unknown, revokes each URL once and ignores old element events', async () => {
    const view = await mount();
    const old = await image();
    fireEvent.error(old);
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(terminals()[0][1]).toMatchObject({
      outcome_kind: 'image_decode_failed',
      error_class: 'decode_unknown',
    });
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:synthetic-1');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    const current = await image();
    expect(current).not.toBe(old);
    fireEvent.load(old);
    fireEvent.error(old);
    expect(terminals()).toHaveLength(1);
    load(current);
    view.unmount();
    expect(vi.mocked(URL.revokeObjectURL).mock.calls).toEqual([
      ['blob:synthetic-1'],
      ['blob:synthetic-2'],
    ]);
    expect(terminals()).toHaveLength(2);
  });

  it('does not create a URL for a stale deferred read after replacement or close', async () => {
    const oldRead = deferred<Uint8Array>();
    ports.read.mockReturnValueOnce(oldRead.promise);
    const view = await mount();
    act(() =>
      useCanvasStore
        .getState()
        .retargetTab(view.result.panelId, view.result.tabId, {
          type: 'image',
          entityId: '/synthetic/new.png',
        })
    );
    await open('/synthetic/new.png');
    view.rerender(<ImageViewerTab canvasTabId={view.result.tabId} filePath="/synthetic/new.png" />);
    const current = await image();
    load(current);
    await act(async () => {
      oldRead.resolve(bytes);
    });
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(terminals().map(([, props]) => props.action_phase)).toEqual(['cancel', 'result']);
    const anotherRead = deferred<Uint8Array>();
    ports.read.mockReturnValueOnce(anotherRead.promise);
    const next = await open('/synthetic/closing.png');
    view.rerender(<ImageViewerTab canvasTabId={next.tabId} filePath="/synthetic/closing.png" />);
    act(() => useCanvasStore.getState().closeTab(next.panelId, next.tabId));
    view.unmount();
    await act(async () => {
      anotherRead.resolve(bytes);
    });
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('commits loading for a new tab id at the same path before passive effects can replace the old attempt', async () => {
    const commits: Array<{ tabId: string; imagePresent: boolean; loading: boolean }> = [];
    function Host({ tabId }: { tabId: string }) {
      const host = useRef<HTMLDivElement>(null);
      useLayoutEffect(() => {
        commits.push({
          tabId,
          imagePresent: !!host.current?.querySelector('[data-testid="image-viewer-img"]'),
          loading: host.current?.textContent?.includes('Loading image...') ?? false,
        });
      }, [tabId]);
      return (
        <div ref={host}>
          <ImageViewerTab canvasTabId={tabId} filePath={path} />
        </div>
      );
    }
    const first = await open();
    const view = render(<Host tabId={first.tabId} />);
    const old = await image();
    load(old);
    const held = deferred<Uint8Array>();
    ports.read.mockReturnValueOnce(held.promise);
    act(() => useCanvasStore.getState().closeTab(first.panelId, first.tabId));
    const second = await open();
    expect(second.tabId).not.toBe(first.tabId);
    view.rerender(<Host tabId={second.tabId} />);
    expect(commits.find((commit) => commit.tabId === second.tabId)).toEqual({
      tabId: second.tabId,
      imagePresent: false,
      loading: true,
    });
    expect(ports.read).toHaveBeenCalledTimes(2);
    await act(async () => {
      held.resolve(bytes);
    });
    const replacement = await image();
    expect(replacement).not.toBe(old);
    load(replacement);
    expect(
      terminals().filter(([, props]) => props.outcome_kind === 'image_decode_ready')
    ).toHaveLength(2);
  });

  it('revokes a URL created exactly as its tab closes before publication', async () => {
    const result = await open();
    vi.mocked(URL.createObjectURL).mockImplementationOnce(() => {
      useCanvasStore.getState().closeTab(result.panelId, result.tabId);
      return 'blob:closed-during-create';
    });
    render(<ImageViewerTab canvasTabId={result.tabId} filePath={path} />);
    await waitFor(() =>
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:closed-during-create')
    );
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('image-viewer-img')).not.toBeInTheDocument();
    expect(terminals()).toHaveLength(1);
    expect(terminals()[0][1].action_phase).toBe('cancel');
  });

  it('refuses a stale Retry control after the still-mounted tab has been retargeted', async () => {
    ports.read.mockRejectedValueOnce(new Error('unavailable'));
    const view = await mount();
    const retry = await screen.findByRole('button', { name: 'Retry' });
    act(() =>
      useCanvasStore
        .getState()
        .retargetTab(view.result.panelId, view.result.tabId, {
          type: 'image',
          entityId: '/synthetic/B.png',
        })
    );
    fireEvent.click(retry);
    expect(ports.read).toHaveBeenCalledTimes(1);
    expect(terminals()).toHaveLength(1);
  });

  it('does not mark an invalid zero-size load event ready', async () => {
    await mount();
    load(await image(), 0, 0);
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(terminals()).toHaveLength(1);
    expect(terminals()[0][1]).toMatchObject({
      action_phase: 'error',
      error_class: 'decode_unknown',
    });
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it('preserves viewing when collection throws and does not late-qualify a refused start', async () => {
    ports.capture.mockImplementation(() => {
      throw new Error('sender unavailable');
    });
    const view = await mount();
    const target = await image();
    load(target);
    expect(screen.getByText('400 × 200')).toBeInTheDocument();
    view.unmount();
    resetImageViewLifecycleForTests();
    useCanvasStore.getState().reset();
    ports.capture.mockReset().mockReturnValueOnce(false).mockReturnValue(true);
    await mount();
    load(await image());
    expect(ports.capture).toHaveBeenCalledTimes(1);
    expect(terminals()).toHaveLength(0);
    await act(async () => {
      await open();
    });
    expect(terminals()).toHaveLength(1);
    expect(terminals()[0][1].outcome_kind).toBe('image_reuse_ready');
  });

  it('distinguishes an unattributed restored mount and later already-readable reuse without another read', async () => {
    const tab = useCanvasStore
      .getState()
      .openTab('main', { type: 'image', entityId: path, label: 'Restored local label' });
    render(<ImageViewerTab canvasTabId={tab} filePath={path} />);
    load(await image());
    expect(ports.capture).not.toHaveBeenCalled();
    await act(async () => {
      await open();
    });
    expect(ports.read).toHaveBeenCalledTimes(1);
    expect(terminals()).toHaveLength(1);
    expect(terminals()[0][1].outcome_kind).toBe('image_reuse_ready');
  });
});

describe('I3 actual natural/viewport geometry through the component', () => {
  it.each([
    [100, 100, 800, 600, 1],
    [4000, 2000, 500, 500, 0.125],
    [800, 400, 300, 300, 0.375],
  ])(
    'steps rendered Fit scale for natural %sx%s in viewport %sx%s',
    async (width, height, vw, vh, fit) => {
      viewport = { width: vw, height: vh };
      await mount();
      const target = await image();
      load(target, width, height);
      expect(scale(target, width)).toBeCloseTo(fit);
      fireEvent.click(screen.getByTitle('Zoom in'));
      expect(scale(target, width)).toBeGreaterThan(fit);
      fireEvent.click(screen.getByText('Fit'));
      expect(scale(target, width)).toBeCloseTo(fit);
      fireEvent.click(screen.getByTitle('Zoom out'));
      if (fit > 0.25) expect(scale(target, width)).toBeLessThan(fit);
      else expect(scale(target, width)).toBeCloseTo(fit);
    }
  );

  it('handles rapid repeated controls, both modifier-wheel directions, numeric bounds and no-op input', async () => {
    viewport = { width: 500, height: 500 };
    await mount();
    const target = await image();
    load(target, 4000, 2000);
    const surface = screen.getByTestId('image-viewer-surface');
    expect(wheel(surface, 0).defaultPrevented).toBe(false);
    expect(wheel(surface, -1, 'none').defaultPrevented).toBe(false);
    expect(scale(target, 4000)).toBeCloseTo(0.125);
    act(() => {
      for (let n = 0; n < 8; n++)
        surface.dispatchEvent(
          new WheelEvent('wheel', { deltaY: -1, ctrlKey: true, bubbles: true, cancelable: true })
        );
    });
    expect(scale(target, 4000)).toBe(2);
    expect(wheel(surface, 1, 'meta').defaultPrevented).toBe(true);
    expect(scale(target, 4000)).toBe(1);
    for (let n = 0; n < 8; n++) fireEvent.click(screen.getByTitle('Zoom out'));
    expect(scale(target, 4000)).toBe(0.25);
    fireEvent.click(screen.getByText('Fit'));
    expect(scale(target, 4000)).toBeCloseTo(0.125);
    expect(wheel(surface, 1).defaultPrevented).toBe(true);
    expect(scale(target, 4000)).toBeCloseTo(0.125);
  });

  it('recomputes Fit on resize, preserves numeric zoom, and resets pan through Fit/double-click', async () => {
    viewport = { width: 500, height: 500 };
    await mount();
    const target = await image();
    load(target, 2000, 1000);
    const surface = screen.getByTestId('image-viewer-surface');
    expect(scale(target, 2000)).toBe(0.25);
    resize(1000, 800);
    expect(scale(target, 2000)).toBe(0.5);
    fireEvent.click(screen.getByText('100%'));
    resize(200, 200);
    expect(scale(target, 2000)).toBe(1);
    fireEvent.mouseDown(surface, { button: 0, clientX: 10, clientY: 20 });
    fireEvent.mouseMove(surface, { clientX: 40, clientY: 70 });
    expect(target.style.transform).toBe('translate(30px, 50px)');
    fireEvent.mouseUp(document);
    fireEvent.mouseMove(surface, { clientX: 90, clientY: 100 });
    expect(target.style.transform).toBe('translate(30px, 50px)');
    fireEvent.mouseDown(surface, { button: 0, clientX: 10, clientY: 20 });
    fireEvent.blur(window);
    fireEvent.mouseMove(surface, { clientX: 90, clientY: 100 });
    expect(target.style.transform).toBe('translate(30px, 50px)');
    fireEvent.click(screen.getByText('Fit'));
    expect(scale(target, 2000)).toBe(0.1);
    expect(target.style.transform).toBe('translate(0px, 0px)');
    fireEvent.doubleClick(surface);
    expect(scale(target, 2000)).toBe(1);
    fireEvent.doubleClick(surface);
    expect(scale(target, 2000)).toBe(0.1);
    fireEvent.click(screen.getByText('50%'));
    fireEvent.mouseDown(surface, { button: 0, clientX: 1, clientY: 1 });
    fireEvent.mouseLeave(surface);
    fireEvent.mouseMove(surface, { clientX: 50, clientY: 50 });
    expect(target.style.transform).toBe('translate(0px, 0px)');
  });

  it('keeps Copy Path fulfillment/failure separate from image readiness', async () => {
    const copied = deferred<void>();
    const writeText = vi.fn(() => copied.promise);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await mount();
    load(await image());
    const before = ports.capture.mock.calls.length;
    fireEvent.click(screen.getByText('Copy Path'));
    expect(writeText).toHaveBeenCalledWith(path);
    await act(async () => {
      copied.resolve(undefined);
    });
    expect(ports.capture.mock.calls).toHaveLength(before);
    writeText.mockRejectedValueOnce(new Error('clipboard unavailable'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fireEvent.click(screen.getByText('Copy Path'));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(ports.capture.mock.calls).toHaveLength(before);
    expect(screen.getByText('400 × 200')).toBeInTheDocument();
  });
});

/** @vitest-environment jsdom */
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SequenceViewer } from '../SequenceViewer';
import type { SequenceScrollPresentation } from '../types';
import {
  installRecordingCanvas,
  uninstallRecordingCanvas,
} from '../testing/recording-canvas-context';

const paints = vi.hoisted(() => ({
  frames: [] as Array<() => void>,
  visible: true,
  zeroViewport: false,
}));

vi.mock('../rendering/webgl-drawing-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../rendering/webgl-drawing-context')>()),
  getSequenceWebGLContext: (canvas: HTMLCanvasElement) =>
    Object.assign(canvas.getContext('2d')!, {
      beginFrame: () => true,
      endFrame: () => undefined,
      setPresentationShiftBounds: () => undefined,
      capturePresentationScene: () => undefined,
      presentRows: () => undefined,
    }),
}));

vi.mock('../hooks/useCanvasWorkerDraw', async (importOriginal) => {
  const original = await importOriginal<typeof import('../hooks/useCanvasWorkerDraw')>();
  return {
    ...original,
    useCanvasWorkerDraw(params: Parameters<typeof original.useCanvasWorkerDraw>[0]) {
      const deliver = params.onViewportPresented;
      original.useCanvasWorkerDraw({
        ...params,
        onViewportPresented: deliver
          ? (frame) => paints.frames.push(() => deliver(frame))
          : undefined,
      });
    },
  };
});

const sequence = {
  id: 'scroll-presentation-template',
  name: 'scroll-presentation-template',
  sequence: 'ACGT'.repeat(1000),
  length: 4000,
  circular: false,
  annotations: [],
};

beforeEach(() => {
  paints.frames = [];
  paints.visible = true;
  paints.zeroViewport = false;
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
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() =>
    paints.zeroViewport ? 0 : 600
  );
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(20000);
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() =>
    paints.visible ? 'visible' : 'hidden'
  );
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: function (this: HTMLElement, options: ScrollToOptions) {
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

async function takeFrames() {
  await waitFor(() => expect(paints.frames.length).toBeGreaterThan(0), { timeout: 300 });
  return paints.frames.splice(0);
}

function present(frames: Array<() => void>) {
  act(() => {
    for (const frame of frames) frame();
  });
}

function request(position: number): SequenceScrollPresentation {
  return { position, presented: vi.fn() };
}

describe('SequenceViewer owned visible scroll presentation', () => {
  it('keeps applied completion separate from held paint and delivers the current frame once', async () => {
    const target = request(2000);
    const applied = vi.fn();
    render(
      <SequenceViewer
        sequence={sequence}
        scrollToPosition={2000}
        scrollCommandId={1}
        scrollAnimate={false}
        scrollPresentation={target}
        onScrollToPositionComplete={applied}
      />
    );
    await waitFor(() => expect(applied).toHaveBeenCalledTimes(1));
    const frames = await takeFrames();
    expect(target.presented).not.toHaveBeenCalled();
    present(frames);
    expect(target.presented).toHaveBeenCalledTimes(1);
    present(frames);
    expect(target.presented).toHaveBeenCalledTimes(1);
    expect(applied).toHaveBeenCalledTimes(1);
  });

  it('does not deliver a held acknowledgement to either retired or replacement owners with equal geometry and command id', async () => {
    const old = request(2000),
      current = request(2000);
    const view = render(
      <SequenceViewer
        sequence={sequence}
        scrollToPosition={2000}
        scrollCommandId={1}
        scrollAnimate={false}
        scrollPresentation={old}
      />
    );
    const retiredFrames = await takeFrames();
    view.rerender(
      <SequenceViewer
        sequence={sequence}
        scrollToPosition={2000}
        scrollCommandId={1}
        scrollAnimate={false}
        scrollPresentation={current}
      />
    );
    const currentFrames = await takeFrames();
    present(retiredFrames);
    expect(old.presented).not.toHaveBeenCalled();
    expect(current.presented).not.toHaveBeenCalled();
    present(currentFrames);
    expect(current.presented).toHaveBeenCalledTimes(1);
    expect(old.presented).not.toHaveBeenCalled();
  });

  it('requires a fresh frame for a near target after a prior owner has completed', async () => {
    const first = request(1),
      second = request(1);
    const view = render(
      <SequenceViewer
        sequence={sequence}
        scrollToPosition={1}
        scrollCommandId={1}
        scrollAnimate={false}
        scrollPresentation={first}
      />
    );
    const oldFrames = await takeFrames();
    present(oldFrames);
    expect(first.presented).toHaveBeenCalledTimes(1);
    view.rerender(
      <SequenceViewer
        sequence={sequence}
        scrollToPosition={1}
        scrollCommandId={1}
        scrollAnimate={false}
        scrollPresentation={second}
      />
    );
    present(oldFrames);
    expect(second.presented).not.toHaveBeenCalled();
    present(await takeFrames());
    expect(second.presented).toHaveBeenCalledTimes(1);
    expect(first.presented).toHaveBeenCalledTimes(1);
  });

  it('cancels presentation independently while leaving an applied command intact', async () => {
    const target = request(2000),
      applied = vi.fn();
    const view = render(
      <SequenceViewer
        sequence={sequence}
        scrollToPosition={2000}
        scrollCommandId={1}
        scrollAnimate={false}
        scrollPresentation={target}
        onScrollToPositionComplete={applied}
      />
    );
    const frames = await takeFrames();
    view.rerender(
      <SequenceViewer
        sequence={sequence}
        scrollToPosition={2000}
        scrollCommandId={1}
        scrollAnimate={false}
        scrollPresentation={null}
        onScrollToPositionComplete={applied}
      />
    );
    present(frames);
    expect(target.presented).not.toHaveBeenCalled();
    expect(applied).toHaveBeenCalledTimes(1);
  });

  it('retires an intent across source replacement even when its request object is retained', async () => {
    const retired = request(2000),
      fresh = request(2000);
    const replacement = {
      ...sequence,
      id: 'replacement-scroll-template',
      sequence: 'TGCA'.repeat(1000),
    };
    const view = render(
      <SequenceViewer
        sequence={sequence}
        scrollToPosition={2000}
        scrollAnimate={false}
        scrollPresentation={retired}
      />
    );
    const oldFrames = await takeFrames();
    view.rerender(
      <SequenceViewer
        sequence={replacement}
        scrollToPosition={2000}
        scrollAnimate={false}
        scrollPresentation={retired}
      />
    );
    const wrongSourceFrames = await takeFrames();
    present([...oldFrames, ...wrongSourceFrames]);
    expect(retired.presented).not.toHaveBeenCalled();
    view.rerender(
      <SequenceViewer
        sequence={replacement}
        scrollToPosition={2000}
        scrollAnimate={false}
        scrollPresentation={fresh}
      />
    );
    present(await takeFrames());
    expect(fresh.presented).toHaveBeenCalledTimes(1);
    expect(retired.presented).not.toHaveBeenCalled();
  });

  it('does not turn a hidden submitted frame into arrival after visibility returns', async () => {
    paints.visible = false;
    const target = request(2000);
    const view = render(
      <SequenceViewer
        sequence={sequence}
        scrollToPosition={2000}
        scrollAnimate={false}
        scrollPresentation={target}
      />
    );
    const hiddenFrames = await takeFrames();
    paints.visible = true;
    present(hiddenFrames);
    expect(target.presented).not.toHaveBeenCalled();
    view.rerender(
      <SequenceViewer
        sequence={sequence}
        scrollToPosition={2000}
        scrollAnimate={false}
        config={{ charWidth: 9 }}
        scrollPresentation={target}
      />
    );
    present(await takeFrames());
    expect(target.presented).toHaveBeenCalledTimes(1);
  });

  it('requires a positive visible viewport at submission instead of a retained height hint', async () => {
    paints.zeroViewport = true;
    const target = request(1);
    const view = render(
      <SequenceViewer sequence={sequence} viewportHeightHint={600} scrollPresentation={target} />
    );
    const hiddenFrames = await takeFrames();
    paints.zeroViewport = false;
    present(hiddenFrames);
    expect(target.presented).not.toHaveBeenCalled();
    view.rerender(
      <SequenceViewer
        sequence={sequence}
        viewportHeightHint={600}
        config={{ charWidth: 9 }}
        scrollPresentation={target}
      />
    );
    present(await takeFrames());
    expect(target.presented).toHaveBeenCalledTimes(1);
  });

  it('rejects a target outside the visible viewport even when its row is retained in the layout', async () => {
    const target = request(3500);
    const view = render(<SequenceViewer sequence={sequence} scrollPresentation={target} />);
    present(await takeFrames());
    expect(target.presented).not.toHaveBeenCalled();
    view.rerender(
      <SequenceViewer
        sequence={sequence}
        scrollToPosition={3500}
        scrollAnimate={false}
        scrollPresentation={target}
      />
    );
    present(await takeFrames());
    expect(target.presented).toHaveBeenCalledTimes(1);
  });

  it('cannot deliver a held frame after unmount', async () => {
    const target = request(2000);
    const view = render(
      <SequenceViewer
        sequence={sequence}
        scrollToPosition={2000}
        scrollAnimate={false}
        scrollPresentation={target}
      />
    );
    const frames = await takeFrames();
    view.unmount();
    present(frames);
    expect(target.presented).not.toHaveBeenCalled();
  });
});

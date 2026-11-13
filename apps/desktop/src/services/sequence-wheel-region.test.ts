// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { installSequenceWheelRegionPublisher } from './sequence-wheel-region';

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it('registers and retires a canvas whose input owner attaches after its DOM mount', async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
  const canvas = document.createElement('canvas');
  canvas.getBoundingClientRect = () => ({ x: 30, y: 40, width: 800, height: 300 }) as DOMRect;
  document.body.append(canvas);
  const publish = vi.fn();
  const cleanup = installSequenceWheelRegionPublisher(publish);
  try {
    expect(publish).toHaveBeenLastCalledWith([]);
    canvas.dataset.sequenceWheelZoomViewport = '';
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(publish).toHaveBeenLastCalledWith([{ x: 30, y: 40, width: 800, height: 300 }]);
    delete canvas.dataset.sequenceWheelZoomViewport;
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(publish).toHaveBeenLastCalledWith([]);
  } finally {
    cleanup();
  }
});

it('retires native input regions while their retained workspace is inert and restores them on return', async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
  const workspace = document.createElement('div');
  const canvas = document.createElement('canvas');
  canvas.dataset.sequenceWheelZoomViewport = '';
  canvas.getBoundingClientRect = () => ({ x: 30, y: 40, width: 800, height: 300 }) as DOMRect;
  workspace.append(canvas);
  document.body.append(workspace);
  const publish = vi.fn();
  const cleanup = installSequenceWheelRegionPublisher(publish);
  try {
    expect(publish).toHaveBeenLastCalledWith([{ x: 30, y: 40, width: 800, height: 300 }]);
    workspace.setAttribute('inert', '');
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(publish).toHaveBeenLastCalledWith([]);
    workspace.removeAttribute('inert');
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(publish).toHaveBeenLastCalledWith([{ x: 30, y: 40, width: 800, height: 300 }]);
  } finally {
    cleanup();
  }
});

it.each(['display', 'visibility'] as const)(
  'retires regions when an ancestor changes %s without resizing the viewport',
  async (property) => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      }
    );
    const workspace = document.createElement('div');
    const canvas = document.createElement('canvas');
    canvas.dataset.sequenceWheelZoomViewport = '';
    canvas.getBoundingClientRect = () => ({ x: 30, y: 40, width: 800, height: 300 }) as DOMRect;
    workspace.append(canvas);
    document.body.append(workspace);
    const publish = vi.fn();
    const cleanup = installSequenceWheelRegionPublisher(publish);
    try {
      workspace.style[property] = property === 'display' ? 'none' : 'hidden';
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      expect(publish).toHaveBeenLastCalledWith([]);
      workspace.style[property] = '';
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      expect(publish).toHaveBeenLastCalledWith([{ x: 30, y: 40, width: 800, height: 300 }]);
    } finally {
      cleanup();
    }
  }
);

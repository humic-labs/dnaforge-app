import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { installFrameTabNavigation } from './frame-tab-navigation';

vi.mock('electron', () => ({ ipcMain: {}, ipcRenderer: {} }));

interface Frame {
  frameTreeNodeId: number;
  name: string;
  parent: Frame | null;
  frames: Frame[];
  detached: boolean;
}

function frame(id: number, name = '', parent: Frame | null = null): Frame {
  return { frameTreeNodeId: id, name, parent, frames: [], detached: false };
}

function fixture() {
  const main = frame(1);
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: main,
    focusedFrame: main as Frame | null,
    isDestroyed: () => false,
    send: vi.fn(),
  });
  const window = Object.assign(new EventEmitter(), {
    webContents: contents,
    isDestroyed: () => false,
  });
  installFrameTabNavigation(window);
  const create = (next: Frame) => {
    next.parent?.frames.push(next);
    contents.emit('frame-created', {}, { frame: next });
    return next;
  };
  const input = (
    overrides: Partial<{
      type: string;
      key: string;
      code: string;
      control: boolean;
      shift: boolean;
      alt: boolean;
      meta: boolean;
      isComposing: boolean;
    }> = {}
  ) => {
    const event = { preventDefault: vi.fn() };
    contents.emit('before-input-event', event, {
      type: 'keyDown',
      key: 'Tab',
      code: 'Tab',
      control: true,
      shift: false,
      alt: false,
      meta: false,
      isComposing: false,
      ...overrides,
    });
    return event;
  };
  return { main, contents, window, create, input };
}

it.each([false, true])('relays the exact reserved child-frame chord with shift=%s', (shift) => {
  const f = fixture();
  const outer = f.create(frame(2, 'dnaforge-tab-frame:owned', f.main));
  f.contents.focusedFrame = outer;

  const event = f.input({ shift });

  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(f.contents.send).toHaveBeenCalledExactlyOnceWith('window:frame-tab-navigation', {
    frameName: 'dnaforge-tab-frame:owned',
    direction: shift ? -1 : 1,
  });
});

it('keeps the app-owned slot token after child script changes its window name and after navigation', () => {
  const f = fixture();
  const outer = f.create(frame(2, 'dnaforge-tab-frame:owned', f.main));
  outer.name = 'untrusted-child-name';
  const replacement = frame(2, 'untrusted-navigation-name', f.main);
  f.main.frames = [replacement];
  f.contents.emit('frame-created', {}, { frame: replacement });
  f.contents.focusedFrame = replacement;

  f.input();

  expect(f.contents.send).toHaveBeenCalledExactlyOnceWith('window:frame-tab-navigation', {
    frameName: 'dnaforge-tab-frame:owned',
    direction: 1,
  });
});

it('routes a nested document through the cached outer slot rather than the nested name', () => {
  const f = fixture();
  const outer = f.create(frame(2, 'dnaforge-tab-frame:owned', f.main));
  const inner = f.create(frame(3, 'dnaforge-tab-frame:forged-nested', outer));
  f.contents.focusedFrame = inner;

  f.input();

  expect(f.contents.send).toHaveBeenCalledExactlyOnceWith('window:frame-tab-navigation', {
    frameName: 'dnaforge-tab-frame:owned',
    direction: 1,
  });
});

it('never duplicates main-document handling or consumes ordinary and modified typing', () => {
  const f = fixture();
  expect(f.input().preventDefault).not.toHaveBeenCalled();
  const outer = f.create(frame(2, 'dnaforge-tab-frame:owned', f.main));
  f.contents.focusedFrame = outer;
  for (const change of [
    { control: false },
    { alt: true },
    { meta: true },
    { type: 'keyUp' },
    { key: 'a', code: 'KeyA' },
    { isComposing: true },
  ])
    expect(f.input(change).preventDefault).not.toHaveBeenCalled();
  expect(f.contents.send).not.toHaveBeenCalled();
});

it('prunes removed slots and refuses stale, unnamed, detached or unrelated frames', () => {
  const f = fixture();
  const retired = f.create(frame(2, 'dnaforge-tab-frame:retired', f.main));
  f.main.frames = [];
  f.contents.focusedFrame = retired;
  expect(f.input().preventDefault).not.toHaveBeenCalled();
  f.contents.focusedFrame = f.create(frame(3, 'ordinary-frame', f.main));
  expect(f.input().preventDefault).not.toHaveBeenCalled();
  const detached = f.create(frame(4, 'dnaforge-tab-frame:detached', f.main));
  detached.detached = true;
  f.contents.focusedFrame = detached;
  expect(f.input().preventDefault).not.toHaveBeenCalled();
  f.contents.focusedFrame = frame(6, 'dnaforge-tab-frame:foreign', frame(5));
  expect(f.input().preventDefault).not.toHaveBeenCalled();
  f.contents.focusedFrame = null;
  expect(f.input().preventDefault).not.toHaveBeenCalled();
  expect(f.contents.send).not.toHaveBeenCalled();
});

it('releases native listeners and cached slots when the window closes', () => {
  const f = fixture();
  f.contents.focusedFrame = f.create(frame(2, 'dnaforge-tab-frame:owned', f.main));

  f.window.emit('closed');

  expect(f.contents.listenerCount('frame-created')).toBe(0);
  expect(f.contents.listenerCount('before-input-event')).toBe(0);
  f.input();
  expect(f.contents.send).not.toHaveBeenCalled();
});

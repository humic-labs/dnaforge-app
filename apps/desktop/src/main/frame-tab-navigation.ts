import type { Input } from 'electron';
import { sendRendererIpc } from '../shared/ipc-contract';
import { FRAME_TAB_NAME_PREFIX } from '../shared/frame-tab-navigation';

interface NativeFrame {
  readonly frameTreeNodeId: number;
  readonly name: string;
  readonly parent: NativeFrame | null;
  readonly frames: readonly NativeFrame[];
  readonly detached: boolean;
}

type NativeTabInput = Pick<
  Input,
  'type' | 'key' | 'code' | 'control' | 'shift' | 'alt' | 'meta' | 'isComposing'
>;
type NativeInputListener = (event: { preventDefault(): void }, input: NativeTabInput) => void;
type NativeFrameListener = (event: unknown, details: { frame: NativeFrame | null }) => void;

interface FrameTabWindow {
  isDestroyed(): boolean;
  once(event: 'closed', listener: () => void): unknown;
  webContents: {
    readonly mainFrame: NativeFrame;
    readonly focusedFrame: NativeFrame | null;
    isDestroyed(): boolean;
    send(channel: string, ...args: unknown[]): void;
    on(event: 'frame-created', listener: NativeFrameListener): unknown;
    on(event: 'before-input-event', listener: NativeInputListener): unknown;
    removeListener(event: 'frame-created', listener: NativeFrameListener): unknown;
    removeListener(event: 'before-input-event', listener: NativeInputListener): unknown;
  };
}

export function installFrameTabNavigation(window: FrameTabWindow): void {
  const contents = window.webContents;
  const frameNames = new Map<number, string>();
  const rememberFrame = (frame: NativeFrame | null) => {
    if (
      !frame ||
      frame.detached ||
      frame.parent?.frameTreeNodeId !== contents.mainFrame.frameTreeNodeId ||
      !frame.name.startsWith(FRAME_TAB_NAME_PREFIX) ||
      frameNames.has(frame.frameTreeNodeId)
    )
      return;
    frameNames.set(frame.frameTreeNodeId, frame.name);
  };
  const created: NativeFrameListener = (_event, details) => rememberFrame(details.frame);
  const input: NativeInputListener = (event, key) => {
    if (
      window.isDestroyed() ||
      contents.isDestroyed() ||
      key.type !== 'keyDown' ||
      key.key !== 'Tab' ||
      !key.control ||
      key.alt ||
      key.meta ||
      key.isComposing
    )
      return;
    const main = contents.mainFrame;
    const liveIds = new Set(
      main.frames.filter((frame) => !frame.detached).map((frame) => frame.frameTreeNodeId)
    );
    for (const id of frameNames.keys()) if (!liveIds.has(id)) frameNames.delete(id);
    let outer = contents.focusedFrame;
    if (!outer || outer.detached || outer.frameTreeNodeId === main.frameTreeNodeId) return;
    while (outer.parent && outer.parent.frameTreeNodeId !== main.frameTreeNodeId) {
      outer = outer.parent;
      if (outer.detached) return;
    }
    if (outer.parent?.frameTreeNodeId !== main.frameTreeNodeId) return;
    const frameName = frameNames.get(outer.frameTreeNodeId);
    if (!frameName) return;
    event.preventDefault();
    sendRendererIpc(contents, 'window:frame-tab-navigation', {
      frameName,
      direction: key.shift ? -1 : 1,
    });
  };
  for (const frame of contents.mainFrame.frames) rememberFrame(frame);
  contents.on('frame-created', created);
  contents.on('before-input-event', input);
  window.once('closed', () => {
    frameNames.clear();
    contents.removeListener('frame-created', created);
    contents.removeListener('before-input-event', input);
  });
}

import { BrowserWindow } from 'electron';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { handleGroup, sendRendererIpc } from '../shared/ipc-contract';
import { sequenceWheelContract } from '../shared/ipc/sequence-wheel.contract';
import {
  browserWheelInput,
  type SequenceWheelZoomRegion,
} from '../shared/sequence-wheel-ownership';

interface NativeSequenceWheel {
  trackWindow(handle: Buffer): number;
  setZoomRegion(token: number, regions: SequenceWheelZoomRegion[]): void;
  removeWindow(token: number): void;
  setMouseHandler(
    handler: (
      token: number,
      x: number,
      y: number,
      deltaX: number,
      deltaY: number,
      modifiers: number,
      precise: boolean,
      phase: number,
      momentumPhase: number,
      ordinal: number
    ) => boolean
  ): void;
}

let native: NativeSequenceWheel | null = null;
const windows = new Map<number, number>();
const mouseWindows = new Map<number, BrowserWindow>();

export function installSequenceWheelOwnership(window: BrowserWindow): void {
  if (process.platform !== 'darwin') return;
  if (!native) {
    const requireNative = createRequire(import.meta.url);
    native = requireNative(
      join(__dirname, 'binaries', `sequence-wheel-${process.arch}.node`)
    ) as NativeSequenceWheel;
    native.setMouseHandler(
      (token, x, y, deltaX, deltaY, modifiers, precise, phase, momentumPhase, ordinal) => {
        const target = mouseWindows.get(token);
        if (!target || target.isDestroyed() || target.webContents.isDestroyed()) return false;
        try {
          sendRendererIpc(target.webContents, 'sequenceWheel:mouse', {
            x,
            y,
            deltaX,
            deltaY,
            ctrlKey: (modifiers & (1 << 18)) !== 0,
            metaKey: (modifiers & (1 << 20)) !== 0,
            shiftKey: (modifiers & (1 << 17)) !== 0,
            altKey: (modifiers & (1 << 19)) !== 0,
            precise,
            phase,
            momentumPhase,
            ordinal,
          });
          return true;
        } catch {
          return false;
        }
      }
    );
    handleGroup(sequenceWheelContract, {
      setZoomRegions: (event, regions) => {
        const token = windows.get(event.sender.id);
        if (token === undefined || !native) return;
        if (
          !Array.isArray(regions) ||
          regions.length > 128 ||
          regions.some(
            (region) =>
              !region ||
              ![region.x, region.y, region.width, region.height].every(Number.isFinite) ||
              region.width <= 0 ||
              region.height <= 0
          )
        )
          return;
        native.setZoomRegion(token, regions);
      },
      returnMouseWheel: (event, packet) => {
        if (!windows.has(event.sender.id) || event.sender.isDestroyed()) return;
        const input = browserWheelInput(packet);
        if (input) event.sender.sendInputEvent(input);
      },
    });
  }
  const webContentsId = window.webContents.id;
  const token = native.trackWindow(window.getNativeWindowHandle());
  windows.set(webContentsId, token);
  mouseWindows.set(token, window);
  window.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
    if (isMainFrame) native?.setZoomRegion(token, []);
  });
  window.once('closed', () => {
    windows.delete(webContentsId);
    mouseWindows.delete(token);
    native?.removeWindow(token);
  });
}

import { BrowserWindow } from 'electron';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { sendRendererIpc } from '../shared/ipc-contract';

interface NativeSequenceWheel {
  trackWindow(handle: Buffer): number;
  removeWindow(token: number): void;
  setMouseHandler(
    handler: (
      token: number,
      precise: boolean,
      phase: number,
      momentumPhase: number,
      ordinal: number,
      timestamp: number
    ) => void
  ): void;
}

let native: NativeSequenceWheel | null = null;
const windows = new Map<number, BrowserWindow>();

export function installSequenceWheelMetadata(window: BrowserWindow): void {
  if (process.platform !== 'darwin') return;
  if (!native) {
    native = createRequire(import.meta.url)(
      join(__dirname, 'binaries', `sequence-wheel-${process.arch}.node`)
    ) as NativeSequenceWheel;
    native.setMouseHandler((token, precise, phase, momentumPhase, ordinal, timestamp) => {
      const target = windows.get(token);
      if (!target || target.isDestroyed() || target.webContents.isDestroyed()) return;
      sendRendererIpc(target.webContents, 'sequenceWheel:metadata', {
        precise,
        phase,
        momentumPhase,
        ordinal,
        timestamp,
      });
    });
  }
  const token = native.trackWindow(window.getNativeWindowHandle());
  windows.set(token, window);
  window.once('closed', () => {
    windows.delete(token);
    native?.removeWindow(token);
  });
}

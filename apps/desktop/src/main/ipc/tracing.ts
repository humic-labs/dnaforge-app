import { handleGroup } from '../../shared/ipc-contract';

import { BrowserWindow, app } from 'electron';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tracingContract } from '../../shared/ipc/tracing.contract';

type ActiveSession = {
  window: BrowserWindow;
  startedAt: number;
  samplingIntervalUs: number;
};

let active: ActiveSession | null = null;

function getTargetWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused) return focused;
  const all = BrowserWindow.getAllWindows();
  return all[0] ?? null;
}

export function registerTracingHandlers(): void {
  handleGroup(tracingContract, {
    profilerStart: async (_event, opts?: { samplingIntervalUs?: number }) => {
      if (active) {
        return { ok: false, error: 'Profile already running. Stop it first.' };
      }
      const win = getTargetWindow();
      if (!win) return { ok: false, error: 'No browser window.' };

      const samplingIntervalUs = opts?.samplingIntervalUs ?? 100;

      try {
        if (!win.webContents.debugger.isAttached()) {
          win.webContents.debugger.attach('1.3');
        }
        await win.webContents.debugger.sendCommand('Profiler.enable');
        await win.webContents.debugger.sendCommand('Profiler.setSamplingInterval', {
          interval: samplingIntervalUs,
        });
        await win.webContents.debugger.sendCommand('Profiler.start');
        active = { window: win, startedAt: Date.now(), samplingIntervalUs };
        console.log(`[tracing] CPU profiler started (sampling every ${samplingIntervalUs}μs)`);
        return { ok: true };
      } catch (err) {
        console.error('[tracing] Failed to start profiler', err);
        try {
          if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach();
        } catch {}
        active = null;
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    profilerStop: async () => {
      if (!active) return { ok: false, error: 'No profile running.' };
      const session = active;
      active = null;
      try {
        const result = (await session.window.webContents.debugger.sendCommand('Profiler.stop')) as {
          profile: unknown;
        };

        const outDir = join(app.getPath('userData'), 'snapshots');
        await mkdir(outDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
        const filePath = join(outDir, `cpu-profile-${stamp}.cpuprofile`);
        await writeFile(filePath, JSON.stringify(result.profile), 'utf8');

        try {
          await session.window.webContents.debugger.sendCommand('Profiler.disable');
        } catch {}
        try {
          if (session.window.webContents.debugger.isAttached())
            session.window.webContents.debugger.detach();
        } catch {}

        const durationMs = Date.now() - session.startedAt;
        console.log(`[tracing] CPU profile saved (${durationMs}ms of samples) → ${filePath}`);
        return { ok: true, filePath, durationMs };
      } catch (err) {
        console.error('[tracing] Failed to stop profiler', err);
        try {
          if (session.window.webContents.debugger.isAttached())
            session.window.webContents.debugger.detach();
        } catch {}
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    profilerIsActive: () => ({ active: !!active }),
  });
}

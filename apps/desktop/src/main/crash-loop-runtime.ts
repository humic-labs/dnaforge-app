import { app, BrowserWindow } from 'electron';
import { readFileSync } from 'node:fs';
import { trackAllowedEvent } from './analytics';
import { createCrashLoopBreaker, type ProcessExit } from './crash-loop-breaker';

const recoveryUrl =
  'data:text/html;charset=utf-8,' +
  encodeURIComponent(
    '<!doctype html><meta charset="utf-8"><title>DNAForge Safe Mode</title><main><h1>DNAForge is in safe mode</h1><p>Repeated process crashes were detected. The compute sidecar is stopped. Quit and reopen DNAForge to try again. Your saved files are preserved.</p></main>'
  );
const listeners = new Set<() => void>();
export const crashLoopBreaker = createCrashLoopBreaker(
  (event, details) => {
    if (event === 'crash_loop_detected') {
      trackAllowedEvent(event, { feature_area: 'reliability', ...exitTelemetry(details) });
    }
  },
  () => {
    for (const listener of listeners) listener();
    for (const win of BrowserWindow.getAllWindows()) showCrashRecovery(win);
  }
);

export function onCrashLoop(listener: () => void): void {
  listeners.add(listener);
}

export function showCrashRecovery(win: BrowserWindow): void {
  if (!win.isDestroyed()) void win.loadURL(recoveryUrl).catch(() => undefined);
}

const memorySamples = new Map<
  number,
  { memory: number; startedAt: number; type: string; sampledAt: number }
>();
const watchedProcesses = new Map<number, number>();

export function watchProcessMemory(pid: number | undefined, startedAt = Date.now()): void {
  if (pid) {
    memorySamples.delete(pid);
    watchedProcesses.set(pid, startedAt);
  }
}

export function sampleProcessMemory(): void {
  for (const [pid, sample] of memorySamples) {
    if (Date.now() - sample.sampledAt > 300_000) memorySamples.delete(pid);
  }
  for (const metric of app.getAppMetrics()) {
    memorySamples.set(metric.pid, {
      memory: metric.memory.workingSetSize,
      startedAt: metric.creationTime,
      type: metric.type,
      sampledAt: Date.now(),
    });
  }
  if (process.platform !== 'linux') return;
  for (const [pid, startedAt] of watchedProcesses) {
    try {
      const rss = readFileSync(`/proc/${pid}/status`, 'utf8').match(/^VmRSS:\s+(\d+)/m);
      if (rss)
        memorySamples.set(pid, {
          memory: Number(rss[1]),
          startedAt,
          type: 'sidecar',
          sampledAt: Date.now(),
        });
    } catch {
      watchedProcesses.delete(pid);
    }
  }
}

export function processExitSnapshot(pid?: number, startedAt?: number, processType?: string) {
  const metrics = app.getAppMetrics();
  if (!pid && processType) {
    const exited = [...memorySamples].filter(
      ([samplePid, sample]) =>
        sample.type === processType && !metrics.some((entry) => entry.pid === samplePid)
    );
    if (exited.length === 1) pid = exited[0]?.[0];
    else {
      const matching = metrics.filter((entry) => entry.type === processType);
      if (matching.length === 1) pid = matching[0]?.pid;
    }
  }
  const metric = pid ? metrics.find((entry) => entry.pid === pid) : undefined;
  const sample = pid ? memorySamples.get(pid) : undefined;
  const createdAt = metric?.creationTime ?? sample?.startedAt ?? startedAt;
  return {
    process_memory: metric?.memory.workingSetSize ?? sample?.memory ?? null,
    uptime_ms: createdAt === undefined ? null : Math.max(0, Date.now() - createdAt),
  };
}

export function exitTelemetry(details: ProcessExit) {
  return {
    reason: details.reason.replaceAll('_', '-'),
    exit_code: details.exitCode ?? 'unavailable',
    ...(details.signal ? { exit_signal: details.signal.toLowerCase() } : {}),
    process_memory: details.process_memory ?? 'unavailable',
    uptime_ms: details.uptime_ms === null ? 'unavailable' : Math.round(details.uptime_ms),
  };
}

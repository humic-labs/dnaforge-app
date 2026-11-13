import { crashLoopBreaker, processExitSnapshot, sampleProcessMemory } from './crash-loop-runtime';
import { app, BrowserWindow, powerMonitor, type WebContents } from 'electron';
import {
  touchAppSessionMarker,
  trackActivityHeartbeat,
  trackChildProcessGone,
  trackStartupTimed,
} from './analytics';

const SAMPLE_MS = 60_000;
const SAMPLES_PER_REPORT = 15;
const ACTIVE_IDLE_SECONDS = 60;
const BYTES_PER_MB = 1024 * 1024;
const KB_PER_MB = 1024;

export interface ActivitySample {
  focused: boolean;
  idleSeconds: number;
}

export interface ProcessMemory {
  type: string;
  workingSetKb: number;
}

export interface ActivityReport {
  intervalMinutes: number;
  activeMinutes: number;
  focusedMinutes: number;
  mainHeapMb: number;
  appMemoryMb: number;
  rendererMemoryMb: number;
  gpuMemoryMb: number;
}

export function createActivityAccumulator(samplesPerReport = SAMPLES_PER_REPORT) {
  let samples = 0;
  let active = 0;
  let focused = 0;
  return {
    sample(
      input: ActivitySample,
      readMemory: () => { mainHeapBytes: number; processes: ProcessMemory[] }
    ): ActivityReport | null {
      samples += 1;
      if (input.focused) focused += 1;
      if (input.focused && input.idleSeconds < ACTIVE_IDLE_SECONDS) active += 1;
      if (samples < samplesPerReport) return null;
      const memory = readMemory();
      const sumMb = (types: string[] | null) =>
        Math.round(
          memory.processes
            .filter((process) => types === null || types.includes(process.type))
            .reduce((total, process) => total + process.workingSetKb, 0) / KB_PER_MB
        );
      const report = {
        intervalMinutes: samples,
        activeMinutes: active,
        focusedMinutes: focused,
        mainHeapMb: Math.round(memory.mainHeapBytes / BYTES_PER_MB),
        appMemoryMb: sumMb(null),
        rendererMemoryMb: sumMb(['Tab']),
        gpuMemoryMb: sumMb(['GPU']),
      };
      samples = 0;
      active = 0;
      focused = 0;
      return report;
    },
  };
}

export function installAppHealthTelemetry(mainContents: () => WebContents | undefined): () => void {
  app.on('child-process-gone', (_event, details) => {
    const exit = {
      ...details,
      process_type: details.type,
      ...processExitSnapshot(undefined, undefined, details.type),
    };
    crashLoopBreaker.record(exit);
    trackChildProcessGone({
      ...exit,
      processType: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
    });
  });
  app.on('render-process-gone', (_event, contents, details) => {
    if (contents === mainContents()) return;
    const exit = {
      ...details,
      process_type: 'renderer',
      ...processExitSnapshot(contents.getOSProcessId(), undefined, 'Tab'),
    };
    crashLoopBreaker.record(exit);
    trackChildProcessGone({
      ...exit,
      processType: 'renderer',
      reason: details.reason,
      exitCode: details.exitCode,
    });
  });

  sampleProcessMemory();
  const memoryTimer = setInterval(sampleProcessMemory, 5000);
  memoryTimer.unref?.();
  const accumulator = createActivityAccumulator();
  const timer = setInterval(() => {
    touchAppSessionMarker();
    const report = accumulator.sample(
      {
        focused: BrowserWindow.getFocusedWindow() !== null,
        idleSeconds: powerMonitor.getSystemIdleTime(),
      },
      () => ({
        mainHeapBytes: process.memoryUsage().heapUsed,
        processes: app
          .getAppMetrics()
          .map((metric) => ({ type: metric.type, workingSetKb: metric.memory.workingSetSize })),
      })
    );
    if (report) trackActivityHeartbeat(report);
  }, SAMPLE_MS);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    clearInterval(memoryTimer);
  };
}

export function createStartupClock(
  now: () => number = Date.now,
  processStartedAtMs = now() - process.uptime() * 1000
) {
  let readyAtMs: number | null = null;
  let windowAtMs: number | null = null;
  let reported = false;
  return {
    appReady(): void {
      readyAtMs ??= now();
    },
    windowCreated(): void {
      windowAtMs ??= now();
    },
    shellReady(): void {
      if (reported || readyAtMs === null || windowAtMs === null) return;
      reported = true;
      trackStartupTimed({
        readyMs: readyAtMs - processStartedAtMs,
        windowMs: windowAtMs - processStartedAtMs,
        shellReadyMs: now() - processStartedAtMs,
      });
    },
  };
}

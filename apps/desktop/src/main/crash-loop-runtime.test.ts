import { describe, expect, it, vi } from 'vitest';

const telemetry = vi.hoisted(() => vi.fn());
const loadURL = vi.hoisted(() => vi.fn(async (_url: string) => undefined));
const metrics = vi.hoisted(() =>
  vi.fn(() => [
    { type: 'Tab', pid: 42, creationTime: Date.now() - 1000, memory: { workingSetSize: 1234 } },
  ])
);
vi.mock('electron', () => ({
  app: { getAppMetrics: metrics },
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, loadURL }] },
}));
vi.mock('./analytics', () => ({ trackAllowedEvent: telemetry }));

import {
  crashLoopBreaker,
  exitTelemetry,
  onCrashLoop,
  processExitSnapshot,
  sampleProcessMemory,
} from './crash-loop-runtime';

describe('crash loop runtime', () => {
  it('retains the last renderer memory sample when the process has exited', () => {
    sampleProcessMemory();
    metrics.mockReturnValueOnce([]);
    expect(processExitSnapshot(42)).toMatchObject({ process_memory: 1234 });
  });

  it('stops the supervisor and opens recovery once for three renderer kills', () => {
    const stop = vi.fn();
    onCrashLoop(stop);
    const exit = {
      process_type: 'renderer',
      reason: 'killed',
      exitCode: 137,
      signal: 'SIGKILL',
      process_memory: null,
      uptime_ms: 1000,
    };
    for (const now of [0, 60_000, 120_000, 130_000]) crashLoopBreaker.record(exit, now);
    expect(telemetry).toHaveBeenCalledExactlyOnceWith('crash_loop_detected', {
      feature_area: 'reliability',
      ...exitTelemetry(exit),
    });
    expect(stop).toHaveBeenCalledOnce();
    expect(loadURL).toHaveBeenCalledOnce();
    expect(decodeURIComponent(loadURL.mock.calls[0]?.[0] ?? '')).toContain(
      'DNAForge is in safe mode'
    );
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const trackStartupTimed = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  app: { on: vi.fn(), getAppMetrics: vi.fn(() => []) },
  BrowserWindow: { getFocusedWindow: vi.fn(() => null) },
  powerMonitor: { getSystemIdleTime: vi.fn(() => 0) },
}));
vi.mock('./analytics', () => ({
  touchAppSessionMarker: vi.fn(),
  trackActivityHeartbeat: vi.fn(),
  trackChildProcessGone: vi.fn(),
  trackStartupTimed,
}));

import { createActivityAccumulator, createStartupClock } from './app-health-telemetry';

describe('activity accumulator', () => {
  const memory = () => ({
    mainHeapBytes: 150 * 1024 * 1024,
    processes: [
      { type: 'Browser', workingSetKb: 200 * 1024 },
      { type: 'Tab', workingSetKb: 600 * 1024 },
      { type: 'Tab', workingSetKb: 100 * 1024 },
      { type: 'GPU', workingSetKb: 300 * 1024 },
    ],
  });

  it('counts focused and recently used minutes and reports memory once per interval', () => {
    const accumulator = createActivityAccumulator(4);
    expect(accumulator.sample({ focused: true, idleSeconds: 5 }, memory)).toBeNull();
    expect(accumulator.sample({ focused: true, idleSeconds: 600 }, memory)).toBeNull();
    expect(accumulator.sample({ focused: false, idleSeconds: 1 }, memory)).toBeNull();
    expect(accumulator.sample({ focused: true, idleSeconds: 59 }, memory)).toEqual({
      intervalMinutes: 4,
      activeMinutes: 2,
      focusedMinutes: 3,
      mainHeapMb: 150,
      appMemoryMb: 1200,
      rendererMemoryMb: 700,
      gpuMemoryMb: 300,
    });
  });

  it('starts a fresh interval after each report', () => {
    const accumulator = createActivityAccumulator(2);
    accumulator.sample({ focused: true, idleSeconds: 0 }, memory);
    accumulator.sample({ focused: true, idleSeconds: 0 }, memory);
    accumulator.sample({ focused: false, idleSeconds: 0 }, memory);
    expect(accumulator.sample({ focused: false, idleSeconds: 0 }, memory)).toMatchObject({
      intervalMinutes: 2,
      activeMinutes: 0,
      focusedMinutes: 0,
    });
  });
});

describe('startup clock', () => {
  beforeEach(() => trackStartupTimed.mockClear());

  it('reports process-relative launch phases once, at the first usable shell', () => {
    let now = 1_000;
    const clock = createStartupClock(() => now, 0);
    now = 1_400;
    clock.appReady();
    now = 2_100;
    clock.windowCreated();
    now = 3_900;
    clock.shellReady();
    now = 9_000;
    clock.shellReady();
    expect(trackStartupTimed).toHaveBeenCalledOnce();
    expect(trackStartupTimed).toHaveBeenCalledWith({
      readyMs: 1_400,
      windowMs: 2_100,
      shellReadyMs: 3_900,
    });
  });

  it('waits until both earlier phases are known', () => {
    const clock = createStartupClock(() => 10, 0);
    clock.shellReady();
    clock.appReady();
    clock.shellReady();
    expect(trackStartupTimed).not.toHaveBeenCalled();
    clock.windowCreated();
    clock.shellReady();
    expect(trackStartupTimed).toHaveBeenCalledOnce();
  });
});

import { app, type BrowserWindow } from 'electron';
import { handleGroup, sendRendererIpc } from '../../shared/ipc-contract';
import { runtimeContract } from '../../shared/ipc/runtime.contract';
import { runtimeMemoryPressureOverrideContract } from '../../shared/ipc/runtime-memory-pressure-override.contract';
import type { MemoryPressureLevel } from '../../shared/memory-pressure';
import type { ResourcePressureSnapshot } from '../../shared/resource-pressure';
import { MemoryPressureMonitor } from '../memory-pressure/monitor';
import { readCurrentThreadScheduling } from '../thread-scheduling.cjs';

const FORCEABLE_LEVELS: ReadonlySet<MemoryPressureLevel> = new Set([
  'normal',
  'moderate',
  'critical',
]);

let monitor: MemoryPressureMonitor | null = null;
let unsubscribe: (() => void) | null = null;
let disposeHandlers: (() => void) | null = null;

export function registerMemoryPressureHandlers(getWindow: () => BrowserWindow | null): void {
  monitor ??= new MemoryPressureMonitor();
  const active = monitor;
  disposeHandlers?.();
  const disposeSample = handleGroup(runtimeContract, {
    sampleMemoryPressure: () => active.sample(),
    sampleResourcePressure: async (): Promise<ResourcePressureSnapshot> => {
      const memory = await active.sample();
      return {
        schemaVersion: 2,
        memoryPressure: memory.level,
        cpuUsage: null,
        concurrency: null,
        active: null,
        queued: null,
        automaticWork: { admission: 'owner-managed', cpuThrottling: false },
        mainThreadScheduling: readCurrentThreadScheduling(),
        sampledAt: Date.now(),
      };
    },
  });
  const disposeOverride = app.isPackaged
    ? null
    : handleGroup(runtimeMemoryPressureOverrideContract, {
        forceMemoryPressure: (_event, level: MemoryPressureLevel | null) => {
          if (level !== null && !FORCEABLE_LEVELS.has(level)) {
            throw new Error(`Unknown memory pressure level: ${String(level)}`);
          }
          return active.force(level);
        },
      });
  disposeHandlers = () => {
    disposeSample();
    disposeOverride?.();
  };
  unsubscribe?.();
  unsubscribe = active.onChange((snapshot) => {
    const window = getWindow();
    if (window && !window.isDestroyed()) {
      sendRendererIpc(window.webContents, 'runtime:memoryPressureChanged', snapshot);
    }
  });
  active.start();
}

export function stopMemoryPressureMonitor(): void {
  unsubscribe?.();
  unsubscribe = null;
  monitor?.stop();
}

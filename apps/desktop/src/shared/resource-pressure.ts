import type { MemoryPressureLevel } from './memory-pressure';
import type { ThreadSchedulingObservation } from './thread-scheduling';

export interface ResourcePressureSnapshot {
  schemaVersion: 2;
  memoryPressure: MemoryPressureLevel;
  cpuUsage: null;
  concurrency: null;
  active: null;
  queued: null;
  automaticWork: {
    admission: 'owner-managed';
    cpuThrottling: false;
  } | null;
  mainThreadScheduling: ThreadSchedulingObservation | null;
  sampledAt: number;
}

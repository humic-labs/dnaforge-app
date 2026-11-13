import type { MemoryPressureSnapshot } from './memory-pressure';
import type { ResourcePressureSnapshot } from './resource-pressure';

export const unavailableMemoryPressure = {
  sampleResourcePressure: async (): Promise<ResourcePressureSnapshot> => ({
    schemaVersion: 2,
    memoryPressure: 'unknown',
    cpuUsage: null,
    concurrency: null,
    active: null,
    queued: null,
    automaticWork: null,
    mainThreadScheduling: null,
    sampledAt: Date.now(),
  }),
  sampleMemoryPressure: async (): Promise<MemoryPressureSnapshot> => ({
    level: 'unknown',
    source: 'unavailable',
    sampledAt: Date.now(),
  }),
  onMemoryPressureChanged: (): (() => void) => () => {},
  forceMemoryPressure: async (): Promise<MemoryPressureSnapshot> => ({
    level: 'unknown',
    source: 'unavailable',
    sampledAt: Date.now(),
  }),
};

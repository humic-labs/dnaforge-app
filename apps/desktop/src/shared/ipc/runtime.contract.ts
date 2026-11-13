import type { MemoryPressureSnapshot } from '../memory-pressure';
import type { ResourcePressureSnapshot } from '../resource-pressure';
import { defineGroup, event, invoke } from './contract';

export const runtimeContract = defineGroup('runtime', {
  sampleMemoryPressure: invoke<[], MemoryPressureSnapshot>(),
  sampleResourcePressure: invoke<[], ResourcePressureSnapshot>(),
  onMemoryPressureChanged: event<[snapshot: MemoryPressureSnapshot]>().channel(
    'runtime:memoryPressureChanged'
  ),
});

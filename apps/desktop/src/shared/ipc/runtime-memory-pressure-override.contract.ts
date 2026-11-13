import type { MemoryPressureLevel, MemoryPressureSnapshot } from '../memory-pressure';
import { defineGroup, invoke } from './contract';

export const runtimeMemoryPressureOverrideContract = defineGroup('runtime', {
  forceMemoryPressure: invoke<[level: MemoryPressureLevel | null], MemoryPressureSnapshot>(),
});

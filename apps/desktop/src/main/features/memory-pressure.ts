import { registerMemoryPressureHandlers } from '../ipc/memory-pressure';
import type { MainFeature } from './main-feature';

export const memoryPressureFeature: MainFeature = {
  id: 'memory-pressure',
  onMainWindow: (_window, context) => registerMemoryPressureHandlers(context.getMainWindow),
};

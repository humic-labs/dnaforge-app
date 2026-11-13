import { registerAuthHandlers } from '../ipc/auth';
import type { MainFeature } from './main-feature';

export const authFeature: MainFeature = {
  id: 'auth',
  onMainWindow: (_window, context) => registerAuthHandlers(context.getMainWindow),
};

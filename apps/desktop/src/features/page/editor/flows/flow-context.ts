import { createContext, useContext } from 'react';
import type { FlowManagerContextValue } from './types';

export const FlowManagerContext = createContext<FlowManagerContextValue | null>(null);

export function useFlowManager(): FlowManagerContextValue {
  const context = useContext(FlowManagerContext);
  if (!context) {
    throw new Error('useFlowManager must be used within FlowManagerProvider');
  }
  return context;
}

import { createContext, useContext } from 'react';
import type { HiddenMapIdlePolicy } from './types';

export const HiddenMapIdlePolicyContext = createContext<HiddenMapIdlePolicy | null>(null);

export function useHiddenMapIdlePolicy(fallback: HiddenMapIdlePolicy): HiddenMapIdlePolicy {
  return useContext(HiddenMapIdlePolicyContext) ?? fallback;
}

import { useEffect } from 'react';
import { applyNativeChainVisibility } from '../molstar/chainVisibility';
import { observeStructureColorChanges } from '../molstar/structureColors';

export function useNativeChainVisibility(
  plugin: unknown,
  loaded: boolean,
  hiddenChainInstanceIds: readonly string[] | undefined
): void {
  const signature = hiddenChainInstanceIds?.join('|') ?? '';
  useEffect(() => {
    if (!plugin || !loaded) return;
    const hidden = signature ? signature.split('|') : [];
    const apply = () => applyNativeChainVisibility(plugin, hidden);
    const unsubscribe = observeStructureColorChanges(plugin, apply);
    apply();
    return unsubscribe;
  }, [plugin, loaded, signature]);
}

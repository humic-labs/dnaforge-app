import { getMountedCommandRegistry } from '../../commands/mounted-command-registry';
import { COMMAND_IDS, COMMAND_SCOPES } from '../../commands/types';
import { requestRegistryOpen } from '../../shared/registry-events';
import { useLimsOverlayStore } from './lims-overlay-store';

export type RegistryPresentationResult = Readonly<{
  entityId: string;
  status: 'presented' | 'failed' | 'superseded' | 'timeout';
}>;

export function presentRegistryEntity(
  input: { entityId: string; fallbackSearch: string },
  timeoutMs = 5_000
): Promise<RegistryPresentationResult> {
  const requestId = useLimsOverlayStore
    .getState()
    .requestRegistryEntity(input.entityId, input.fallbackSearch);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (status: RegistryPresentationResult['status']) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      clearTimeout(timer);
      resolve({ entityId: input.entityId, status });
    };
    const inspect = () => {
      const current = useLimsOverlayStore.getState().registryRequestResult;
      if (!current || current.requestId !== requestId || current.entityId !== input.entityId)
        return finish('superseded');
      if (current.status !== 'pending') finish(current.status);
    };
    const unsubscribe = useLimsOverlayStore.subscribe(inspect);
    const timer = setTimeout(() => {
      finish('timeout');
      useLimsOverlayStore.getState().supersedeRegistryRequest(requestId);
    }, timeoutMs);
    try {
      requestRegistryOpen();
      inspect();
    } catch {
      finish('failed');
      useLimsOverlayStore.getState().supersedeRegistryRequest(requestId);
    }
  });
}

export async function navigateToRegistryEntity(input: {
  entityId: string;
  fallbackSearch: string;
}): Promise<
  RegistryPresentationResult | { entityId: string; status: 'app-not-ready' | 'blocked' }
> {
  const registry = getMountedCommandRegistry();
  if (!registry) return { entityId: input.entityId, status: 'app-not-ready' };
  const receipt = registry.dispatchCommand(COMMAND_IDS.appShowRegistry, {
    source: 'agent',
    bypassBlockingScopes: [COMMAND_SCOPES.inputEditor],
  });
  if (!receipt.handled) return { entityId: input.entityId, status: 'blocked' };
  return presentRegistryEntity(input);
}

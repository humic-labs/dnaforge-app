import type { ManagedOperationsRuntimeSource } from '../services/managed-operations';
import { hostedDurableSync, hostedWorkspaceSessionController } from './controller';
import { createHostedAcceptedInputResolver } from './managed-operation-input';
import { parseHostedFsPath } from './paths';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createHostedManagedOperationsRuntimeSource(
  workspaceId: string,
  origin = window.location.origin
): ManagedOperationsRuntimeSource {
  if (!UUID_PATTERN.test(workspaceId)) {
    throw new Error('Hosted managed operations require a valid workspace identity');
  }
  const parsedOrigin = new URL(origin);
  if (!['http:', 'https:'].includes(parsedOrigin.protocol) || parsedOrigin.origin !== origin) {
    throw new Error('Hosted managed operations require an HTTP(S) origin');
  }
  const baseUrl = `${parsedOrigin.origin}/api/hosted-operations/${workspaceId}`;

  const inputAuthority = {
    getState: hostedWorkspaceSessionController.getState,
    flush: hostedDurableSync.flush,
    subscribe: hostedDurableSync.subscribe,
    load: (accountId: string, id: string) => hostedDurableSync.store.load(accountId, id),
  };
  const prepareAcceptedInput = createHostedAcceptedInputResolver(workspaceId, inputAuthority);
  const preparePublicationBase = createHostedAcceptedInputResolver(workspaceId, inputAuthority, {
    requireSettledWorkspace: true,
  });
  return {
    prepareAcceptedInput,
    async publishWorkspaceResult(result) {
      const accountId = hostedWorkspaceSessionController.getState().principal?.id;
      const location = parseHostedFsPath(result.path);
      if (location?.workspaceId !== workspaceId || !location.relativePath) {
        throw new Error('The result does not belong to this project.');
      }
      const source = await preparePublicationBase([{ key: 'output', path: result.path }]);
      await hostedWorkspaceSessionController.refreshActiveWorkspace();
      const state = hostedWorkspaceSessionController.getState();
      if (
        !accountId ||
        state.principal?.id !== accountId ||
        state.activeWorkspaceId !== workspaceId ||
        state.snapshot?.revisionId !== source.version_id
      ) {
        throw new Error(
          'The account or project changed before result attachment. The job result is retained.'
        );
      }
      await hostedWorkspaceSessionController.commit(
        [
          {
            path: location.relativePath,
            bytes: new TextEncoder().encode(result.content),
            contentType: 'application/json',
            resourceId: source.files[0].resource_id,
          },
        ],
        undefined,
        undefined,
        {
          kind: 'managed-operation-result',
          operationId: result.operationId,
          inputRevision: result.inputRevision,
          baseRevisionId: source.version_id,
          outputPath: location.relativePath,
        }
      );
      if (hostedWorkspaceSessionController.getState().principal?.id !== accountId) {
        throw new Error(
          'The account changed while the result was attached. Check the original project before retrying.'
        );
      }
    },
    async getStatus() {
      return 'ready';
    },
    async getBaseUrl() {
      return baseUrl;
    },
    subscribeStatus() {
      return () => undefined;
    },
  };
}

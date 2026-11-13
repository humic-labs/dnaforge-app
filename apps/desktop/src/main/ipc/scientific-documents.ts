import { scientificDocumentsContract } from '../../shared/ipc/scientific-documents.contract';
import { handleGroup } from '../../shared/ipc-contract';
import { scientificDocumentFailure } from '@waypoint/domain-services';
import type { DesktopScientificDocumentCancelRequest } from '../../shared/scientific-document-ipc';
import { getDb } from './database';
import {
  readScientificDocumentInMain,
  resolveMainWorkspaceIdentity as resolveIdentity,
} from '../scientific-document-reader';
export { readScientificDocumentInMain } from '../scientific-document-reader';
export function resolveMainWorkspaceIdentity(
  root: string,
  database: Parameters<typeof resolveIdentity>[1] = getDb()
): string | null {
  return resolveIdentity(root, database);
}
export function registerScientificDocumentHandlers(): void {
  const operations = new Map<string, AbortController>();
  const operationKey = (senderId: number, operationId: string): string =>
    `${senderId}:${operationId}`;

  handleGroup(scientificDocumentsContract, {
    read: async (event, request) => {
      const key = operationKey(event.sender.id, request.operationId);
      if (operations.has(key)) {
        return scientificDocumentFailure(
          'SERVICE_UNAVAILABLE',
          'Scientific document operation is already active.'
        );
      }
      const controller = new AbortController();
      operations.set(key, controller);
      try {
        const owningWorkspace = resolveMainWorkspaceIdentity(request.workspaceRoot);
        if (!owningWorkspace || owningWorkspace !== request.workspace) {
          return scientificDocumentFailure(
            'ACCESS_DENIED',
            'Scientific document request does not match the owning workspace.'
          );
        }
        return await readScientificDocumentInMain(request, {
          signal: controller.signal,
          database: getDb(),
        });
      } catch {
        return scientificDocumentFailure(
          'SERVICE_UNAVAILABLE',
          'The local scientific document service is unavailable.'
        );
      } finally {
        operations.delete(key);
      }
    },
    cancelRead: (event, request: DesktopScientificDocumentCancelRequest) => {
      operations.get(operationKey(event.sender.id, request.operationId))?.abort();
    },
  });
}

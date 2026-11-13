import {
  parseScientificDocumentIdentity,
  parseWorkspaceIdentity,
  scientificDocumentFailure,
  type ScientificDocumentReadResult,
  type ScientificDocumentReader,
  type WorkspaceIdentity,
} from '@waypoint/domain-services';
import { resolveWorkspaceScope } from '../../../db/workspace-catalog';
import { platform } from '../../../platform';

interface DesktopScientificDocumentTransport {
  read: PlatformBridgeScientificDocuments['read'];
  cancelRead: PlatformBridgeScientificDocuments['cancelRead'];
}

type PlatformBridgeScientificDocuments = ReturnType<typeof platform>['scientificDocuments'];

export interface DesktopScientificDocumentReaderOptions {
  readonly workspaceRoot: string;
  readonly workspace: WorkspaceIdentity;
  readonly transport?: DesktopScientificDocumentTransport;
  readonly operationId?: () => string;
  readonly acceptedHead?: string;
}

export function createDesktopScientificDocumentReader(
  options: DesktopScientificDocumentReaderOptions
): ScientificDocumentReader {
  const transport = options.transport ?? platform().scientificDocuments;
  const operationId = options.operationId ?? (() => globalThis.crypto.randomUUID());
  return {
    async read(request): Promise<ScientificDocumentReadResult> {
      if (request.workspace !== options.workspace) {
        return scientificDocumentFailure(
          'ACCESS_DENIED',
          'Scientific document request does not match the owning project.'
        );
      }
      if (request.signal?.aborted) {
        return scientificDocumentFailure('CANCELLED', 'Scientific document read was cancelled.');
      }
      const currentOperationId = operationId();
      const cancel = (): void => {
        void transport.cancelRead({ operationId: currentOperationId });
      };
      request.signal?.addEventListener('abort', cancel, { once: true });
      try {
        return await transport.read({
          operationId: currentOperationId,
          workspaceRoot: options.workspaceRoot,
          workspace: request.workspace,
          document: request.document,
          ...(options.acceptedHead ? { acceptedHead: options.acceptedHead } : {}),
        });
      } catch {
        return request.signal?.aborted
          ? scientificDocumentFailure('CANCELLED', 'Scientific document read was cancelled.')
          : scientificDocumentFailure(
              'SERVICE_UNAVAILABLE',
              'The local scientific document service is unavailable.'
            );
      } finally {
        request.signal?.removeEventListener('abort', cancel);
      }
    },
  };
}

export async function readDesktopScientificDocument(input: {
  readonly filePath: string;
  readonly workspaceRoot: string;
  readonly signal?: AbortSignal;
  readonly resolveScope?: typeof resolveWorkspaceScope;
  readonly transport?: DesktopScientificDocumentTransport;
  readonly operationId?: () => string;
  readonly acceptedHead?: string;
}): Promise<ScientificDocumentReadResult> {
  const documentPath = workspaceRelativePath(input.workspaceRoot, input.filePath);
  if (!documentPath) {
    return scientificDocumentFailure(
      'ACCESS_DENIED',
      'Scientific document is outside the owning project.'
    );
  }
  const scope = await (input.resolveScope ?? resolveWorkspaceScope)(input.workspaceRoot);
  if (!scope) {
    return scientificDocumentFailure(
      'SERVICE_UNAVAILABLE',
      'The owning project identity is unavailable.'
    );
  }
  const workspace = parseWorkspaceIdentity(scope);
  return createDesktopScientificDocumentReader({
    workspaceRoot: input.workspaceRoot,
    workspace,
    ...(input.transport ? { transport: input.transport } : {}),
    ...(input.operationId ? { operationId: input.operationId } : {}),
    ...(input.acceptedHead ? { acceptedHead: input.acceptedHead } : {}),
  }).read({
    workspace,
    document: parseScientificDocumentIdentity(documentPath),
    signal: input.signal,
  });
}

export function workspaceRelativePath(workspaceRoot: string, filePath: string): string | null {
  const normalize = (value: string): string => value.replace(/\\/gu, '/').replace(/\/+$/u, '');
  const root = normalize(workspaceRoot);
  const file = normalize(filePath);
  if (!root || file === root || !file.startsWith(`${root}/`)) return null;
  return file.slice(root.length + 1);
}

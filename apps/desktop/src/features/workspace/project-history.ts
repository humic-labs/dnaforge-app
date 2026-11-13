import { platform } from '../../platform';
import { withRendererWorkspaceMutation } from '../../services/workspace-mutation-transaction';
import { waitForNativeFileDocumentReadiness } from './file-document-client';
import type {
  ProjectHistoryInspection,
  ProjectHistoryOperation,
  ProjectHistoryResult,
} from '../../shared/project-history';

export async function executeProjectHistory(
  workspaceRoot: string,
  operation: ProjectHistoryOperation,
  signal?: AbortSignal
): Promise<ProjectHistoryResult> {
  signal?.throwIfAborted();
  await waitForNativeFileDocumentReadiness();
  signal?.throwIfAborted();
  if (operation.kind === 'inspect')
    return platform().shell.projectHistory({ workspaceRoot, operation });
  return withRendererWorkspaceMutation(workspaceRoot, async (mutationToken) => {
    signal?.throwIfAborted();
    return platform().shell.projectHistory({ workspaceRoot, operation, mutationToken });
  });
}

export async function inspectProjectHistory(
  workspaceRoot: string
): Promise<ProjectHistoryInspection> {
  let offset = 0;
  let state: ProjectHistoryInspection | undefined;
  for (;;) {
    const result = await executeProjectHistory(workspaceRoot, {
      kind: 'inspect',
      offset,
      limit: 1000,
    });
    if (result.status === 'failed') throw new Error(result.error);
    if (!state) state = { ...result.inspection, entries: [] };
    else if (state.revision !== result.inspection.revision)
      throw new Error('Project history changed while reading its entries. Refresh it again.');
    state.entries.push(...result.inspection.entries);
    if (result.inspection.nextOffset === null) return { ...state, nextOffset: null };
    offset = result.inspection.nextOffset;
  }
}

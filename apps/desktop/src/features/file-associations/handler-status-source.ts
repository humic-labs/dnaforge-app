import { platform } from '../../platform';
import type {
  FileAssociationDefaultRequestResult,
  FileAssociationHandlerStatus,
} from '../../shared/file-association-ipc';
import type { FileAssociationFamilyId } from '../../shared/file-associations';

export const OPEN_FILE_HANDLING_SETTINGS_EVENT = 'dnaforge:open-file-handling-settings';
export const REVEAL_OPEN_DOCUMENT_EVENT = 'dnaforge:reveal-open-document';

let devOverride: readonly FileAssociationHandlerStatus[] | null = null;

export function setFileAssociationHandlerDevOverride(
  statuses: readonly FileAssociationHandlerStatus[] | null
): void {
  devOverride = statuses ? statuses.map((status) => ({ ...status })) : null;
}

export async function queryFileAssociationHandlers(): Promise<
  readonly FileAssociationHandlerStatus[]
> {
  return devOverride ?? platform().fileAssociations.queryHandlers();
}

export async function requestFileAssociationDefault(
  familyId: FileAssociationFamilyId
): Promise<FileAssociationDefaultRequestResult> {
  if (!devOverride) return platform().fileAssociations.requestDefault(familyId);
  const target = devOverride.find((status) => status.familyId === familyId);
  if (!target || target.defaultAction === 'none') {
    return { familyId, outcome: 'unavailable', detail: target?.detail ?? null };
  }
  devOverride = devOverride.map((status) =>
    status.familyId === familyId
      ? {
          ...status,
          state: 'default',
          handlerName: 'DNAForge',
          handlerPath: '/Applications/DNAForge.app',
        }
      : status
  );
  return { familyId, outcome: 'requested', detail: null };
}

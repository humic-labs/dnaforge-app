import { nativeDocuments } from '../features/native-documents';
import { handleGroup } from '../../shared/ipc-contract';
import { workspaceRelocateContract } from '../../shared/ipc/workspace-relocate.contract';
import type {
  RelocateEntityFileInput,
  RelocateEntityFileResult,
} from '../../shared/workspace-relocate-types';

export type { RelocateEntityFileInput, RelocateEntityFileResult };

export function relocateEntityFile(
  input: RelocateEntityFileInput,
  rendererOwnerId?: number
): Promise<RelocateEntityFileResult> {
  return nativeDocuments.fileRelocations.relocateEntityFile(input, rendererOwnerId);
}

export function relinkMovedEntityFile(
  input: RelocateEntityFileInput,
  rendererOwnerId?: number
): Promise<RelocateEntityFileResult> {
  return nativeDocuments.fileRelocations.relinkMovedEntityFile(input, rendererOwnerId);
}

export function registerWorkspaceRelocateHandlers(): void {
  handleGroup(workspaceRelocateContract, {
    relocateEntityFile: (
      event,
      input: RelocateEntityFileInput
    ): Promise<RelocateEntityFileResult> => relocateEntityFile(input, event.sender.id),
    relinkMovedEntityFile: (
      event,
      input: RelocateEntityFileInput
    ): Promise<RelocateEntityFileResult> => relinkMovedEntityFile(input, event.sender.id),
  });
}

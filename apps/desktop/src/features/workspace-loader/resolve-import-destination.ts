import type { WorkspaceFolder } from '../../stores/workspaceStore';
import { resolveActiveImportRoot } from './resolve-import-root';

export type ImportDropKind = 'file' | 'files' | 'folder' | 'mixed';

export type ImportDestination =
  | { kind: 'new-workspace' }
  | { kind: 'existing-root'; rootPath: string }
  | { kind: 'registry' };

export interface ResolveImportDestinationInput {
  folders: WorkspaceFolder[];
  selectedPath?: string | null;
  focusedRootPath?: string | null;
  workspacePath?: string | null;
  dropKind: ImportDropKind;
}

export type ImportDestinationReason =
  | 'preselect-existing'
  | 'preselect-new-workspace'
  | 'require-choice-file'
  | 'require-choice-ambiguous';

export interface ImportDestinationResolution {
  preselected: ImportDestination;
  requiresExplicitChoice: boolean;
  reason: ImportDestinationReason;
}

function isFolderish(dropKind: ImportDropKind): boolean {
  return dropKind === 'folder' || dropKind === 'mixed';
}

export function resolveImportDestination(
  input: ResolveImportDestinationInput
): ImportDestinationResolution {
  const importable = input.folders.filter((folder) => !folder.pinned);

  if (importable.length === 0) {
    if (isFolderish(input.dropKind)) {
      return {
        preselected: { kind: 'new-workspace' },
        requiresExplicitChoice: false,
        reason: 'preselect-new-workspace',
      };
    }
    return {
      preselected: { kind: 'new-workspace' },
      requiresExplicitChoice: true,
      reason: 'require-choice-file',
    };
  }

  const root = resolveActiveImportRoot(input);
  if (root) {
    return {
      preselected: { kind: 'existing-root', rootPath: root },
      requiresExplicitChoice: false,
      reason: 'preselect-existing',
    };
  }

  return {
    preselected: { kind: 'new-workspace' },
    requiresExplicitChoice: true,
    reason: 'require-choice-ambiguous',
  };
}

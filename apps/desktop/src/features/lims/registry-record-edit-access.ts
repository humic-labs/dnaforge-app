import {
  userMessage,
  userMessageWithValues,
  userMessageValue,
  userEntityLabel,
  type UserMessage,
} from '@waypoint/user-messages';
import type { LimsRegistrySummary } from '../../shared/lims';
import { resolveContainingPathBoundary } from '../../shared/path-boundary';
import type { ProjectEditFolder } from '../workspace-loader/public/project-edit-folders';

export type RegistryEditWorkspaceFolder = ProjectEditFolder;

export type RegistryRecordEditAccess =
  | { canEdit: true; workspaceRoot?: string }
  | {
      canEdit: false;
      reason:
        | 'archived'
        | 'reference'
        | 'project_unavailable'
        | 'ambiguous'
        | 'restoring'
        | 'checking'
        | 'viewer';
      message: UserMessage;
    };

export function registryRecordEditAccess(
  summary: LimsRegistrySummary,
  folders: readonly RegistryEditWorkspaceFolder[]
): RegistryRecordEditAccess {
  if (summary.archived) {
    return {
      canEdit: false,
      reason: 'archived',
      message: userMessage('record.restoreBeforeEditing'),
    };
  }
  const target = summary.representation.openTarget;
  if (target?.kind !== 'managed_sequence') return { canEdit: true };
  return managedSequenceEditAccess(target.document.packageRoot, folders);
}

export function managedSequenceEditAccess(
  packageRoot: string,
  folders: readonly RegistryEditWorkspaceFolder[]
): RegistryRecordEditAccess {
  const owner = resolveContainingPathBoundary(folders, packageRoot);
  if (owner.status === 'ambiguous') {
    return {
      canEdit: false,
      reason: 'ambiguous',
      message: userMessage('edit.sequenceOverlapping'),
    };
  }
  if (owner.status === 'none') {
    return {
      canEdit: false,
      reason: 'project_unavailable',
      message: userMessage('edit.sequenceProjectUnavailable'),
    };
  }
  if (owner.entry.editAvailability === 'checking') {
    return {
      canEdit: false,
      reason: 'checking',
      message: userMessage('edit.checkingProject'),
    };
  }
  if (owner.entry.editAvailability === 'unavailable') {
    return {
      canEdit: false,
      reason: 'project_unavailable',
      message: userMessage('edit.projectCheckFailed'),
    };
  }
  if (owner.entry.lifecycle === 'archived' || owner.entry.lifecycle === 'trashed') {
    return {
      canEdit: false,
      reason: 'archived',
      message: owner.entry.name
        ? userMessageWithValues('edit.restoreNamedSequenceProject', {
            name: userEntityLabel(owner.entry.name, 'project.untitled'),
            location: userMessageValue(
              owner.entry.lifecycle === 'trashed' ? 'Trash' : 'the archive'
            ),
          })
        : userMessageWithValues('edit.restoreSequenceProject', {
            location: userMessageValue(
              owner.entry.lifecycle === 'trashed' ? 'Trash' : 'the archive'
            ),
          }),
    };
  }
  if (owner.entry.lifecycle === 'restoring') {
    return {
      canEdit: false,
      reason: 'restoring',
      message: userMessage('edit.projectRestoring'),
    };
  }
  if (owner.entry.pinned) {
    return {
      canEdit: false,
      reason: 'reference',
      message: owner.entry.name
        ? userMessageWithValues('edit.namedReferenceFolder', {
            name: userEntityLabel(owner.entry.name, 'project.untitled'),
          })
        : userMessage('edit.referenceFolder'),
    };
  }
  if (owner.entry.sharedEditAccess?.kind === 'checking') {
    return {
      canEdit: false,
      reason: 'checking',
      message: userMessage('edit.checkingProject'),
    };
  }
  if (owner.entry.sharedEditAccess?.kind === 'unavailable') {
    return {
      canEdit: false,
      reason: 'project_unavailable',
      message: userMessage('edit.refreshProjectAccess'),
    };
  }
  if (
    owner.entry.sharedEditAccess?.kind === 'ready' &&
    owner.entry.sharedEditAccess.role === 'viewer'
  ) {
    return {
      canEdit: false,
      reason: 'viewer',
      message: userMessage('edit.projectViewOnly'),
    };
  }
  return { canEdit: true, workspaceRoot: owner.entry.path };
}

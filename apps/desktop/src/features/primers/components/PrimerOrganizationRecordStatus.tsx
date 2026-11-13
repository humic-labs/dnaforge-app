import { toUserMessage } from '@waypoint/user-messages';
import { useEffect, useRef, useState } from 'react';
import { getCatalogFileForPath, getWorkspaceRootById } from '../../../db/workspace-catalog';
import {
  normalizePathForBoundary,
  resolveContainingPathBoundary,
} from '../../../shared/path-boundary';
import type { OrganizationRegistrySavedRecordResolutionRequest } from '../../../shared/org-registry-sync';
import { useAuthStore } from '../../../stores/auth-store';
import { useProjectEditFolders } from '../../workspace-loader/public/use-project-edit-folders';
import { projectPathIsReadOnly } from '../../workspace-loader/public/project-edit-folders';
import {
  SavedRecordOrganizationStatus,
  useOrganizationRecordSync,
} from '../../lims/public/organization-record-status';
import { emitLimsRegistryChanged } from '../../lims/public/events';
import { primerServices } from '../primer-services';
import type { ReadPrimerArtifactResult } from '../primer-artifact-service';

export function PrimerOrganizationRecordStatus({
  tabId,
  path,
  workspaceRoot,
  accountId,
  loaded,
  dirty,
  readOnly,
  saving,
  loading,
  onApplied,
  onBlockedChange,
}: {
  tabId: string;
  path: string;
  workspaceRoot: string;
  accountId: string | null;
  loaded: ReadPrimerArtifactResult | null;
  dirty: boolean;
  readOnly: boolean;
  saving: boolean;
  loading: boolean;
  onApplied: (loaded: ReadPrimerArtifactResult) => void;
  onBlockedChange: (blocked: boolean) => void;
}) {
  const [owner, setOwner] = useState<{
    entityId: string;
    workspaceId: number;
    path: string;
    workspaceRoot: string;
    accountId: string;
  } | null>(null);
  const folders = useProjectEditFolders();
  const loadedEntityId = loaded?.artifact.id;
  const loadedWorkspaceId = loaded?.registeredRevision?.workspaceId;
  const currentOwner =
    owner?.path === path &&
    owner.workspaceRoot === workspaceRoot &&
    owner.accountId === accountId &&
    (!loadedEntityId || owner.entityId === loadedEntityId)
      ? owner
      : null;
  const sync = useOrganizationRecordSync(currentOwner?.entityId ?? null);
  const [applying, setApplying] = useState(false);
  const applyingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const epoch = useRef(0);
  const context = useRef({ tabId, path, workspaceRoot, accountId });
  context.current = { tabId, path, workspaceRoot, accountId };
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    epoch.current++;
    applyingRef.current = false;
    setApplying(false);
    setError(null);
    return () => {
      epoch.current++;
    };
  }, [tabId, path, workspaceRoot, accountId]);

  useEffect(() => {
    let active = true;
    setOwner(null);
    if (!accountId) return;
    if (loadedEntityId && loadedWorkspaceId !== undefined) {
      setOwner({
        entityId: loadedEntityId,
        workspaceId: loadedWorkspaceId,
        path,
        workspaceRoot,
        accountId,
      });
      return;
    }

    void getCatalogFileForPath(path)
      .then(async (file) => {
        if (
          !file ||
          file.status !== 'current' ||
          file.file_kind !== 'primer-artifact' ||
          file.workspace_id == null
        )
          return;
        const home = await getWorkspaceRootById(file.workspace_id);
        if (
          !active ||
          !home ||
          normalizePathForBoundary(home) !== normalizePathForBoundary(workspaceRoot)
        )
          return;
        if (loadedEntityId && loadedEntityId !== file.entity_id) return;
        setOwner({
          entityId: file.entity_id,
          workspaceId: file.workspace_id,
          path,
          workspaceRoot,
          accountId,
        });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [path, workspaceRoot, accountId, loadedEntityId, loadedWorkspaceId]);

  useEffect(() => {
    onBlockedChange(applying || sync.resolving || Boolean(sync.pendingResolution));
  }, [applying, sync.resolving, sync.pendingResolution, onBlockedChange]);
  useEffect(() => () => onBlockedChange(false), [onBlockedChange]);

  const boundary = resolveContainingPathBoundary(folders, path);
  const accessMessage =
    !currentOwner ||
    readOnly ||
    boundary.status !== 'unique' ||
    projectPathIsReadOnly(path, folders)
      ? 'The primer’s home project must be available and writable before applying this change.'
      : null;
  const blocked =
    applying ||
    sync.resolving ||
    sync.busy ||
    dirty ||
    saving ||
    Boolean(accessMessage) ||
    (!sync.pendingResolution && (loading || !loaded));

  const resolve = async (choice?: OrganizationRegistrySavedRecordResolutionRequest['choice']) => {
    if (blocked || applyingRef.current || !currentOwner) return;
    const requestEpoch = epoch.current;
    const captured = context.current;
    const isCurrent = () => {
      const auth = useAuthStore.getState().state;
      return (
        requestEpoch === epoch.current &&
        !dirtyRef.current &&
        (auth.status === 'signed-in' ? auth.session.accountId : null) === captured.accountId &&
        context.current.tabId === captured.tabId &&
        context.current.path === captured.path &&
        context.current.workspaceRoot === captured.workspaceRoot &&
        context.current.accountId === captured.accountId
      );
    };
    applyingRef.current = true;
    setApplying(true);
    setError(null);
    try {
      const result = await sync.resolve(choice);
      if (!result || !result.isCurrent() || !isCurrent()) return;
      if (result.entity.workspaceId !== currentOwner.workspaceId)
        throw new Error('The primer’s home changed. Reload its project before continuing.');
      const saved = await primerServices.persistence.readArtifactAtPath(path, workspaceRoot);
      if (!result.isCurrent() || !isCurrent()) return;
      if (
        saved.artifact.id !== currentOwner.entityId ||
        saved.registeredRevision?.workspaceId !== currentOwner.workspaceId
      )
        throw new Error('The saved primer identity or home changed before it could be reopened.');
      onApplied(saved);
      sync.finishResolution(result.request);
      emitLimsRegistryChanged();
      void sync.synchronize();
    } catch (cause) {
      if (isCurrent())
        setError(toUserMessage(cause, 'failure.the-approved-primer-could-not-be-reopened'));
    } finally {
      if (requestEpoch === epoch.current) {
        applyingRef.current = false;
        setApplying(false);
      }
    }
  };

  return (
    <>
      <SavedRecordOrganizationStatus
        organizationSync={sync}
        schema={loaded?.artifact.entity?.schema}
        testIdPrefix="primer"
        resolutionBlocked={blocked}
        applyingResolution={applying}
        saving={saving}
        hasDraft={dirty}
        resolutionAccessMessage={accessMessage}
        resolveOrganizationVersion={resolve}
      />
      {error ? (
        <p role="alert" className="p-3 text-sm text-error">
          {toUserMessage(error, 'primer.failed')}
        </p>
      ) : null}
    </>
  );
}

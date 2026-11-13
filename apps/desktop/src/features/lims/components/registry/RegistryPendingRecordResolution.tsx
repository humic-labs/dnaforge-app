import { isTabDirty } from '../../../canvas/public/artifact-document-lifecycle';
import { toUserMessage } from '@waypoint/user-messages';
import { useEffect, useRef, useState } from 'react';
import { getWorkspaceRootById } from '../../../../db/workspace-catalog';
import { resolveContainingPathBoundary } from '../../../../shared/path-boundary';
import { useCanvasStore } from '../../../canvas/public/store';
import { projectPathIsReadOnly } from '../../../workspace-loader/public/project-edit-folders';
import type { RegistryEditWorkspaceFolder } from '../../registry-record-edit-access';
import { loadSavedEntityRecord } from '../../entity-record-document';
import { useOrganizationRecordSync } from './useOrganizationRecordSync';

export function RegistryPendingRecordResolution({
  entityId,
  workspaceId,
  workspaceFolders,
  actionBusy,
}: {
  entityId: string;
  workspaceId: number;
  workspaceFolders: readonly RegistryEditWorkspaceFolder[];
  actionBusy: boolean;
}) {
  const sync = useOrganizationRecordSync(entityId);
  const dirty = useCanvasStore((state) =>
    Object.values(state.panels).some((panel) =>
      panel.tabs.some((tab) => tab.entityId === entityId && isTabDirty(tab))
    )
  );
  const [home, setHome] = useState<{ entityId: string; workspaceId: number; path: string } | null>(
    null
  );
  const [applying, setApplying] = useState(false);
  const applyingRef = useRef(false);
  const requestRef = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [savedAccount, setSavedAccount] = useState<string | null>(null);
  useEffect(() => {
    requestRef.current++;
    setError(null);
    setSavedAccount(null);
    applyingRef.current = false;
    setApplying(false);
    return () => {
      requestRef.current++;
    };
  }, [entityId, workspaceId, sync.accountId]);
  useEffect(() => {
    let cancelled = false;
    setHome(null);
    if (!sync.pendingResolution) return;
    void getWorkspaceRootById(workspaceId)
      .then((path) => {
        if (!cancelled && path) setHome({ entityId, workspaceId, path });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [entityId, workspaceId, sync.accountId, sync.pendingResolution?.resolutionId]);
  const currentHome = home?.entityId === entityId && home.workspaceId === workspaceId ? home : null;
  const owner = currentHome
    ? resolveContainingPathBoundary(workspaceFolders, currentHome.path)
    : null;
  const writable = Boolean(
    currentHome &&
    owner?.status === 'unique' &&
    !projectPathIsReadOnly(currentHome.path, workspaceFolders)
  );
  const blocked = !writable || dirty || actionBusy || applying || sync.resolving || sync.busy;

  const retry = async () => {
    if (blocked || applyingRef.current || !sync.pendingResolution) return;
    const request = ++requestRef.current;
    applyingRef.current = true;
    setApplying(true);
    setError(null);
    let isCurrent: (() => boolean) | null = null;
    try {
      const result = await sync.resolve();
      if (!result || request !== requestRef.current || !result.isCurrent()) return;
      isCurrent = () => request === requestRef.current && result.isCurrent();
      const saved = await loadSavedEntityRecord(entityId);
      if (!isCurrent()) return;
      if (
        saved.artifact.id !== entityId ||
        saved.preview.entity.workspaceId !== workspaceId ||
        result.entity.workspaceId !== workspaceId
      )
        throw new Error('The saved record’s home changed. Refresh Details before continuing.');
      sync.finishResolution(result.request);
      setSavedAccount(sync.accountId);
      void sync.synchronize();
    } catch (cause) {
      if (isCurrent?.())
        setError(toUserMessage(cause, 'failure.the-approved-change-could-not-be-reopened'));
    } finally {
      if (request === requestRef.current && (!isCurrent || isCurrent())) {
        applyingRef.current = false;
        setApplying(false);
      }
    }
  };

  if (!sync.pendingResolution && (!savedAccount || savedAccount !== sync.accountId)) return null;
  return (
    <div
      data-testid="lims-registry-pending-resolution"
      className="space-y-2 rounded border border-border p-3 text-sm"
    >
      {sync.pendingResolution ? (
        <>
          <p>Your approved change needs to finish saving on this device.</p>
          <button
            type="button"
            data-testid="registry-record-retry-organization-resolution"
            disabled={blocked}
            onClick={() => void retry()}
            className="rounded border border-border px-3 py-1.5 disabled:opacity-50"
          >
            {applying ? 'Applying change…' : 'Retry approved change'}
          </button>
          {dirty ? (
            <p>Save or discard the open record’s edits before retrying.</p>
          ) : !writable ? (
            <p>Its home project must be available and writable before retrying.</p>
          ) : null}
        </>
      ) : (
        <p role="status">Approved change saved on this device.</p>
      )}
      {error || sync.error ? (
        <p role="status" className="text-warning">
          {error != null
            ? toUserMessage(error, 'operation.failed')
            : toUserMessage(sync.error, 'operation.failed')}
        </p>
      ) : null}
    </div>
  );
}

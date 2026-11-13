import { toUserMessage } from '@waypoint/user-messages';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  EntityDetailsSession,
  EntityDetailsState,
} from '../../../entity-details/public/session-model';
import { useProjectEditFolders } from '../../../workspace-loader/public/use-project-edit-folders';
import { projectPathIsReadOnly } from '../../../workspace-loader/public/project-edit-folders';
import {
  normalizePathForBoundary,
  resolveContainingPathBoundary,
} from '../../../../shared/path-boundary';
import {
  fingerprintText,
  useUnsavedDraftRecovery,
} from '../../../../shared/unsaved-draft-recovery';
import { registerWorkspaceDisplayParticipant } from '../../../../services/workspace-display-participants';
import type { LimsUpdateEntityInput } from '../../../../shared/lims';
import type { OrganizationRegistrySavedRecordResolutionRequest } from '../../../../shared/org-registry-sync';
import { getWorkspaceRootById } from '../../../../db/workspace-catalog';
import { loadSavedEntityRecord } from '../../entity-record-document';
import { getLimsEntityById } from '../../open-target';
import { subscribeLimsRegistryChanged } from '../../events';
import { useOrganizationRecordSync } from './useOrganizationRecordSync';
import { SavedRecordOrganizationStatus } from './SavedRecordOrganizationStatus';

const synchronizedSaveRevisions = new WeakMap<EntityDetailsSession, number>();

interface Recovery {
  draft: { name: string; fields: Record<string, unknown> };
  pending: LimsUpdateEntityInput | null;
}

export function SavedRecordMetadataContext({
  session,
  state,
  readOnly = false,
  tabId,
}: {
  session: EntityDetailsSession;
  state: EntityDetailsState;
  readOnly?: boolean;
  tabId?: string;
}) {
  const entityId = session.target.entityId;
  const sync = useOrganizationRecordSync(entityId);
  const folders = useProjectEditFolders();
  const recovery = state.definition?.savedRecord;
  const loaded = recovery?.loaded;
  const pending = recovery?.pending() ?? null;
  const dirty = session.dirty || state.activeField !== null || state.completionPending;
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fallbackHome, setFallbackHome] = useState<{
    entityId: string;
    accountId: string;
    workspaceId: number;
    root: string;
  } | null>(null);
  const request = useRef(0);
  const applyingRef = useRef(false);
  const current = useRef({ entityId, accountId: sync.accountId });
  current.current = { entityId, accountId: sync.accountId };
  useLayoutEffect(() => {
    request.current++;
    applyingRef.current = false;
    setApplying(false);
    setFallbackHome(null);
    setError(null);
    return () => {
      request.current++;
    };
  }, [entityId, sync.accountId]);

  useEffect(() => {
    if (!sync.pendingResolution || loaded || !sync.accountId) return;
    let cancelled = false;
    const accountId = sync.accountId;
    void (async () => {
      try {
        const entity = await getLimsEntityById(entityId);
        if (!entity || entity.id !== entityId || entity.workspaceId === null) return;
        const root = await getWorkspaceRootById(entity.workspaceId);
        if (!cancelled && root)
          setFallbackHome({ entityId, accountId, workspaceId: entity.workspaceId, root });
      } catch {
        return;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entityId, sync.accountId, sync.pendingResolution?.resolutionId, loaded]);

  useEffect(() => {
    if (!applying && !sync.resolving && !sync.pendingResolution) return;
    return session.holdMutations(
      'Finish the approved organization change before editing this record.'
    );
  }, [applying, sync.resolving, sync.pendingResolution, session]);

  useEffect(
    () =>
      subscribeLimsRegistryChanged(() => {
        void session.load();
      }),
    [session]
  );

  useEffect(
    () =>
      registerWorkspaceDisplayParticipant(async (context) => {
        const before = session.getSnapshot();
        const saved = before.definition?.savedRecord?.loaded;
        if (
          !saved ||
          normalizePathForBoundary(saved.workspaceRoot) !==
            normalizePathForBoundary(context.workspaceRoot)
        )
          return;
        if (before.saving || before.completionPending || applyingRef.current)
          throw new Error(
            'The open record is finishing a save. Refresh its project after that change settles.'
          );
        const next = await loadSavedEntityRecord(entityId);
        context.assertCurrent();
        const after = session.getSnapshot();
        if (after.saving || after.completionPending || applyingRef.current)
          throw new Error('The open record changed while its project was refreshing.');
        if (session.dirty || after.activeField !== null) {
          if (
            saved.content !== next.content ||
            saved.path !== next.path ||
            saved.preview.entity.workspaceId !== next.preview.entity.workspaceId ||
            saved.preview.entity.eventSeq !== next.preview.entity.eventSeq
          ) {
            const reason =
              'The saved record changed while you were editing. Review its current version before saving.';
            session.markStale(reason);
            throw new Error(reason);
          }
          return;
        }
        if (!(await session.load())) throw new Error('The saved record could not be refreshed.');
        context.assertCurrent();
      }),
    [entityId, session]
  );

  useUnsavedDraftRecovery<Recovery>({
    key: `record:${entityId}`,
    name: state.draft?.name || state.definition?.record.name || 'Saved record',
    baseline: loaded ? fingerprintText(loaded.content) : null,
    dirty,
    payload: {
      draft: { name: state.draft?.name ?? '', fields: state.draft?.fields ?? {} },
      pending,
    },
    onRestore: (restored) => {
      const owner = session.getSnapshot().definition?.savedRecord;
      if (
        !owner ||
        typeof restored.draft?.name !== 'string' ||
        !restored.draft.fields ||
        typeof restored.draft.fields !== 'object'
      )
        return;
      if (restored.pending) {
        owner.restore(restored.pending);
        session.recoverRecordDraft(restored.draft, {
          key: JSON.stringify(restored.pending),
          complete: owner.retry,
        });
      } else session.recoverRecordDraft(restored.draft);
    },
    discardTarget: tabId ? { kind: 'tab', tabId } : undefined,
  });

  useEffect(() => {
    const previous = synchronizedSaveRevisions.get(session);
    synchronizedSaveRevisions.set(session, state.saveRevision);
    if (previous === undefined || previous === state.saveRevision) return;
    if (state.saveConfirmed) void sync.synchronize();
  }, [session, state.saveRevision, state.saveConfirmed, sync.synchronize]);

  const path =
    loaded?.path ??
    (fallbackHome?.entityId === entityId && fallbackHome.accountId === sync.accountId
      ? fallbackHome.root
      : null);
  const workspaceId = loaded?.preview.entity.workspaceId ?? fallbackHome?.workspaceId;
  const owner = path ? resolveContainingPathBoundary(folders, path) : null;
  const accessMessage =
    !path || owner?.status !== 'unique' || readOnly || projectPathIsReadOnly(path, folders)
      ? 'The record’s home project must be available and writable before applying this change.'
      : null;
  const resolutionBlocked =
    applying ||
    sync.resolving ||
    sync.busy ||
    state.saving ||
    dirty ||
    pending !== null ||
    accessMessage !== null ||
    (!sync.pendingResolution && (!loaded || state.requiresReload || state.loading));

  const resolve = async (choice?: OrganizationRegistrySavedRecordResolutionRequest['choice']) => {
    if (resolutionBlocked || applyingRef.current) return;
    const serial = ++request.current;
    const context = { ...current.current };
    const isCurrent = () =>
      serial === request.current &&
      current.current.entityId === context.entityId &&
      current.current.accountId === context.accountId;
    applyingRef.current = true;
    setApplying(true);
    setError(null);
    try {
      const result = await sync.resolve(choice);
      if (!result || !isCurrent() || !result.isCurrent()) return;
      if (result.entity.workspaceId !== workspaceId)
        throw new Error('The record’s home project changed. Refresh it before continuing.');
      const next = await loadSavedEntityRecord(entityId);
      if (!isCurrent() || !result.isCurrent()) return;
      if (
        next.artifact.id !== result.entity.id ||
        next.preview.entity.workspaceId !== result.entity.workspaceId
      )
        throw new Error('The saved record no longer matches its approved home.');
      if (!(await session.load()))
        throw new Error('The approved change could not be reopened. Retry the approved change.');
      if (!isCurrent() || !result.isCurrent()) return;
      const installed = session.getSnapshot().definition?.savedRecord?.loaded;
      if (!installed || installed.content !== next.content || installed.path !== next.path)
        throw new Error('The approved record changed before its view could be refreshed.');
      sync.finishResolution(result.request);
      void sync.synchronize();
      window.dispatchEvent(
        new CustomEvent('waypoint:workspace-files-changed', {
          detail: { workspaceRoot: next.workspaceRoot, revealPath: next.path },
        })
      );
    } catch (cause) {
      if (isCurrent())
        setError(toUserMessage(cause, 'failure.the-approved-change-could-not-be-reopened'));
    } finally {
      if (isCurrent()) {
        applyingRef.current = false;
        setApplying(false);
      }
    }
  };

  return (
    <>
      <SavedRecordOrganizationStatus
        organizationSync={sync}
        schema={state.definition?.record.schema}
        testIdPrefix="entity-record"
        resolutionBlocked={resolutionBlocked}
        applyingResolution={applying}
        saving={state.saving}
        hasDraft={dirty || pending !== null}
        resolutionAccessMessage={accessMessage}
        resolveOrganizationVersion={resolve}
      />
      {error ? (
        <p role="alert" className="text-sm text-error">
          {toUserMessage(error, 'operation.failed')}
        </p>
      ) : null}
    </>
  );
}

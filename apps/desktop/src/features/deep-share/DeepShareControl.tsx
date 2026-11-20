import {
  toUserMessage,
  userMessage,
  userMessageWithValues,
  userMessageValue,
} from '@waypoint/user-messages';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { confirmDialog } from '../../components/confirm-dialog-store';
import { Button } from '../../components/ui';
import { OpenExternalIcon } from '../../components/icons';
import { platform } from '../../platform';
import { Tooltip } from '../../shared/components/Tooltip';
import type { DeepSharePublishOk, DeepShareReview } from '../../shared/deep-share-ipc';
import { useAuthStore } from '../../stores/auth-store';
import { useSequenceEditModeStore } from '../../stores/sequence-edit-mode-store';
import { useToastStore } from '../../stores/toast-store';
import { CLOUD_BACKUP_SCOPE_DETAIL } from '../auth/public/workspace-sync-display';
import { copyPublishedShareLink } from '../../lib/copy-published-share-link';
import { DeepShareManifestDialog } from './DeepShareManifestDialog';
import { isDesktopRuntime } from '../../utils/environment';
import type { AdministrationAction } from '../../shared/administration';
import {
  acknowledgeShareLink,
  cancelShareAdministration,
  prepareShareAdministration,
  publishShareAdministration,
} from './administration-client';

interface FocusedDeepShareRow {
  repo_uuid: string;
  artifact_id: string;
  artifact_type: string;
  file_path: string;
  file_kind: string;
}

function comparablePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

export function resolveFocusedDeepShareRow(
  rows: readonly FocusedDeepShareRow[],
  targetReference: string,
  sequencePackageMarkerPresent = false
): FocusedDeepShareRow | null {
  const selected = comparablePath(targetReference);
  return (
    rows.find((row) => row.artifact_id === targetReference) ??
    rows.find((row) => comparablePath(row.file_path) === selected) ??
    rows.find((row) => {
      if (
        !sequencePackageMarkerPresent ||
        (row.artifact_type !== 'sequence' && row.artifact_type !== 'construct')
      )
        return false;
      const filePath = comparablePath(row.file_path);
      return filePath.slice(0, filePath.lastIndexOf('/')) === selected;
    }) ??
    null
  );
}

export function DeepShareControl(props: {
  workspaceRootPaths: readonly string[];
  targetReference: string | null;

  ensureTarget?: () => Promise<void>;
}) {
  const ensureTarget = props.ensureTarget;
  const authState = useAuthStore((state) => state.state);
  const startSignIn = useAuthStore((state) => state.startSignIn);
  const editModeActive = useSequenceEditModeStore((state) => state.active);
  const addToast = useToastStore((state) => state.addToast);
  const [target, setTarget] = useState<FocusedDeepShareRow | null>(null);
  const [review, setReview] = useState<DeepShareReview | null>(null);
  const [selectedArtifactIds, setSelectedArtifactIds] = useState<Set<string>>(new Set());
  const [selectedConversationIds, setSelectedConversationIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reviewContextVersion = useRef(0);
  const nativeAction = useRef<AdministrationAction | null>(null);
  const nativeObservation = useRef<AbortController | null>(null);

  const signedIn = authState.status === 'signed-in';
  const signedInAccountId = signedIn ? authState.session.accountId : null;

  const workspaceRootsKey = JSON.stringify([...new Set(props.workspaceRootPaths)].sort());
  const context = useMemo(
    () => ({
      signedInAccountId,
      workspaceRootsKey,
      targetReference: props.targetReference,
      editModeActive,
    }),
    [signedInAccountId, workspaceRootsKey, props.targetReference, editModeActive]
  );
  const currentContext = useRef<typeof context | null>(context);
  currentContext.current = context;
  const targetOwner = useRef<typeof context | null>(null);
  const reviewOwner = useRef<typeof context | null>(null);
  const pendingPublication = useRef<object | null>(null);
  const [published, setPublished] = useState<{
    context: typeof context;
    contextVersion: number;
    workspaceUuid: string;
    rootArtifactId: string;
    reviewedDigest: string;
    result: DeepSharePublishOk;
  } | null>(null);
  const isCurrentContext = useCallback(
    (version: number) =>
      currentContext.current === context &&
      reviewContextVersion.current === version &&
      signedIn &&
      !editModeActive,
    [context, signedIn, editModeActive]
  );
  const findTarget = useCallback(async (): Promise<FocusedDeepShareRow | null> => {
    const workspaceRootPaths = JSON.parse(workspaceRootsKey) as string[];
    const targetReference = props.targetReference;
    if (workspaceRootPaths.length === 0 || !targetReference) return null;
    const workspacePlaceholders = workspaceRootPaths.map(() => '?').join(', ');
    const rows = await platform().db.select<FocusedDeepShareRow[]>(
      `SELECT w.repo_uuid, ce.id AS artifact_id, ce.type AS artifact_type,
              cef.path AS file_path, cef.file_kind
       FROM workspaces w
       JOIN catalog_entities ce ON ce.workspace_id = w.id AND ce.status = 'active'
       JOIN catalog_entity_files cef ON cef.entity_id = ce.id AND cef.status = 'current'
       WHERE w.path IN (${workspacePlaceholders})
         AND w.repo_uuid IS NOT NULL
       ORDER BY ce.id ASC`,
      workspaceRootPaths
    );
    const directTarget = resolveFocusedDeepShareRow(rows, targetReference);
    if (directTarget) return directTarget;
    const packageMarkerPresent = await platform()
      .fs.exists(`${targetReference}/.forge/plasmid.json`)
      .catch(() => false);
    const row = resolveFocusedDeepShareRow(rows, targetReference, packageMarkerPresent);
    return row && typeof row.repo_uuid === 'string' && typeof row.artifact_id === 'string'
      ? row
      : null;
  }, [props.targetReference, workspaceRootsKey]);

  useEffect(() => {
    const previousAction = nativeAction.current;
    nativeAction.current = null;
    nativeObservation.current?.abort();
    if (previousAction) void cancelShareAdministration(previousAction).catch(() => {});
    currentContext.current = context;
    reviewContextVersion.current += 1;
    const contextVersion = reviewContextVersion.current;
    targetOwner.current = null;
    reviewOwner.current = null;
    pendingPublication.current = null;
    setPublished(null);
    setReview(null);
    setTarget(null);
    setBusy(false);
    setError(null);
    if (!signedIn || editModeActive) return;
    let cancelled = false;
    void findTarget()
      .then((row) => {
        if (!cancelled && isCurrentContext(contextVersion)) {
          targetOwner.current = context;
          setTarget(row);
        }
      })
      .catch(() => {
        if (!cancelled && isCurrentContext(contextVersion)) setTarget(null);
      });
    return () => {
      cancelled = true;
      nativeObservation.current?.abort();
      if (currentContext.current === context) currentContext.current = null;
      reviewContextVersion.current += 1;
    };
  }, [context, findTarget, isCurrentContext, signedIn, editModeActive]);

  const disabledReason = !signedIn
    ? 'Sign in before creating a Deep Share.'
    : editModeActive
      ? 'Save or cancel sequence editing before sharing.'
      : null;

  const selection = useMemo(
    () => ({
      workspaceUuid: target?.repo_uuid ?? '',
      rootArtifactId: target?.artifact_id ?? '',
      selectedArtifactIds: [...selectedArtifactIds].sort(),
      selectedConversationIds: [...selectedConversationIds].sort(),
    }),
    [selectedArtifactIds, selectedConversationIds, target]
  );
  const retainedPublication =
    published &&
    published.context === context &&
    published.contextVersion === reviewContextVersion.current &&
    published.workspaceUuid === target?.repo_uuid &&
    published.rootArtifactId === target?.artifact_id &&
    (review === null || published.reviewedDigest === review.digest)
      ? published
      : null;

  const loadReview = useCallback(
    async (
      artifactIds?: Set<string>,
      conversationIds?: Set<string>,
      targetOverride?: FocusedDeepShareRow
    ) => {
      const activeTarget = targetOverride ?? (targetOwner.current === context ? target : null);
      if (!activeTarget) return;
      const contextVersion = reviewContextVersion.current;
      if (!isCurrentContext(contextVersion)) return;
      setBusy(true);
      setError(null);
      try {
        const request = {
          workspaceUuid: activeTarget.repo_uuid,
          rootArtifactId: activeTarget.artifact_id,
          selectedArtifactIds: artifactIds ? [...artifactIds].sort() : undefined,
          selectedConversationIds: conversationIds ? [...conversationIds].sort() : [],
        };
        const prepare = async () => {
          if (!isDesktopRuntime()) return platform().cloudSync.preflightDeepShare(request);
          try {
            const prepared = await prepareShareAdministration(
              signedInAccountId ?? '',
              request,
              artifactIds === undefined
            );
            if (prepared.target.kind !== 'share')
              throw new Error('The native owner returned a different action.');
            if (!isCurrentContext(contextVersion)) {
              void cancelShareAdministration(prepared).catch(() => {});
              return {
                ok: false as const,
                code: 'PUBLISH_FAILED' as const,
                message: 'The share target changed.',
              };
            }
            nativeAction.current = prepared;
            return { ok: true as const, review: prepared.target.review };
          } catch (caught) {
            const code =
              caught &&
              typeof caught === 'object' &&
              'code' in caught &&
              caught.code === 'WORKSPACE_NOT_READY'
                ? ('WORKSPACE_NOT_READY' as const)
                : ('PUBLISH_FAILED' as const);
            return {
              ok: false as const,
              code,
              message: toUserMessage(caught, 'failure.could-not-prepare-the-native-share'),
            };
          }
        };
        let result = await prepare();
        if (!isCurrentContext(contextVersion)) return;
        if (!result.ok && result.code === 'WORKSPACE_NOT_READY') {
          const confirmed = await confirmDialog({
            title: userMessage('dialog.enable-cloud-backup-to-share'),
            message: toUserMessage(CLOUD_BACKUP_SCOPE_DETAIL, 'operation.confirm'),
            confirmLabel: userMessage('dialog.enable-continue'),
            cancelLabel: userMessage('dialog.not-now'),
            showCloseButton: true,
          });
          if (!isCurrentContext(contextVersion)) return;
          if (!confirmed) return;
          const enabled = await platform().cloudSync.setEnabled(activeTarget.repo_uuid, true);
          if (!isCurrentContext(contextVersion)) return;
          if (!enabled.ok) {
            setError(toUserMessage(enabled, 'sharing.failed'));
            addToast(toUserMessage(enabled, 'operation.failed'), {
              definition: 'deep-share-enable-failed',
            });
            return;
          }
          result = await prepare();
          if (!isCurrentContext(contextVersion)) return;
        }
        if (!result.ok) {
          setError(toUserMessage(result, 'sharing.failed'));
          addToast(toUserMessage(result, 'sharing.failed'), { definition: 'deep-share-failed' });
          return;
        }
        reviewOwner.current = context;
        setPublished(null);
        setReview(result.review);
        setSelectedArtifactIds(
          new Set(result.review.manifest.artifacts.map((artifact) => artifact.id))
        );
        setSelectedConversationIds(new Set(result.review.chats.map((chat) => chat.id)));
      } catch (caught) {
        if (!isCurrentContext(contextVersion)) return;
        const message = caught instanceof Error ? caught.message : 'Could not prepare Deep Share.';
        setError(toUserMessage(message, 'sharing.failed'));
        addToast(
          userMessage(
            'notice.deep-share-published-but-copy-failed-use-copy-published-link-to-retry'
          ),
          { definition: 'deep-share-error' }
        );
      } finally {
        if (isCurrentContext(contextVersion)) setBusy(false);
      }
    },
    [addToast, target, context, isCurrentContext, signedInAccountId]
  );

  const openReview = useCallback(async () => {
    if (!signedIn) {
      void startSignIn();
      return;
    }
    if (disabledReason) {
      if (disabledReason)
        addToast(toUserMessage(disabledReason, 'sharing.failed'), {
          definition: 'deep-share-disabled',
        });
      return;
    }
    let activeTarget = targetOwner.current === context ? target : null;
    const contextVersion = reviewContextVersion.current;
    try {
      if (!activeTarget && ensureTarget) {
        setBusy(true);
        await ensureTarget();
        if (!isCurrentContext(contextVersion)) return;
        activeTarget = await findTarget();
        if (!isCurrentContext(contextVersion)) return;
        targetOwner.current = context;
        setTarget(activeTarget);
      }
      if (!activeTarget) {
        addToast(
          userMessage(
            'notice.this-item-must-be-saved-in-a-managed-project-before-it-can-be-shared'
          ),
          {
            definition:
              'deep-share-control-this-item-must-be-saved-in-a-managed-project-before-it-can-be-shared',
          }
        );
        return;
      }
      setSelectedConversationIds(new Set());
      await loadReview(undefined, new Set(), activeTarget);
    } catch (caught) {
      if (!isCurrentContext(contextVersion)) return;
      const message = caught instanceof Error ? caught.message : 'Could not prepare Deep Share.';
      setError(toUserMessage(message, 'sharing.failed'));
      addToast(
        userMessage('notice.deep-share-published-but-copy-failed-use-copy-published-link-to-retry'),
        { definition: 'deep-share-preparation-failed' }
      );
    } finally {
      if (isCurrentContext(contextVersion)) setBusy(false);
    }
  }, [
    addToast,
    disabledReason,
    findTarget,
    loadReview,
    ensureTarget,
    signedIn,
    startSignIn,
    target,
    context,
    isCurrentContext,
  ]);

  const toggleArtifact = useCallback(
    (id: string) => {
      if (
        !review ||
        retainedPublication ||
        pendingPublication.current ||
        id === review.rootArtifactId
      )
        return;
      const next = new Set(selectedArtifactIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setSelectedArtifactIds(next);
      void loadReview(next, selectedConversationIds);
    },
    [loadReview, review, selectedArtifactIds, selectedConversationIds, retainedPublication]
  );

  const toggleConversation = useCallback(
    (id: string) => {
      if (retainedPublication || pendingPublication.current) return;
      const next = new Set(selectedConversationIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setSelectedConversationIds(next);
      void loadReview(selectedArtifactIds, next);
    },
    [loadReview, selectedArtifactIds, selectedConversationIds, retainedPublication]
  );

  const publish = useCallback(async () => {
    if (!target || disabledReason || pendingPublication.current || targetOwner.current !== context)
      return;
    if (!retainedPublication && (!review || reviewOwner.current !== context)) return;
    const contextVersion = reviewContextVersion.current;
    if (!isCurrentContext(contextVersion) || (published && !retainedPublication)) return;
    const pending = {};
    pendingPublication.current = pending;
    setBusy(true);
    setError(null);
    try {
      let result = retainedPublication?.result;
      if (!result) {
        if (!review) return;
        nativeObservation.current?.abort();
        const observation = new AbortController();
        nativeObservation.current = observation;
        const prepared = nativeAction.current;
        const publication = isDesktopRuntime()
          ? prepared
            ? await publishShareAdministration(prepared, observation.signal)
            : {
                ok: false as const,
                code: 'PUBLISH_FAILED' as const,
                message:
                  'The native share preparation is unavailable. Prepare the current selection again.',
              }
          : await platform().cloudSync.publishDeepShare({
              ...selection,
              reviewedDigest: review.digest,
            });
        if (!isCurrentContext(contextVersion)) return;
        if (!publication.ok) {
          setError(toUserMessage(publication, 'sharing.failed'));
          if (publication.code === 'MANIFEST_STALE' && publication.refreshedReview) {
            setReview(publication.refreshedReview);
            setSelectedArtifactIds(
              new Set(publication.refreshedReview.manifest.artifacts.map((artifact) => artifact.id))
            );
            setSelectedConversationIds(
              new Set(publication.refreshedReview.chats.map((chat) => chat.id))
            );
          }
          return;
        }
        result = publication;
        setPublished({
          context,
          contextVersion,
          workspaceUuid: target.repo_uuid,
          rootArtifactId: target.artifact_id,
          reviewedDigest: review.digest,
          result,
        });
      }
      const copied = await copyPublishedShareLink({
        publication: result,
        isCurrent: () => isCurrentContext(contextVersion),
        writeText: (text) => platform().clipboard.writeText(text),
      });
      if (!isCurrentContext(contextVersion) || copied.kind === 'retired') return;
      if (copied.kind === 'copy-failed') {
        const message = 'Deep Share published, but Copy failed. Use Copy published link to retry.';
        setError(toUserMessage(message, 'sharing.failed'));
        if (!review)
          addToast(
            userMessage(
              'notice.deep-share-published-but-copy-failed-use-copy-published-link-to-retry'
            ),
            { definition: 'deep-share-failed' }
          );
        return;
      }
      addToast(
        userMessageWithValues('notice.deep-share-published-and-link-copied-version-value', {
          value0: userMessageValue(result.versionNumber),
        }),
        {
          definition: 'deep-share-control-deep-share-published-and-link-copied-version-9-9-9',
        }
      );
      if (signedInAccountId) acknowledgeShareLink(signedInAccountId, selection);
      nativeAction.current = null;
      setPublished(null);
      reviewOwner.current = null;
      setReview(null);
    } catch (caught) {
      if (!isCurrentContext(contextVersion)) return;
      setError(toUserMessage(caught, 'failure.could-not-publish-deep-share'));
    } finally {
      if (pendingPublication.current === pending) pendingPublication.current = null;
      if (isCurrentContext(contextVersion)) setBusy(false);
    }
  }, [
    addToast,
    review,
    selection,
    target,
    context,
    isCurrentContext,
    disabledReason,
    published,
    retainedPublication,
    signedInAccountId,
  ]);

  const cancel = useCallback(() => {
    if (retainedPublication) {
      reviewOwner.current = null;
      setReview(null);
      setError(null);
      return;
    }
    reviewContextVersion.current += 1;
    reviewOwner.current = null;
    pendingPublication.current = null;
    setPublished(null);
    setReview(null);
    setError(null);
    setBusy(false);
    nativeObservation.current?.abort();
    const prepared = nativeAction.current;
    nativeAction.current = null;
    if (isDesktopRuntime()) {
      if (prepared) void cancelShareAdministration(prepared).catch(() => {});
    } else void platform().cloudSync.cancelDeepShare();
  }, [retainedPublication]);

  if (props.workspaceRootPaths.length === 0 || !props.targetReference) return null;
  const label =
    retainedPublication && !review
      ? busy
        ? 'Copying published link…'
        : 'Copy published link'
      : busy && !review
        ? 'Preparing…'
        : 'Share';
  return (
    <>
      <Tooltip
        content={
          disabledReason != null
            ? toUserMessage(disabledReason, 'sharing.failed')
            : toUserMessage(label, 'sharing.failed')
        }
        side="bottom"
      >
        <Button
          variant="appbar"
          aria-label={label}
          title={
            disabledReason != null
              ? toUserMessage(disabledReason, 'sharing.failed')
              : toUserMessage(label, 'sharing.failed')
          }
          disabled={busy || Boolean(review)}
          data-testid="deep-share-button"
          data-share-disabled-reason={disabledReason ?? undefined}
          onClick={() => void (retainedPublication ? publish() : openReview())}
        >
          <OpenExternalIcon size={12} />
          <span>{label}</span>
        </Button>
      </Tooltip>
      {review && reviewOwner.current === context && (
        <DeepShareManifestDialog
          review={review}
          selectedArtifactIds={selectedArtifactIds}
          selectedConversationIds={selectedConversationIds}
          busy={busy}
          error={error}
          publishedVersionNumber={retainedPublication?.result.versionNumber}
          onToggleArtifact={toggleArtifact}
          onToggleConversation={toggleConversation}
          onPublish={() => void publish()}
          onCancel={cancel}
        />
      )}
    </>
  );
}

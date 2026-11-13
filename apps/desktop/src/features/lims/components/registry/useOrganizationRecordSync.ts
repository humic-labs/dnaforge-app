import { toUserMessage, userMessage } from '@waypoint/user-messages';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { platform } from '../../../../platform';
import { useAuthStore } from '../../../../stores/auth-store';
import type {
  OrganizationRegistryRecordSyncStatus,
  OrganizationRegistrySavedRecordReview,
  OrganizationRegistrySavedRecordResolutionRequest,
} from '../../../../shared/org-registry-sync';
import { emitLimsRegistryChanged, subscribeLimsRegistryChanged } from '../../events';
import { parseOrganizationRegistryRecordSyncEntityId } from '../../../../shared/org-registry-sync';

type ResolutionAttempt = {
  entityId: string;
  accountId: string;
  orgId: string;
  request: OrganizationRegistrySavedRecordResolutionRequest;
  durable: boolean;
};

export function useOrganizationRecordSync(candidateEntityId: string | null) {
  const entityId = (() => {
    try {
      return candidateEntityId === null
        ? null
        : parseOrganizationRegistryRecordSyncEntityId(candidateEntityId);
    } catch {
      return null;
    }
  })();
  const accountId = useAuthStore((store) =>
    store.state.status === 'signed-in' ? store.state.session.accountId : null
  );
  const [snapshot, setSnapshot] = useState<{
    entityId: string;
    accountId: string;
    status: OrganizationRegistryRecordSyncStatus | null;
    review: OrganizationRegistrySavedRecordReview | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const requestRef = useRef(0);
  const resolutionRequestRef = useRef(0);
  const [attempt, setAttempt] = useState<ResolutionAttempt | null>(null);
  const attemptRef = useRef<ResolutionAttempt | null>(null);
  const [resolving, setResolving] = useState(false);
  const resolvingRef = useRef(false);
  const rememberAttempt = useCallback((value: ResolutionAttempt | null) => {
    attemptRef.current = value;
    setAttempt(value);
  }, []);
  const contextRef = useRef({ entityId, accountId });
  contextRef.current = { entityId, accountId };
  const current = useCallback((entity: string, account: string | null) => {
    const auth = useAuthStore.getState().state;
    return (
      contextRef.current.entityId === entity &&
      contextRef.current.accountId === account &&
      (auth.status === 'signed-in' ? auth.session.accountId : null) === account
    );
  }, []);
  const refresh = useCallback(async () => {
    const request = ++requestRef.current;
    if (!accountId || !entityId) {
      setSnapshot(null);
      return null;
    }
    try {
      const result = await platform().cloudSync.getOrganizationRegistryRecordSyncStatus(entityId);
      if (request !== requestRef.current || !current(entityId, accountId)) return null;
      if (!result.ok) {
        resolutionRequestRef.current++;
        resolvingRef.current = false;
        setResolving(false);
        setSnapshot(null);
        setError(toUserMessage(result, 'account.failed'));
        return null;
      }
      if (
        result.accountId !== accountId ||
        (result.status && result.status.entityId !== entityId)
      ) {
        resolutionRequestRef.current++;
        resolvingRef.current = false;
        setResolving(false);
        setSnapshot(null);
        return null;
      }
      if (!result.status) {
        resolutionRequestRef.current++;
        resolvingRef.current = false;
        setResolving(false);
      }
      setSnapshot({ entityId, accountId, status: result.status, review: null });
      if (result.status?.pendingResolution) {
        if (
          attemptRef.current &&
          attemptRef.current.request.resolutionId !== result.status.pendingResolution.resolutionId
        ) {
          resolutionRequestRef.current++;
          resolvingRef.current = false;
          setResolving(false);
        }
        rememberAttempt({
          entityId,
          accountId,
          orgId: result.status.orgId,
          request: result.status.pendingResolution,
          durable: true,
        });
      }
      setError(null);
      if (
        !result.status?.pendingResolution &&
        (result.status?.status === 'conflict' || result.status?.status === 'remote_changes')
      ) {
        try {
          const versions = await platform().cloudSync.getOrganizationRegistrySavedRecordReview(
            result.status.orgId,
            entityId
          );
          if (request !== requestRef.current || !current(entityId, accountId)) return null;
          if (!versions.ok) setError(toUserMessage(versions, 'account.failed'));
          else if (
            versions.review.accountId === accountId &&
            versions.review.entityId === entityId &&
            versions.review.orgId === result.status.orgId
          )
            setSnapshot({ entityId, accountId, status: result.status, review: versions.review });
        } catch (cause) {
          if (request === requestRef.current && current(entityId, accountId))
            setError(toUserMessage(cause, 'failure.the-organization-version-could-not-be-read'));
        }
      }
      return result.status;
    } catch (cause) {
      if (request !== requestRef.current || !current(entityId, accountId)) return null;
      setSnapshot(null);
      setError(toUserMessage(cause, 'failure.organization-synchronization-is-unavailable'));
      return null;
    }
  }, [entityId, accountId, current, rememberAttempt]);

  useLayoutEffect(() => {
    requestRef.current++;
    setSnapshot(null);
    setError(null);
    setBusy(false);
    resolutionRequestRef.current++;
    rememberAttempt(null);
    resolvingRef.current = false;
    setResolving(false);
    return () => {
      requestRef.current++;
      resolutionRequestRef.current++;
    };
  }, [entityId, accountId, rememberAttempt]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(
    () =>
      subscribeLimsRegistryChanged(() => {
        void refresh();
      }),
    [refresh]
  );
  useEffect(() => {
    if (!accountId || !entityId) return;
    return platform().cloudSync.onOrganizationRegistryChanged((event) => {
      if (event.accountId === accountId && current(entityId, accountId)) void refresh();
    });
  }, [accountId, entityId, current, refresh]);
  useEffect(() => {
    const focus = () => {
      void refresh();
    };
    window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
  }, [refresh]);

  const synchronize = useCallback(async () => {
    if (!entityId || !accountId || !current(entityId, accountId)) return;
    setBusy(true);
    try {
      const record = await refresh();
      if (!record || !current(entityId, accountId)) return;
      const result = await platform().cloudSync.syncOrganizationRegistry(record.orgId);
      if (!current(entityId, accountId)) return;
      await refresh();
      if (!current(entityId, accountId)) return;
      if (!result.ok) setError(toUserMessage(result, 'account.failed'));
      else if (result.sync.status !== 'ready')
        setError(
          result.sync.errorMessage != null
            ? toUserMessage(
                result.sync.errorMessage,
                'failure.saved-on-this-device-organization-synchronization-is-pending'
              )
            : userMessage('failure.saved-on-this-device-organization-synchronization-is-pending')
        );
    } catch (cause) {
      if (current(entityId, accountId))
        setError(toUserMessage(cause, 'failure.organization-synchronization-is-unavailable'));
    } finally {
      if (current(entityId, accountId)) setBusy(false);
    }
  }, [entityId, accountId, current, refresh]);
  const status =
    snapshot?.entityId === entityId && snapshot.accountId === accountId ? snapshot.status : null;
  const review =
    snapshot?.entityId === entityId && snapshot.accountId === accountId ? snapshot.review : null;
  const pendingResolution =
    status?.pendingResolution ??
    (attempt?.entityId === entityId &&
    attempt.accountId === accountId &&
    attempt.orgId === status?.orgId
      ? attempt.request
      : null);

  const resolve = useCallback(
    async (choice?: OrganizationRegistrySavedRecordResolutionRequest['choice']) => {
      if (
        !entityId ||
        !accountId ||
        !status ||
        !current(entityId, accountId) ||
        resolvingRef.current
      )
        return null;
      const stored = attemptRef.current;
      const existing =
        status.pendingResolution ??
        (stored?.entityId === entityId &&
        stored.accountId === accountId &&
        stored.orgId === status.orgId
          ? stored.request
          : null);
      if (existing?.entityId !== undefined && existing.entityId !== entityId) {
        setError(
          userMessage(
            'failure.the-approved-change-belongs-to-a-different-record-refresh-its-organiza'
          )
        );
        return null;
      }
      if (!existing && (!choice || !review)) return null;
      const approved: ResolutionAttempt = {
        entityId,
        accountId,
        orgId: status.orgId,
        request: existing ?? {
          entityId,
          resolutionId: crypto.randomUUID(),
          choice: choice!,
          sourceRevision: review!.sourceRevision,
        },
        durable: Boolean(status.pendingResolution || (existing && stored?.durable)),
      };
      rememberAttempt(approved);
      const request = ++resolutionRequestRef.current;
      const isCurrent = () =>
        request === resolutionRequestRef.current &&
        current(entityId, accountId) &&
        (!attemptRef.current ||
          attemptRef.current.request.resolutionId === approved.request.resolutionId);
      resolvingRef.current = true;
      setResolving(true);
      setError(null);

      requestRef.current++;
      try {
        const result = await platform().cloudSync.resolveOrganizationRegistrySavedRecord(
          approved.orgId,
          approved.request
        );
        if (result.ok && result.entity.id === entityId) emitLimsRegistryChanged();
        if (!isCurrent()) return null;
        if (!result.ok) {
          if (result.code === 'REVIEW_CHANGED' && !attemptRef.current?.durable) {
            rememberAttempt(null);
            await refresh();
            if (!isCurrent()) return null;
          }
          setError(toUserMessage(result, 'account.failed'));
          return null;
        }
        if (result.entity.id !== entityId) {
          setError(
            userMessage(
              'failure.the-saved-record-identity-changed-reload-the-record-before-continuing'
            )
          );
          return null;
        }
        return { ...result, request: approved.request, isCurrent };
      } catch (cause) {
        if (isCurrent())
          setError(toUserMessage(cause, 'failure.the-approved-change-could-not-finish'));
        return null;
      } finally {
        if (isCurrent()) {
          resolvingRef.current = false;
          setResolving(false);
        }
      }
    },
    [accountId, status, current, entityId, review, rememberAttempt, refresh]
  );

  const finishResolution = useCallback(
    (request: OrganizationRegistrySavedRecordResolutionRequest) => {
      if (
        !entityId ||
        !current(entityId, accountId) ||
        attemptRef.current?.request.resolutionId !== request.resolutionId
      )
        return;
      requestRef.current++;
      rememberAttempt(null);
      setSnapshot((value) =>
        value?.entityId === entityId && value.accountId === accountId && value.status
          ? { ...value, review: null, status: { ...value.status, pendingResolution: null } }
          : value
      );
    },
    [current, entityId, accountId, rememberAttempt]
  );
  return {
    accountId,
    status,
    review,
    error,
    busy,
    refresh,
    synchronize,
    pendingResolution,
    resolving,
    resolve,
    finishResolution,
  };
}

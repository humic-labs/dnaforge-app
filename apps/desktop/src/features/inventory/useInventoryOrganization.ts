import { useEffect, useMemo, useRef, useState } from 'react';
import {
  normalizeInventoryAmount,
  type InventoryOrganizationTarget,
} from '@waypoint/domain-services';
import { platform } from '../../platform';
import type { WorkspaceSyncOrganizationSummary } from '../../shared/workspace-sync-ipc';
import {
  inventoryOrganizationAttemptReadSchema,
  inventoryOrganizationActionAttemptReadSchema,
  inventoryOrganizationCancelPreviewReadSchema,
  inventoryOrganizationPreviewReadSchema,
  type InventoryOrganizationActionAttempt,
  type InventoryOrganizationAttemptRead,
  type InventoryOrganizationSessionIdentity,
  type InventoryOrganizationSubmitRequest,
} from '../../shared/inventory-organization-client';
import {
  beginInventoryOrganizationDirectory,
  beginInventoryOrganizationSnapshot,
  beginInventoryOrganizationPreview,
  createInventoryOrganizationSession,
  selectInventoryOrganizationSession,
  invalidateInventoryOrganizationSession,
  publishInventoryOrganizationDirectory,
  publishInventoryOrganizationSnapshot,
  publishInventoryOrganizationPreview,
  inventoryOrganizationSessionView,
  type InventoryOrganizationReadTicket,
  type InventoryOrganizationSessionState,
  type InventoryOrganizationClock,
} from '../../shared/inventory-organization-session';

const clock = (): InventoryOrganizationClock => ({
  wallTime: Date.now(),
  monotonicTime: performance.now(),
});
const scopeKey = (
  session: InventoryOrganizationSessionIdentity,
  target: InventoryOrganizationTarget | null
) =>
  target
    ? `${session.accountId}:${session.desktopSessionId}:${target.orgId}:${target.inventoryId}`
    : '';
type Publisher = typeof publishInventoryOrganizationDirectory;
type AttemptDisplay =
  | { kind: 'loading' }
  | { kind: 'busy' }
  | { kind: 'read'; value: InventoryOrganizationAttemptRead }
  | { kind: 'unknown'; attempt: InventoryOrganizationActionAttempt | null; message: string }
  | { kind: 'failed'; message: string };
type ScopedAttempt = { scope: string; display: AttemptDisplay };

export function useInventoryOrganization(identity: InventoryOrganizationSessionIdentity) {
  const clients = useMemo(() => platform(), []);
  const active = useRef(identity);
  active.current = identity;
  const mounted = useRef(true);
  const [state, setState] = useState(() =>
    selectInventoryOrganizationSession(createInventoryOrganizationSession(), identity, null)
  );
  const current = useRef(state);
  const [target, setTarget] = useState<InventoryOrganizationTarget | null>(null);
  const selectedTarget = useRef(target);
  const [orgId, setOrgId] = useState('');
  const [organizations, setOrganizations] = useState<readonly WorkspaceSyncOrganizationSummary[]>(
    []
  );
  const [organizationStatus, setOrganizationStatus] = useState('Loading organizations…');
  const [organizationReload, setOrganizationReload] = useState(0);
  const [attemptState, setAttemptState] = useState<ScopedAttempt | null>(null);
  const attemptRef = useRef(attemptState);
  const attemptGeneration = useRef(0);
  const [attemptFailure, setAttemptFailure] = useState<{ scope: string; message: string } | null>(
    null
  );
  const [draftEpoch, setDraftEpoch] = useState(0);
  const livePreview = useRef<InventoryOrganizationSubmitRequest | null>(null);
  const submitted = useRef<{ scope: string; request: InventoryOrganizationSubmitRequest } | null>(
    null
  );
  const cancelOnCleanup = useRef(() => {});
  const [, tick] = useState(0);
  const commit = (next: InventoryOrganizationSessionState) => {
    current.current = next;
    if (mounted.current) setState(next);
  };
  const setAttempt = (scope: string, display: AttemptDisplay) => {
    const next = { scope, display };
    attemptRef.current = next;
    if (mounted.current) setAttemptState(next);
  };
  const isCurrentScope = (scope: string) =>
    mounted.current &&
    scope === scopeKey(active.current, selectedTarget.current) &&
    active.current.knownAccessTokenExpiresAt > Date.now();
  const coreView = inventoryOrganizationSessionView(state, identity, target, clock());
  const scope = scopeKey(identity, target);
  const attempt =
    identity.knownAccessTokenExpiresAt > Date.now() && attemptState?.scope === scope
      ? attemptState.display
      : null;
  const canBegin = attempt?.kind === 'read' && attempt.value.kind === 'none';
  const view =
    coreView.kind === 'visible'
      ? { ...coreView, canPreview: coreView.canPreview && canBegin }
      : coreView;

  useEffect(() => {
    mounted.current = true;
    let live = true;
    setOrganizationStatus('Loading organizations…');
    void clients.cloudSync
      .listOrganizations()
      .then((result) => {
        if (!live) return;
        setOrganizations(result.ok ? result.organizations : []);
        setOrganizationStatus(result.ok ? '' : result.message);
      })
      .catch(() => {
        if (live) setOrganizationStatus('Organizations are unavailable. Try refreshing.');
      });
    return () => {
      cancelOnCleanup.current();
      live = false;
      mounted.current = false;
      attemptGeneration.current++;
      current.current = invalidateInventoryOrganizationSession(current.current, 'binding-change');
    };
  }, [clients, organizationReload]);

  useEffect(() => {
    const now = clock();
    const remaining = Math.min(
      identity.knownAccessTokenExpiresAt - now.wallTime,
      (state.snapshot?.binding.knownAccessTokenExpiresAt ?? Infinity) - now.wallTime,
      (state.previewExpiresAtMonotonic ?? Infinity) - now.monotonicTime
    );
    if (!Number.isFinite(remaining) || remaining <= 0) return;
    const timer = setTimeout(
      () => {
        cancelOnCleanup.current();
        tick((value) => value + 1);
      },
      Math.min(remaining + 1, 2147483647)
    );
    return () => clearTimeout(timer);
  }, [state, identity.knownAccessTokenExpiresAt]);

  const runRead = async (
    ticket: InventoryOrganizationReadTicket,
    read: () => Promise<unknown>,
    publish: Publisher
  ) => {
    let value: unknown;
    try {
      value = await read();
    } catch {
      value = {
        kind: 'unavailable',
        code: 'INVENTORY_READ_UNAVAILABLE',
        message: 'Organization inventory is unavailable. Refresh to try again.',
        retryable: true,
      };
    }
    try {
      const next = publish(current.current, ticket, value, active.current, clock());
      if (ticket.kind === 'preview') {
        const ready = inventoryOrganizationPreviewReadSchema.parse(value);
        if (ready.kind === 'ready') {
          const handle = {
            expectedAccountId: ready.binding.accountId,
            expectedDesktopSessionId: ready.binding.desktopSessionId,
            target: ready.binding.target,
            previewHandleId: ready.previewHandleId,
          };
          if (
            mounted.current &&
            next.preview?.kind === 'ready' &&
            next.preview.previewHandleId === ready.previewHandleId
          )
            livePreview.current = handle;
          else void clients.inventory.organizationCancelPreview(handle).catch(() => {});
        }
      }
      if (mounted.current) commit(next);
    } catch {
      if (mounted.current)
        commit(
          publish(
            current.current,
            ticket,
            {
              kind: 'unavailable',
              code: 'INVENTORY_READ_INVALID',
              message: 'The inventory response could not be confirmed. Refresh to try again.',
              retryable: true,
            },
            active.current,
            clock()
          )
        );
    }
  };
  const readDirectory = (organization: string) => {
    const started = beginInventoryOrganizationDirectory(
      selectInventoryOrganizationSession(current.current, active.current, current.current.target),
      {
        expectedAccountId: active.current.accountId,
        expectedDesktopSessionId: active.current.desktopSessionId,
        orgId: organization,
      },
      clock()
    );
    const ticket = started.ticket;
    if (ticket.kind !== 'directory') return;
    commit(started.state);
    void runRead(
      ticket,
      () => clients.inventory.organizationDirectory(ticket.request),
      publishInventoryOrganizationDirectory
    );
  };
  const readSnapshot = (selected: InventoryOrganizationTarget) => {
    const started = beginInventoryOrganizationSnapshot(
      selectInventoryOrganizationSession(current.current, active.current, selected),
      {
        expectedAccountId: active.current.accountId,
        expectedDesktopSessionId: active.current.desktopSessionId,
        target: selected,
      },
      clock()
    );
    const ticket = started.ticket;
    if (ticket.kind !== 'snapshot') return;
    commit(started.state);
    void runRead(
      ticket,
      () => clients.inventory.organizationSnapshot(ticket.request),
      publishInventoryOrganizationSnapshot
    );
  };
  const acceptAttempt = (selectedScope: string, value: unknown, query: boolean) => {
    const result = query
      ? inventoryOrganizationAttemptReadSchema.parse(value)
      : inventoryOrganizationActionAttemptReadSchema.parse(value);
    if (!isCurrentScope(selectedScope)) return;
    if (result.kind === 'unavailable') throw Error(result.message);
    if (
      result.session.accountId !== active.current.accountId ||
      result.session.desktopSessionId !== active.current.desktopSessionId ||
      result.session.knownAccessTokenExpiresAt > active.current.knownAccessTokenExpiresAt ||
      result.session.knownAccessTokenExpiresAt <= Date.now()
    )
      throw Error('The inventory account or session changed.');
    const resultTarget = result.kind === 'none' ? result.target : result.attempt.target;
    if (selectedScope !== scopeKey(result.session, resultTarget))
      throw Error('The original report belongs to a different inventory.');
    if (result.kind === 'none' && submitted.current?.scope === selectedScope) {
      setAttempt(selectedScope, {
        kind: 'unknown',
        attempt: null,
        message:
          'The original submission is not confirmed. A missing local lookup is not a no-effect result.',
      });
      return;
    }
    setAttemptFailure(null);
    setAttempt(selectedScope, { kind: 'read', value: result });
    if (result.kind === 'accepted') readSnapshot(result.attempt.target);
  };
  const retainedAttempt = (
    display: AttemptDisplay | null
  ): InventoryOrganizationActionAttempt | null =>
    display?.kind === 'unknown'
      ? display.attempt
      : display?.kind === 'read' && 'attempt' in display.value
        ? display.value.attempt
        : null;
  const failAttempt = (selectedScope: string, error: unknown, previous: AttemptDisplay | null) => {
    if (!isCurrentScope(selectedScope)) return;
    const message =
      error instanceof Error ? error.message : 'The original report could not be confirmed.';
    setAttemptFailure({ scope: selectedScope, message });
    if (
      previous?.kind === 'read' &&
      (previous.value.kind === 'accepted' || previous.value.kind === 'refused')
    )
      setAttempt(selectedScope, previous);
    else if (submitted.current?.scope === selectedScope || retainedAttempt(previous))
      setAttempt(selectedScope, {
        kind: 'unknown',
        attempt: retainedAttempt(previous),
        message:
          'The original report outcome is not confirmed. Check its status or retry the same request.',
      });
    else setAttempt(selectedScope, { kind: 'failed', message });
  };
  const lookupAttempt = async (
    selected: InventoryOrganizationTarget,
    exact?: InventoryOrganizationActionAttempt
  ) => {
    const selectedScope = scopeKey(active.current, selected),
      generation = ++attemptGeneration.current;
    const previous =
      attemptRef.current?.scope === selectedScope ? attemptRef.current.display : null;
    setAttempt(selectedScope, { kind: 'loading' });
    try {
      const value = await clients.inventory.organizationAttempt({
        expectedAccountId: active.current.accountId,
        expectedDesktopSessionId: active.current.desktopSessionId,
        target: selected,
        query: exact
          ? { kind: 'exact', operationId: exact.operationId, requestSha256: exact.requestSha256 }
          : { kind: 'pending' },
      });
      if (generation === attemptGeneration.current) acceptAttempt(selectedScope, value, true);
    } catch (error) {
      if (generation === attemptGeneration.current) failAttempt(selectedScope, error, previous);
    }
  };
  const cancelPreview = () => {
    const request = livePreview.current;
    livePreview.current = null;
    if (!request) return;
    const selectedScope = scopeKey(active.current, request.target);
    void clients.inventory
      .organizationCancelPreview(request)
      .then((value) => {
        const result = inventoryOrganizationCancelPreviewReadSchema.parse(value);
        if (result.kind === 'retained' && isCurrentScope(selectedScope))
          void lookupAttempt(result.attempt.target, result.attempt);
      })
      .catch(() => {});
  };
  cancelOnCleanup.current = cancelPreview;
  const resetScope = () => {
    cancelPreview();
    attemptGeneration.current++;
    submitted.current = null;
    attemptRef.current = null;
    setAttemptState(null);
    setAttemptFailure(null);
  };
  const recover = async (mode: 'inspect' | 'retry-exact' | 'confirm-unsent') => {
    const previous = attemptRef.current?.display,
      selected = selectedTarget.current;
    if (!selected || !previous || previous.kind === 'loading' || previous.kind === 'busy') return;
    const selectedScope = scopeKey(active.current, selected),
      generation = ++attemptGeneration.current;
    const retained = retainedAttempt(previous);
    setAttempt(selectedScope, { kind: 'busy' });
    try {
      let value: unknown;
      if (retained)
        value = await clients.inventory.organizationRecover({
          expectedAccountId: active.current.accountId,
          expectedDesktopSessionId: active.current.desktopSessionId,
          target: selected,
          operationId: retained.operationId,
          requestSha256: retained.requestSha256,
          mode,
        });
      else if (submitted.current?.scope === selectedScope && mode !== 'inspect')
        value = await clients.inventory.organizationSubmit(submitted.current.request);
      else {
        void lookupAttempt(selected);
        return;
      }
      if (generation === attemptGeneration.current) acceptAttempt(selectedScope, value, false);
    } catch (error) {
      if (generation === attemptGeneration.current) failAttempt(selectedScope, error, previous);
    }
  };

  return {
    view,
    organizations,
    organizationStatus,
    orgId,
    target,
    attempt,
    draftEpoch,
    attemptFailure: attemptFailure?.scope === scope ? attemptFailure.message : null,
    chooseOrganization(organization: string) {
      resetScope();
      setOrgId(organization);
      setTarget(null);
      selectedTarget.current = null;
      commit(
        invalidateInventoryOrganizationSession(
          selectInventoryOrganizationSession(current.current, active.current, null),
          'binding-change'
        )
      );
      if (organization) readDirectory(organization);
    },
    chooseInventory(inventoryId: string) {
      resetScope();
      const selected =
        view.kind === 'visible'
          ? (view.directory?.directory.entries.find(
              (entry) => entry.header.target.inventoryId === inventoryId
            )?.header.target ?? null)
          : null;
      setTarget(selected);
      selectedTarget.current = selected;
      commit(selectInventoryOrganizationSession(current.current, active.current, selected));
      if (selected) {
        readSnapshot(selected);
        void lookupAttempt(selected);
      }
    },
    refresh() {
      if (attempt?.kind === 'read' && attempt.value.kind === 'accepted') void recover('inspect');
      else if (target) readSnapshot(target);
      else if (orgId) readDirectory(orgId);
      else setOrganizationReload((value) => value + 1);
    },
    invalidate() {
      cancelPreview();
      commit(invalidateInventoryOrganizationSession(current.current, 'edit'));
    },
    closePreview() {
      cancelPreview();
      commit(invalidateInventoryOrganizationSession(current.current, 'close-preview'));
    },
    previewUse(stockId: string, amount: string, reason: string) {
      cancelPreview();
      const visible = inventoryOrganizationSessionView(
        current.current,
        active.current,
        target,
        clock()
      );
      if (
        visible.kind !== 'visible' ||
        !visible.canPreview ||
        visible.snapshot?.kind !== 'current' ||
        attemptRef.current?.display.kind !== 'read' ||
        attemptRef.current.display.value.kind !== 'none'
      )
        return;
      const { binding, snapshot } = visible.snapshot;
      const started = beginInventoryOrganizationPreview(
        current.current,
        {
          binding,
          request: {
            target: binding.target,
            expectedRevision: snapshot.header.revision,
            accessGeneration: binding.accessGeneration,
            action: {
              kind: 'consume',
              stockId,
              quantity: normalizeInventoryAmount({ value: amount, unit: 'uL' }),
              reason,
            },
          },
        },
        clock()
      );
      const ticket = started.ticket;
      if (ticket.kind !== 'preview') return;
      commit(started.state);
      void runRead(
        ticket,
        () => clients.inventory.organizationPreview(ticket.request),
        publishInventoryOrganizationPreview
      );
    },
    async submit() {
      const request = livePreview.current;
      if (!request || !canBegin) return;
      const visible = inventoryOrganizationSessionView(
        current.current,
        active.current,
        selectedTarget.current,
        clock()
      );
      if (
        visible.kind !== 'visible' ||
        visible.preview?.kind !== 'ready' ||
        visible.preview.previewHandleId !== request.previewHandleId
      )
        return;
      const selectedScope = scopeKey(active.current, request.target),
        generation = ++attemptGeneration.current;
      const previous = attemptRef.current?.display ?? null;
      submitted.current = { scope: selectedScope, request };
      livePreview.current = null;
      setAttempt(selectedScope, { kind: 'busy' });
      commit(invalidateInventoryOrganizationSession(current.current, 'close-preview'));
      try {
        const value = await clients.inventory.organizationSubmit(request);
        if (generation === attemptGeneration.current) acceptAttempt(selectedScope, value, false);
      } catch (error) {
        if (generation === attemptGeneration.current) failAttempt(selectedScope, error, previous);
      }
    },
    checkStatus() {
      if (target && attempt?.kind !== 'loading' && attempt?.kind !== 'busy') {
        if (retainedAttempt(attempt)) void recover('inspect');
        else void lookupAttempt(target);
      }
    },
    recover,
    startAnotherUse() {
      if (
        !target ||
        attempt?.kind !== 'read' ||
        !(
          attempt.value.kind === 'refused' ||
          (attempt.value.kind === 'accepted' && attempt.value.delivery.kind === 'current')
        )
      )
        return;
      submitted.current = null;
      setDraftEpoch((value) => value + 1);
      cancelPreview();
      commit(invalidateInventoryOrganizationSession(current.current, 'close-preview'));
      readSnapshot(target);
      void lookupAttempt(target);
    },
  };
}

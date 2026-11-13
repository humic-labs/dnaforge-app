import {
  userMessage,
  userMessageWithValues,
  userMessageValue,
  type UserMessage,
  toUserMessage,
} from '@waypoint/user-messages';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  OrganizationRegistryClaimPreparationRequest,
  OrganizationRegistryRecordDetails,
  OrganizationRegistryView,
} from '../../../../shared/org-registry-sync';
import type { WorkspaceSyncOrganizationSummary } from '../../../../shared/workspace-sync-ipc';
import { platform } from '../../../../platform';
import { useAuthStore } from '../../../../stores/auth-store';
import { isLimsEntityOpened, openLimsEntity } from '../../open-entity';
import type { PreparedOrganizationRegistryClaim } from './RegistryClaimDialog';
import {
  organizationRegistryProjects,
  organizationRegistryRecords,
  type OrganizationRegistryPlacement,
  type OrganizationRegistryRecord,
  type RegistryProjectBinding,
  type RegistryScope,
} from './RegistryScopeSurface';

async function loadRegistryOrganizationChoices(accountId: string | null) {
  const result = await platform().cloudSync.listOrganizations();
  const cached =
    !result.ok && accountId ? await platform().cloudSync.listCachedOrganizationRegistries() : null;
  const organizations: WorkspaceSyncOrganizationSummary[] = result.ok
    ? result.organizations
    : cached?.ok && cached.accountId === accountId
      ? cached.organizationIds.map((orgId) => ({
          orgId,
          slug: '',
          displayName: `Organization ${orgId}`,
          role: 'cached',
          canCreateManagedProjects: false,
          isAdministrator: false,
        }))
      : [];
  return {
    organizations,
    error: !result.ok && organizations.length === 0 ? result.message : null,
  };
}

export function useOrganizationRegistry({
  setMessage,
  setMessageTone,
}: {
  setMessage: (message: UserMessage | null) => void;
  setMessageTone: (tone: 'success' | 'error') => void;
}) {
  const [registryScope, setRegistryScope] = useState<RegistryScope>('local');
  const [organizationRegistrySearch, setOrganizationRegistrySearch] = useState('');
  const [registryOrganizations, setRegistryOrganizations] = useState<
    WorkspaceSyncOrganizationSummary[]
  >([]);
  const registryOrganizationsRef = useRef(registryOrganizations);
  registryOrganizationsRef.current = registryOrganizations;
  const [selectedRegistryOrgId, setSelectedRegistryOrgId] = useState<string | null>(null);
  const [organizationRegistry, setOrganizationRegistry] = useState<OrganizationRegistryView | null>(
    null
  );
  const [organizationRegistryLoading, setOrganizationRegistryLoading] = useState(false);
  const [organizationRegistryError, setOrganizationRegistryError] = useState<string | null>(null);
  const [registryClaimOpen, setRegistryClaimOpen] = useState(false);
  const [registryPlacementBusyId, setRegistryPlacementBusyId] = useState<string | null>(null);
  const [registryProjects, setRegistryProjects] = useState<RegistryProjectBinding[]>([]);
  const [registryRemoteProjectId, setRegistryRemoteProjectId] = useState<string | null>(null);
  const registryProject =
    registryProjects.find((project) => project.remoteWorkspaceId === registryRemoteProjectId) ??
    null;
  const registryAccountId = useAuthStore((store) =>
    store.state.status === 'signed-in' ? store.state.session.accountId : null
  );
  const organizationRegistryRequestRef = useRef(0);
  const selectedRegistryOrgIdRef = useRef<string | null>(null);
  const registryMutationIsCurrent = useCallback((orgId: string, accountId: string | null) => {
    const auth = useAuthStore.getState().state;
    return (
      selectedRegistryOrgIdRef.current === orgId &&
      (auth.status === 'signed-in' ? auth.session.accountId : null) === accountId
    );
  }, []);
  const [selectedOrganizationRecordId, setSelectedOrganizationRecordId] = useState<string | null>(
    null
  );
  const [organizationDetails, setOrganizationDetails] =
    useState<OrganizationRegistryRecordDetails | null>(null);
  const [organizationDetailsLoading, setOrganizationDetailsLoading] = useState(false);
  const [organizationDetailsError, setOrganizationDetailsError] = useState<string | null>(null);
  const [organizationRecordOpening, setOrganizationRecordOpening] = useState(false);
  const organizationDetailsRequestRef = useRef(0);
  const organizationOpenAbortRef = useRef<AbortController | null>(null);
  const organizationDetailsContext = useMemo(
    () => ({
      accountId: registryAccountId,
      orgId: selectedRegistryOrgId,
      registry: organizationRegistry,
      scope: registryScope,
      projectId: registryRemoteProjectId,
      search: organizationRegistrySearch,
      entityId: selectedOrganizationRecordId,
    }),
    [
      registryAccountId,
      selectedRegistryOrgId,
      organizationRegistry,
      registryScope,
      registryRemoteProjectId,
      organizationRegistrySearch,
      selectedOrganizationRecordId,
    ]
  );
  const organizationDetailsContextRef = useRef(organizationDetailsContext);
  organizationDetailsContextRef.current = organizationDetailsContext;
  useLayoutEffect(
    () => () => {
      organizationOpenAbortRef.current?.abort();
      organizationOpenAbortRef.current = null;
    },
    [organizationDetailsContext]
  );
  const loadedOrganizationDetailsContextRef = useRef<typeof organizationDetailsContext | null>(
    null
  );
  const visibleOrganizationDetails =
    loadedOrganizationDetailsContextRef.current === organizationDetailsContext
      ? organizationDetails
      : null;
  const organizationContextIsCurrent = useCallback((context: typeof organizationDetailsContext) => {
    const auth = useAuthStore.getState().state;
    return (
      organizationDetailsContextRef.current === context &&
      (auth.status === 'signed-in' ? auth.session.accountId : null) === context.accountId
    );
  }, []);
  useEffect(() => {
    const context = organizationDetailsContext;
    const request = ++organizationDetailsRequestRef.current;
    setOrganizationDetails(null);
    setOrganizationDetailsError(null);
    setOrganizationRecordOpening(false);
    const generation = context.registry?.state.accessGeneration;
    const visible =
      context.registry &&
      context.scope !== 'local' &&
      organizationRegistryRecords(
        context.registry,
        context.scope,
        registryProject,
        context.search
      ).some((record) => record.id === context.entityId);
    if (!context.accountId || !context.orgId || !context.entityId || !generation || !visible) {
      setOrganizationDetailsLoading(false);
      if (context.entityId) setSelectedOrganizationRecordId(null);
      return;
    }
    setOrganizationDetailsLoading(true);
    void platform()
      .cloudSync.getOrganizationRegistryRecordDetails(context.orgId, {
        entityId: context.entityId,
        expectedAccessGeneration: generation,
      })
      .then((result) => {
        if (
          request !== organizationDetailsRequestRef.current ||
          !organizationContextIsCurrent(context)
        )
          return;
        if (!result.ok) {
          setOrganizationDetailsError(toUserMessage(result, 'account.failed'));
          return;
        }
        if (
          result.details.scope.accountId !== context.accountId ||
          result.details.scope.orgId !== context.orgId ||
          result.details.scope.accessGeneration !== generation ||
          result.details.entity.id !== context.entityId
        ) {
          setOrganizationDetailsError(
            userMessage(
              'failure.registry-access-changed-refresh-this-organization-before-opening-detai'
            )
          );
          return;
        }
        loadedOrganizationDetailsContextRef.current = context;
        setOrganizationDetails(result.details);
      })
      .catch((error) => {
        if (
          request === organizationDetailsRequestRef.current &&
          organizationContextIsCurrent(context)
        )
          setOrganizationDetailsError(toUserMessage(error, 'failure.details-could-not-be-loaded'));
      })
      .finally(() => {
        if (
          request === organizationDetailsRequestRef.current &&
          organizationContextIsCurrent(context)
        )
          setOrganizationDetailsLoading(false);
      });
    return () => {
      organizationDetailsRequestRef.current++;
    };
  }, [organizationDetailsContext, organizationContextIsCurrent, registryProject]);
  useEffect(() => {
    organizationRegistryRequestRef.current += 1;
    setRegistryScope('local');
    selectedRegistryOrgIdRef.current = null;
    setSelectedRegistryOrgId(null);
    setOrganizationRegistry(null);
    setRegistryOrganizations([]);
    setRegistryProjects([]);
    setRegistryRemoteProjectId(null);
    setRegistryClaimOpen(false);
    setRegistryPlacementBusyId(null);
  }, [registryAccountId]);

  useEffect(() => {
    if (registryScope !== 'local') return;
    let cancelled = false;
    void loadRegistryOrganizationChoices(registryAccountId)
      .then(({ organizations }) => {
        const auth = useAuthStore.getState().state;
        const accountId = auth.status === 'signed-in' ? auth.session.accountId : null;
        if (!cancelled && accountId === registryAccountId) setRegistryOrganizations(organizations);
      })
      .catch(() => {
        const auth = useAuthStore.getState().state;
        const accountId = auth.status === 'signed-in' ? auth.session.accountId : null;
        if (!cancelled && accountId === registryAccountId) setRegistryOrganizations([]);
      });
    return () => {
      cancelled = true;
    };
  }, [registryAccountId, registryScope]);

  const refreshOrganizationRegistry = useCallback(
    async (
      scope: Exclude<RegistryScope, 'local'>,
      preferredOrgId?: string | null,
      synchronize = true
    ) => {
      const requestId = ++organizationRegistryRequestRef.current;
      setOrganizationRegistryLoading(true);
      setOrganizationRegistryError(null);
      try {
        const [choices, directory, localNames] = await Promise.all([
          synchronize
            ? loadRegistryOrganizationChoices(registryAccountId)
            : Promise.resolve({ organizations: registryOrganizationsRef.current, error: null }),
          platform()
            .cloudSync.listSyncedProjects()
            .catch(() => []),
          platform().db.select<RegistryProjectBinding[]>(
            `SELECT b.remote_workspace_id AS remoteWorkspaceId,
                    w.name AS displayName, b.owner_org_id AS ownerOrgId
             FROM workspaces w JOIN workspace_sync_bindings b ON b.workspace_id = w.id
             WHERE b.detached_reason IS NULL AND b.remote_workspace_id IS NOT NULL`
          ),
        ]);
        if (requestId !== organizationRegistryRequestRef.current) return;
        const { organizations } = choices;
        if (choices.error) {
          setRegistryOrganizations([]);
          setSelectedRegistryOrgId(null);
          selectedRegistryOrgIdRef.current = null;
          setRegistryProjects([]);
          setRegistryRemoteProjectId(null);
          setOrganizationRegistry(null);
          setOrganizationRegistryError(toUserMessage(choices.error, 'account.failed'));
          return;
        }

        setRegistryOrganizations(organizations);
        const requestedOrgId = preferredOrgId ?? selectedRegistryOrgIdRef.current;
        const chosen = requestedOrgId
          ? (organizations.find((organization) => organization.orgId === requestedOrgId) ?? null)
          : (organizations[0] ?? null);
        const chosenOrgId = chosen?.orgId ?? null;
        setSelectedRegistryOrgId(chosenOrgId);
        selectedRegistryOrgIdRef.current = chosenOrgId;
        if (!chosenOrgId) {
          if (requestedOrgId)
            setOrganizationRegistryError(
              userMessage(
                'failure.this-organization-registry-is-unavailable-for-the-current-account'
              )
            );
          setOrganizationRegistry(null);
          setRegistryProjects([]);
          setRegistryRemoteProjectId(null);
          return;
        }

        const synchronization = synchronize
          ? await platform().cloudSync.syncOrganizationRegistry(chosenOrgId)
          : null;
        const synchronized =
          synchronization ?? (await platform().cloudSync.getOrganizationRegistry(chosenOrgId));
        if (
          requestId !== organizationRegistryRequestRef.current ||
          !registryMutationIsCurrent(chosenOrgId, registryAccountId)
        )
          return;
        if (!synchronized.ok) {
          setOrganizationRegistry(null);
          setOrganizationRegistryError(toUserMessage(synchronized, 'account.failed'));
          return;
        }
        setOrganizationRegistry(synchronized.registry);
        const projects = organizationRegistryProjects(synchronized.registry, directory, localNames);
        setRegistryProjects(projects);
        setRegistryRemoteProjectId((current) =>
          projects.some((project) => project.remoteWorkspaceId === current) ? current : null
        );
        if (
          synchronization?.ok &&
          (synchronization.sync.status === 'error' ||
            synchronization.sync.status === 'not_configured')
        ) {
          setOrganizationRegistryError(
            synchronization.sync.errorMessage != null
              ? toUserMessage(
                  synchronization.sync.errorMessage,
                  'failure.the-organization-registry-could-not-synchronize'
                )
              : userMessage('failure.the-organization-registry-could-not-synchronize')
          );
        }
      } catch (error) {
        if (requestId !== organizationRegistryRequestRef.current) return;
        setOrganizationRegistryError(
          toUserMessage(error, 'failure.the-organization-registry-could-not-load')
        );
      } finally {
        if (requestId === organizationRegistryRequestRef.current) {
          setOrganizationRegistryLoading(false);
        }
      }
    },
    [registryAccountId, registryMutationIsCurrent]
  );

  useEffect(() => {
    if (registryScope === 'local') {
      organizationRegistryRequestRef.current += 1;
      setOrganizationRegistryLoading(false);
      return;
    }
    void refreshOrganizationRegistry(registryScope);
  }, [refreshOrganizationRegistry, registryScope]);

  useEffect(() => {
    if (registryScope === 'local' || !registryAccountId || !selectedRegistryOrgId) return;
    return platform().cloudSync.onOrganizationRegistryChanged((event) => {
      if (
        event.accountId === registryAccountId &&
        event.orgId === selectedRegistryOrgId &&
        registryMutationIsCurrent(event.orgId, event.accountId)
      )
        void refreshOrganizationRegistry(registryScope, event.orgId, false);
    });
  }, [
    registryAccountId,
    registryScope,
    selectedRegistryOrgId,
    registryMutationIsCurrent,
    refreshOrganizationRegistry,
  ]);

  useEffect(() => {
    if (registryScope === 'local') return;
    const refresh = () => void refreshOrganizationRegistry(registryScope);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refreshOrganizationRegistry, registryScope]);

  const chooseRegistryOrganization = useCallback(
    (orgId: string) => {
      setOrganizationRegistryError(null);
      setOrganizationRegistry(null);
      setRegistryProjects([]);
      setRegistryRemoteProjectId(null);
      setRegistryClaimOpen(false);
      setRegistryPlacementBusyId(null);
      setSelectedRegistryOrgId(orgId);
      selectedRegistryOrgIdRef.current = orgId;
      if (registryScope !== 'local') void refreshOrganizationRegistry(registryScope, orgId);
    },
    [refreshOrganizationRegistry, registryScope]
  );

  const claimLocalRecords = useCallback(
    async (
      claims: PreparedOrganizationRegistryClaim[]
    ): Promise<{ ok: true } | { ok: false; message: string }> => {
      const orgId = selectedRegistryOrgIdRef.current;
      if (!orgId) {
        return { ok: false, message: 'Select an organization before claiming local records.' };
      }

      let completed = 0;
      const auth = useAuthStore.getState().state;
      const accountId = auth.status === 'signed-in' ? auth.session.accountId : null;
      let lastRegistry: OrganizationRegistryView | null = null;
      let queued = 0;
      for (const claim of claims) {
        if (!registryMutationIsCurrent(orgId, accountId))
          return {
            ok: false,
            message:
              'The selected account or organization changed. Review registrations in the current Registry.',
          };
        const result = await platform().cloudSync.claimOrganizationRegistryEntity(orgId, {
          mutationId: claim.mutationId,
          entityId: claim.sourceEntityId,
          schemaId: String(claim.payload.schemaId),
          schemaRevisionId: String(claim.payload.schemaRevisionId),
          sourceRevision: claim.sourceRevision,
        });
        if (!registryMutationIsCurrent(orgId, accountId))
          return {
            ok: false,
            message:
              'The selected account or organization changed. Review registrations in the current Registry.',
          };
        if (!result.ok) {
          if (lastRegistry) setOrganizationRegistry(lastRegistry);
          const prefix =
            completed + queued > 0
              ? `${completed} records registered; ${queued} registrations queued. `
              : '';
          return { ok: false, message: `${prefix}${result.message}` };
        }
        if (result.registration === 'registered') completed += 1;
        else queued += 1;
        lastRegistry = result.registry;
      }

      if (lastRegistry) setOrganizationRegistry(lastRegistry);
      setRegistryClaimOpen(false);
      setMessageTone('success');
      setMessage(
        queued > 0
          ? userMessageWithValues(
              'registry.notice.records-registered-registrations-queued-for-organization-confirmation',
              { value0: userMessageValue(completed), value1: userMessageValue(queued) }
            )
          : userMessageWithValues(
              'registry.notice.registered-with-the-organization-keeping-the-same-identity-and-home-project',
              {
                value0: userMessageValue(completed),
                value1: userMessageValue(
                  completed === 1
                    ? userMessage('registry.notice.record-was')
                    : userMessage('registry.notice.records-were')
                ),
              }
            )
      );
      return { ok: true };
    },
    [registryMutationIsCurrent, setMessage, setMessageTone]
  );

  const addRegistryProjectPlacement = useCallback(
    async (record: OrganizationRegistryRecord): Promise<void> => {
      const orgId = selectedRegistryOrgIdRef.current;
      if (!orgId || !registryProject || registryProject.ownerOrgId !== orgId) return;
      const auth = useAuthStore.getState().state;
      const accountId = auth.status === 'signed-in' ? auth.session.accountId : null;
      setRegistryPlacementBusyId(record.id);
      setMessage(null);
      try {
        const result = await platform().cloudSync.mutateOrganizationRegistry(orgId, {
          mutationId: crypto.randomUUID(),
          operation: 'placement.add',
          payload: {
            id: crypto.randomUUID(),
            entityId: record.id,
            workspaceId: registryProject.remoteWorkspaceId,
          },
        });
        if (!registryMutationIsCurrent(orgId, accountId)) return;
        if (!result.ok) {
          setMessageTone('error');
          setMessage(toUserMessage(result, 'account.failed'));
          return;
        }
        setOrganizationRegistry(result.registry);
        setMessageTone('success');
        setMessage(
          result.sync.status === 'ready'
            ? userMessageWithValues('registry.notice.was-placed-in', {
                value0: userMessageValue(record.registryId),
                value1: userMessageValue(registryProject.displayName),
              })
            : userMessageWithValues('registry.notice.placement-was-queued-for-organization-sync', {
                value0: userMessageValue(record.registryId),
              })
        );
      } finally {
        if (registryMutationIsCurrent(orgId, accountId)) setRegistryPlacementBusyId(null);
      }
    },
    [registryProject, registryMutationIsCurrent, setMessage, setMessageTone]
  );

  const removeRegistryProjectPlacement = useCallback(
    async (placement: OrganizationRegistryPlacement): Promise<void> => {
      const orgId = selectedRegistryOrgIdRef.current;
      if (!orgId || !registryProject || registryProject.ownerOrgId !== orgId) return;
      const auth = useAuthStore.getState().state;
      const accountId = auth.status === 'signed-in' ? auth.session.accountId : null;
      setRegistryPlacementBusyId(placement.id);
      setMessage(null);
      try {
        const result = await platform().cloudSync.mutateOrganizationRegistry(orgId, {
          mutationId: crypto.randomUUID(),
          operation: 'placement.remove',
          payload: { id: placement.id },
        });
        if (!registryMutationIsCurrent(orgId, accountId)) return;
        if (!result.ok) {
          setMessageTone('error');
          setMessage(toUserMessage(result, 'account.failed'));
          return;
        }
        setOrganizationRegistry(result.registry);
        setMessageTone('success');
        setMessage(
          result.sync.status === 'ready'
            ? userMessageWithValues('registry.notice.the-registry-placement-was-removed-from', {
                value0: userMessageValue(registryProject.displayName),
              })
            : userMessage('registry.notice.the-placement-removal-was-queued-for-organization-sync')
        );
      } finally {
        if (registryMutationIsCurrent(orgId, accountId)) setRegistryPlacementBusyId(null);
      }
    },
    [registryProject, registryMutationIsCurrent, setMessage, setMessageTone]
  );
  const openOrganizationRecord = useCallback(
    async (
      record: OrganizationRegistryRecord | undefined,
      onRevealDetails: (record: OrganizationRegistryRecord) => void,
      onOpened: () => void
    ) => {
      const context = organizationDetailsContextRef.current;
      const entityId = record?.id ?? context.entityId;
      const generation = context.registry?.state.accessGeneration;
      if (
        !entityId ||
        !context.orgId ||
        !context.accountId ||
        !generation ||
        context.scope === 'local' ||
        !context.registry
      )
        return;
      if (
        !organizationRegistryRecords(
          context.registry,
          context.scope,
          registryProject,
          context.search
        ).some((candidate) => candidate.id === entityId)
      )
        return;
      const request = ++organizationDetailsRequestRef.current;
      const controller = new AbortController();
      organizationOpenAbortRef.current?.abort();
      organizationOpenAbortRef.current = controller;
      setOrganizationRecordOpening(true);
      setOrganizationDetailsLoading(false);
      setOrganizationDetailsError(null);
      const showFailure = (failure: unknown) => {
        const message = toUserMessage(failure, 'account.failed');
        if (record && context.entityId !== entityId) onRevealDetails(record);
        setOrganizationDetailsError(message);
        setMessageTone('error');
        setMessage(message);
      };
      try {
        const result = await platform().cloudSync.getOrganizationRegistryRecordDetails(
          context.orgId,
          {
            entityId,
            expectedAccessGeneration: generation,
          }
        );
        if (
          request !== organizationDetailsRequestRef.current ||
          !organizationContextIsCurrent(context)
        )
          return;
        if (!result.ok) {
          setOrganizationDetails(null);
          showFailure(result.message);
          return;
        }
        const details = result.details;
        if (
          details.scope.accountId !== context.accountId ||
          details.scope.orgId !== context.orgId ||
          details.scope.accessGeneration !== generation ||
          details.entity.id !== entityId
        ) {
          setOrganizationDetails(null);
          showFailure('Registry access changed. Refresh Details before opening this record.');
          return;
        }
        if (context.entityId === entityId) {
          loadedOrganizationDetailsContextRef.current = context;
          setOrganizationDetails(details);
        }
        if (details.local.status !== 'available') {
          if (record && context.entityId !== entityId) onRevealDetails(record);
          return;
        }
        if (
          details.local.summary.id !== entityId ||
          details.local.homeWorkspaceId !== details.entity.homeWorkspaceId
        ) {
          showFailure('The saved record and its home project no longer agree.');
          return;
        }
        const opened = await openLimsEntity({
          entityId,
          strategy: { kind: 'focused' },
          signal: controller.signal,
        });
        if (
          request !== organizationDetailsRequestRef.current ||
          !organizationContextIsCurrent(context)
        )
          return;
        if (isLimsEntityOpened(opened)) {
          setSelectedOrganizationRecordId(null);
          onOpened();
        } else showFailure(opened.message);
      } catch (error) {
        if (
          request === organizationDetailsRequestRef.current &&
          organizationContextIsCurrent(context)
        )
          showFailure(error);
      } finally {
        if (organizationOpenAbortRef.current === controller)
          organizationOpenAbortRef.current = null;
        if (
          request === organizationDetailsRequestRef.current &&
          organizationContextIsCurrent(context)
        )
          setOrganizationRecordOpening(false);
      }
    },
    [organizationContextIsCurrent, registryProject, setMessage, setMessageTone]
  );

  const prepareRegistryClaim = useCallback(
    async (request: OrganizationRegistryClaimPreparationRequest) => {
      const orgId = selectedRegistryOrgIdRef.current;
      if (!orgId) throw new Error('Select an organization before reviewing a record.');
      const auth = useAuthStore.getState().state;
      const accountId = auth.status === 'signed-in' ? auth.session.accountId : null;
      const result = await platform().cloudSync.prepareOrganizationRegistryClaim(orgId, request);
      if (!registryMutationIsCurrent(orgId, accountId))
        throw new Error('The selected account or organization changed. Review the record again.');
      if (!result.ok) throw new Error(result.message);
      return result.claim;
    },
    [registryMutationIsCurrent]
  );

  return {
    registryAccountId,
    registryScope,
    setRegistryScope,
    organizationRegistrySearch,
    setOrganizationRegistrySearch,
    registryOrganizations,
    selectedRegistryOrgId,
    organizationRegistry,
    organizationRegistryLoading,
    organizationRegistryError,
    registryClaimOpen,
    setRegistryClaimOpen,
    registryPlacementBusyId,
    registryProjects,
    registryRemoteProjectId,
    setRegistryRemoteProjectId,
    registryProject,
    selectedOrganizationRecordId,
    setSelectedOrganizationRecordId,
    visibleOrganizationDetails,
    organizationDetailsLoading,
    organizationDetailsError,
    organizationRecordOpening,
    refreshOrganizationRegistry,
    chooseRegistryOrganization,
    claimLocalRecords,
    addRegistryProjectPlacement,
    removeRegistryProjectPlacement,
    prepareRegistryClaim,
    openOrganizationRecord,
  };
}

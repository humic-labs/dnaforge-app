import {
  toUserMessage,
  userMessage,
  userMessageWithValues,
  userMessageValue,
  type UserMessage,
} from '@waypoint/user-messages';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { platform } from '../../platform';
import { useToastStore } from '../../stores/toast-store';
import type {
  WorkspaceSyncAssignableOrgRole,
  WorkspaceSyncInvitableOrgRole,
  WorkspaceSyncOrgAuditEventView,
  WorkspaceSyncOrgDirectory,
  WorkspaceSyncOrgInviteView,
  WorkspaceSyncOrgRole,
  WorkspaceSyncOrganizationSummary,
  WorkspaceSyncOrganizationProvisioningStatus,
} from '../../shared/workspace-sync-ipc';
import type {
  OrganizationDeletionImpactView,
  OrganizationRegistryConfigurationRequest,
  OrganizationRegistryConflictResolutionRequest,
  OrganizationRegistryOperation,
  OrganizationRegistrySyncHealthView,
  OrganizationRegistrySyncOutcome,
  OrganizationRegistryView,
} from '../../shared/org-registry-sync';

export type OrganizationSettingsSection =
  | 'general'
  | 'members'
  | 'invitations'
  | 'audit'
  | 'registry'
  | 'sync-health'
  | 'provisioning'
  | 'create';

export const ROLE_RANK: Record<WorkspaceSyncOrgRole, number> = {
  owner: 0,
  admin: 10,
  member: 20,
};

export const MANUALLY_ASSIGNABLE_ROLES: WorkspaceSyncInvitableOrgRole[] = [
  'owner',
  'admin',
  'member',
];

const ROLE_LABEL: Record<WorkspaceSyncOrgRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
};

export function orgRoleLabel(role: string): string {
  if (role === 'owner' || role === 'admin' || role === 'member') return ROLE_LABEL[role];
  return role;
}

export function expiresLabel(expiresAt: string): string {
  const days = Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86_400_000);
  if (days <= 0) return 'expired';
  if (days === 1) return 'expires in 1 day';
  return `expires in ${days} days`;
}

export { ROLE_LABEL };

export function slugFromName(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  if (base.length >= 3) return base;
  return `${base || 'org'}-org`.slice(0, 40);
}

export function revokedInviteNotice(count: number): UserMessage {
  return count === 1
    ? userMessage('account.inviteRevoked')
    : userMessageWithValues('account.invitesRevoked', { count: userMessageValue(count) });
}

function actionErrorMessage(
  result: { ok: true } | { ok: false; message: string },
  fallback: string
): string | null {
  return result.ok ? null : result.message || fallback;
}

async function copyText(value: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

export function parseSlugSuggestions(message: string): string[] {
  const match = message.match(/Try ([^.]+)\.?$/);
  if (!match?.[1]) return [];
  return match[1]
    .split(',')
    .map((slug) => slug.trim())
    .filter(Boolean);
}

export function useOrganizationSettings(options: { enabled: boolean; accountId?: string | null }) {
  const addToast = useToastStore((s) => s.addToast);
  const [organizations, setOrganizations] = useState<WorkspaceSyncOrganizationSummary[]>([]);
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);
  const accountKey = options.accountId ?? null;
  const [loadedAccount, setLoadedAccount] = useState<string | null | undefined>(undefined);
  const organizationRequest = useRef(0);
  const scope = useRef({ enabled: options.enabled, accountId: accountKey, orgId: selectedOrgId });
  scope.current = { enabled: options.enabled, accountId: accountKey, orgId: selectedOrgId };
  const activeScope = options.enabled && loadedAccount === accountKey;
  const matchesAccount = (accountId: string | null) =>
    scope.current.enabled && scope.current.accountId === accountId;
  const matchesScope = (accountId: string | null, orgId: string) =>
    matchesAccount(accountId) && scope.current.orgId === orgId;

  const [directory, setDirectory] = useState<WorkspaceSyncOrgDirectory | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setNameState] = useState('');
  const [createSlug, setCreateSlugState] = useState('');
  const [createSlugEdited, setCreateSlugEdited] = useState(false);
  const [createSuggestions, setCreateSuggestions] = useState<string[]>([]);
  const [editName, setEditName] = useState('');
  const [editSlug, setEditSlug] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<WorkspaceSyncInvitableOrgRole>('member');
  const [inviteNotice, setInviteNotice] = useState<string | null>(null);
  const [lastAcceptUrl, setLastAcceptUrl] = useState<string | null>(null);
  const [auditEvents, setAuditEvents] = useState<WorkspaceSyncOrgAuditEventView[]>([]);
  const [auditTypes, setAuditTypes] = useState<string[]>([]);
  const [auditFilter, setAuditFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const [registry, setRegistry] = useState<OrganizationRegistryView | null>(null);
  const [registrySync, setRegistrySync] = useState<OrganizationRegistrySyncOutcome | null>(null);
  const [registryHealth, setRegistryHealth] = useState<OrganizationRegistrySyncHealthView | null>(
    null
  );
  const [deletionImpact, setDeletionImpact] = useState<OrganizationDeletionImpactView | null>(null);
  const [registryLoading, setRegistryLoading] = useState(false);
  const [provisioningStatus, setProvisioningStatus] =
    useState<WorkspaceSyncOrganizationProvisioningStatus | null>(null);
  const [provisioningLoading, setProvisioningLoading] = useState(false);
  const [provisioningError, setProvisioningError] = useState<string | null>(null);

  const selected = useMemo(
    () => organizations.find((org) => org.orgId === selectedOrgId) ?? null,
    [organizations, selectedOrgId]
  );

  async function refreshOrganizations(
    selectOrgId?: string
  ): Promise<WorkspaceSyncOrganizationSummary[]> {
    const cloudSync = platform().cloudSync;
    if (!cloudSync?.listOrganizations) {
      setLoadedAccount(accountKey);
      setOrganizations([]);
      return [];
    }
    const serial = ++organizationRequest.current;
    const result = await cloudSync.listOrganizations();
    if (!matchesAccount(accountKey) || serial !== organizationRequest.current) return [];
    setLoadedAccount(accountKey);
    if (!result.ok) {
      setError(toUserMessage(result, 'account.failed'));
      setOrganizations([]);
      return [];
    }
    setOrganizations(result.organizations);
    const requested = selectOrgId ?? selectedOrgId;
    const nextId = result.organizations.some((org) => org.orgId === requested)
      ? requested
      : (result.organizations[0]?.orgId ?? null);
    setSelectedOrgId(nextId);
    return result.organizations;
  }

  async function refreshDirectory(orgId: string, options: { quiet?: boolean } = {}): Promise<void> {
    const cloudSync = platform().cloudSync;
    if (!cloudSync?.listOrganizationDirectory) {
      if (!options.quiet) setDirectory(null);
      return;
    }
    const result = await cloudSync.listOrganizationDirectory(orgId);
    if (!matchesScope(accountKey, orgId)) return;
    if (!result.ok) {
      if (!options.quiet) {
        setDirectory(null);
        setError(toUserMessage(result, 'account.failed'));
      }
      return;
    }
    setDirectory(result.directory);
    if (!options.quiet) {
      setEditName(result.directory.displayName);
      setEditSlug(result.directory.slug);
      setDeleteConfirm('');
    }
  }

  async function refreshAudit(orgId: string, type?: string): Promise<void> {
    const cloudSync = platform().cloudSync;
    if (!cloudSync?.listOrganizationAudit) {
      setAuditEvents([]);
      setAuditTypes([]);
      return;
    }
    const result = await cloudSync.listOrganizationAudit(orgId, type || undefined);
    if (!matchesScope(accountKey, orgId)) return;
    if (!result.ok) {
      setAuditEvents([]);
      setError(toUserMessage(result, 'account.failed'));
      return;
    }
    setAuditEvents(result.events);
    setAuditTypes(result.eventTypes);
  }

  async function refreshProvisioning(orgId: string, quiet = false): Promise<void> {
    const cloudSync = platform().cloudSync;
    if (!cloudSync?.getOrganizationProvisioningStatus) {
      setProvisioningStatus(null);
      return;
    }
    if (!quiet) setProvisioningLoading(true);
    const result = await cloudSync.getOrganizationProvisioningStatus(orgId);
    if (!matchesScope(accountKey, orgId)) return;
    if (result.ok) {
      setProvisioningStatus(result.status);
      setProvisioningError(null);
    } else {
      setProvisioningStatus(null);
      if (!quiet) setProvisioningError(toUserMessage(result, 'account.failed'));
    }
    if (!quiet) setProvisioningLoading(false);
  }

  async function refreshRegistry(orgId: string, options: { quiet?: boolean } = {}): Promise<void> {
    const cloudSync = platform().cloudSync;
    if (!cloudSync?.syncOrganizationRegistry) {
      setRegistry(null);
      setRegistrySync(null);
      return;
    }
    if (!options.quiet) setRegistryLoading(true);
    const result = await cloudSync.syncOrganizationRegistry(orgId);
    if (!matchesScope(accountKey, orgId)) return;
    if (!result.ok) {
      if (!options.quiet) setError(toUserMessage(result, 'account.failed'));
    } else {
      setRegistry(result.registry);
      setRegistrySync(result.sync);
    }

    const organization = organizations.find((item) => item.orgId === orgId);
    if (organization?.isAdministrator) {
      const [healthResult, impactResult] = await Promise.all([
        cloudSync.getOrganizationRegistrySyncHealth?.(orgId),
        cloudSync.getOrganizationDeletionImpact?.(orgId),
      ]);
      if (!matchesScope(accountKey, orgId)) return;
      if (healthResult?.ok) setRegistryHealth(healthResult.health);
      else setRegistryHealth(null);
      if (impactResult?.ok) setDeletionImpact(impactResult.impact);
      else setDeletionImpact(null);
    } else {
      setRegistryHealth(null);
      setDeletionImpact(null);
    }
    if (!options.quiet) setRegistryLoading(false);
  }

  useEffect(() => {
    setDirectory(null);
    setRegistry(null);
    setRegistrySync(null);
    setRegistryHealth(null);
    setDeletionImpact(null);
    setBusy(false);
    if (!options.enabled) {
      setOrganizations([]);
      setSelectedOrgId(null);
      setDirectory(null);
      setError(null);
      setLoaded(false);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setError(null);
    setLoaded(false);
    setLoading(true);
    void refreshOrganizations()
      .catch(() => {
        if (!cancelled) setError(userMessage('failure.could-not-load-organizations'));
      })
      .finally(() => {
        if (!cancelled) {
          setLoadedAccount(accountKey);
          setLoaded(true);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.enabled, accountKey]);

  useEffect(() => {
    if (!activeScope || !selectedOrgId || creating) {
      if (!selectedOrgId) setDirectory(null);
      return;
    }
    setDirectory(null);
    let cancelled = false;
    void refreshDirectory(selectedOrgId).catch(() => {
      if (!cancelled) setError(userMessage('failure.could-not-load-members'));
    });
    const refreshAfterReconnect = () => {
      if (!cancelled) void refreshDirectory(selectedOrgId, { quiet: true });
    };
    const refreshAfterFocus = () => {
      if (!cancelled && document.visibilityState !== 'hidden') {
        void refreshDirectory(selectedOrgId, { quiet: true });
      }
    };
    window.addEventListener('online', refreshAfterReconnect);
    window.addEventListener('focus', refreshAfterFocus);
    document.addEventListener('visibilitychange', refreshAfterFocus);
    return () => {
      cancelled = true;
      window.removeEventListener('online', refreshAfterReconnect);
      window.removeEventListener('focus', refreshAfterFocus);
      document.removeEventListener('visibilitychange', refreshAfterFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.enabled, accountKey, loadedAccount, selectedOrgId, creating]);

  useEffect(() => {
    if (!activeScope || !selectedOrgId || !directory?.viewer.canViewAudit) {
      setAuditEvents([]);
      return;
    }
    let cancelled = false;
    void refreshAudit(selectedOrgId, auditFilter).catch(() => {
      if (!cancelled) setError(userMessage('failure.could-not-load-the-audit-log'));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    options.enabled,
    accountKey,
    loadedAccount,
    selectedOrgId,
    directory?.viewer.canViewAudit,
    auditFilter,
  ]);

  useEffect(() => {
    if (!activeScope || !selectedOrgId || creating) {
      if (!selectedOrgId) {
        setRegistry(null);
        setRegistrySync(null);
        setRegistryHealth(null);
        setDeletionImpact(null);
      }
      return;
    }
    let cancelled = false;
    void refreshRegistry(selectedOrgId).catch(() => {
      if (!cancelled) {
        setRegistryLoading(false);
        setError(userMessage('failure.could-not-load-the-organization-registry'));
      }
    });
    const refreshAfterReconnect = () => {
      if (!cancelled) void refreshRegistry(selectedOrgId, { quiet: true });
    };
    const refreshAfterFocus = () => {
      if (!cancelled && document.visibilityState !== 'hidden') {
        void refreshRegistry(selectedOrgId, { quiet: true });
      }
    };
    window.addEventListener('online', refreshAfterReconnect);
    window.addEventListener('focus', refreshAfterFocus);
    document.addEventListener('visibilitychange', refreshAfterFocus);
    return () => {
      cancelled = true;
      window.removeEventListener('online', refreshAfterReconnect);
      window.removeEventListener('focus', refreshAfterFocus);
      document.removeEventListener('visibilitychange', refreshAfterFocus);
    };

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.enabled, accountKey, loadedAccount, selectedOrgId, creating, organizations]);

  useEffect(() => {
    if (!activeScope || !selectedOrgId || !directory?.viewer.canConfigureProvisioning) {
      setProvisioningStatus(null);
      setProvisioningLoading(false);
      setProvisioningError(null);
      return;
    }
    let cancelled = false;
    void refreshProvisioning(selectedOrgId).catch(() => {
      if (!cancelled) {
        setProvisioningStatus(null);
        setProvisioningLoading(false);
        setProvisioningError(userMessage('failure.could-not-load-directory-provisioning'));
      }
    });
    const refreshAfterFocus = () => {
      if (!cancelled && document.visibilityState !== 'hidden') {
        void refreshProvisioning(selectedOrgId, true);
      }
    };
    window.addEventListener('focus', refreshAfterFocus);
    document.addEventListener('visibilitychange', refreshAfterFocus);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', refreshAfterFocus);
      document.removeEventListener('visibilitychange', refreshAfterFocus);
    };

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    options.enabled,
    accountKey,
    loadedAccount,
    selectedOrgId,
    directory?.viewer.canConfigureProvisioning,
  ]);

  function selectOrganization(orgId: string): void {
    scope.current.orgId = orgId;
    setBusy(false);
    setRegistryLoading(false);
    setCreating(false);
    setError(null);
    setInviteEmail('');
    setInviteNotice(null);
    setLastAcceptUrl(null);
    setAuditFilter('');
    setSelectedOrgId(orgId);
  }

  function setName(value: string): void {
    setNameState(value);
    if (!createSlugEdited) setCreateSlugState(slugFromName(value));
  }

  function setCreateSlug(value: string): void {
    setCreateSlugEdited(true);
    setCreateSlugState(value.toLowerCase());
  }

  async function handleCreate(event: FormEvent): Promise<void> {
    event.preventDefault();
    const cloudSync = platform().cloudSync;
    if (!cloudSync?.createOrganization) return;
    const displayName = name.trim();
    const slug = createSlug.trim() || slugFromName(displayName);
    setError(null);
    setCreateSuggestions([]);
    setBusy(true);
    const result = await cloudSync.createOrganization({ displayName, slug });
    setBusy(false);
    const message = actionErrorMessage(result, 'Could not create the organization.');
    if (message) {
      setError(toUserMessage(message, 'account.failed'));
      setCreateSuggestions(parseSlugSuggestions(message));
      return;
    }
    if (!result.ok) return;
    setNameState('');
    setCreateSlugState('');
    setCreateSlugEdited(false);
    setCreateSuggestions([]);
    setCreating(false);
    addToast(
      userMessageWithValues('notice.created-value', {
        value0: userMessageValue(result.displayName),
      }),
      {
        definition: 'use-organization-settings-created-example',
      }
    );
    await refreshOrganizations(result.orgId);
  }

  async function handleInvite(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!selectedOrgId) return;
    const cloudSync = platform().cloudSync;
    if (!cloudSync?.inviteOrganizationMember) return;
    const email = inviteEmail.trim();
    setError(null);
    setInviteNotice(null);
    setBusy(true);
    const result = await cloudSync.inviteOrganizationMember(selectedOrgId, {
      email,
      roleId: inviteRole,
    });
    setBusy(false);
    const message = actionErrorMessage(result, 'Could not send the invite.');
    if (message) {
      setError(toUserMessage(message, 'account.failed'));
      return;
    }
    if (!result.ok) return;
    setInviteEmail('');
    await applyInviteResult(result);
    await refreshDirectory(selectedOrgId);
  }

  async function applyInviteResult(result: {
    email: string;
    emailSent: boolean;
    emailDeliveryStatus?: 'pending' | 'retrying' | 'accepted' | 'failed' | 'uncertain' | 'canceled';
    emailError?: 'email_unconfigured' | 'email_failed';
    acceptUrl: string;
  }): Promise<void> {
    setLastAcceptUrl(result.emailSent ? null : result.acceptUrl || null);
    if (result.emailDeliveryStatus === 'pending' || result.emailDeliveryStatus === 'retrying') {
      setInviteNotice(
        `Invite created for ${result.email}. Email delivery is queued and will retry automatically.`
      );
      return;
    }
    if (result.emailDeliveryStatus === 'uncertain') {
      setInviteNotice(
        `Invite created for ${result.email}. Email delivery could not be confirmed. You can copy and share the invitation link.`
      );
      return;
    }
    if (result.emailSent) {
      setInviteNotice(`Invitation sent to ${result.email}.`);
      addToast(
        userMessageWithValues('notice.invited-value', { value0: userMessageValue(result.email) }),
        {
          definition: 'use-organization-settings-invited-example-example-com',
        }
      );
      return;
    }
    const copied = result.acceptUrl ? await copyText(result.acceptUrl) : false;
    if (result.emailError === 'email_failed') {
      setInviteNotice(
        copied
          ? `Invite created for ${result.email}, but email delivery failed. Link copied.`
          : `Invite created for ${result.email}, but email delivery failed.`
      );
    } else {
      setInviteNotice(
        copied
          ? `Invite created for ${result.email} (email not configured). Link copied.`
          : `Invite created for ${result.email} (email not configured).`
      );
    }
    addToast(
      copied
        ? userMessageWithValues('notice.invite-copied-for-value', {
            value0: userMessageValue(result.email),
          })
        : userMessageWithValues('notice.invited-value-email-was-not-sent', {
            value0: userMessageValue(result.email),
          }),
      {
        definition: 'use-organization-settings-invited-example-example-com-email-was-not-sent',
        variant: copied ? 'success' : 'warning',
      }
    );
  }

  async function handleRoleChange(accountId: string, roleId: WorkspaceSyncOrgRole): Promise<void> {
    if (!selectedOrgId) return;
    const cloudSync = platform().cloudSync;
    if (!cloudSync?.changeOrganizationMemberRole) return;
    setError(null);
    setBusy(true);
    const result = await cloudSync.changeOrganizationMemberRole(selectedOrgId, accountId, {
      roleId,
    });
    setBusy(false);
    const message = actionErrorMessage(result, 'Could not change the role.');
    if (message) {
      setError(toUserMessage(message, 'account.failed'));
      return;
    }
    if (result.ok && result.revokedInviteCount) {
      addToast(revokedInviteNotice(result.revokedInviteCount), {
        definition: 'use-organization-settings-handle-role-change',
      });
    }
    await refreshDirectory(selectedOrgId);
  }

  async function handleRemove(accountId: string): Promise<void> {
    if (!selectedOrgId) return;
    const leaving = accountId === directory?.viewer.accountId;
    const cloudSync = platform().cloudSync;
    if (!cloudSync?.removeOrganizationMember) return;
    setError(null);
    setBusy(true);
    const result = await cloudSync.removeOrganizationMember(selectedOrgId, accountId);
    setBusy(false);
    const message = actionErrorMessage(
      result,
      leaving ? 'Could not leave the organization.' : 'Could not remove the member.'
    );
    if (message) {
      setError(toUserMessage(message, 'account.failed'));
      return;
    }
    if (result.ok && result.revokedInviteCount) {
      addToast(revokedInviteNotice(result.revokedInviteCount), {
        definition: 'use-organization-settings-handle-remove',
      });
    }
    if (leaving) {
      addToast(userMessage('notice.you-left-the-organization'), {
        definition: 'use-organization-settings-you-left-the-organization',
      });
      const remaining = await refreshOrganizations();
      if (remaining[0]) await refreshDirectory(remaining[0].orgId);
      else {
        setDirectory(null);
        setCreating(true);
      }
      return;
    }
    await refreshDirectory(selectedOrgId);
  }

  async function handleTransfer(accountId: string): Promise<void> {
    if (!selectedOrgId) return;
    const cloudSync = platform().cloudSync;
    if (!cloudSync?.transferOrganizationOwnership) return;
    setError(null);
    setBusy(true);
    const result = await cloudSync.transferOrganizationOwnership(selectedOrgId, accountId);
    setBusy(false);
    const message = actionErrorMessage(result, 'Could not transfer ownership.');
    if (message) {
      setError(toUserMessage(message, 'account.failed'));
      return;
    }
    addToast(userMessage('notice.ownership-transferred-you-are-now-an-admin'), {
      definition: 'use-organization-settings-ownership-transferred-you-are-now-an-admin',
    });
    await refreshOrganizations(selectedOrgId);
    await refreshDirectory(selectedOrgId);
  }

  async function handleResend(invite: WorkspaceSyncOrgInviteView): Promise<void> {
    if (!selectedOrgId) return;
    const cloudSync = platform().cloudSync;
    if (!cloudSync?.resendOrganizationInvite) return;
    setError(null);
    setInviteNotice(null);
    setBusy(true);
    const result = await cloudSync.resendOrganizationInvite(selectedOrgId, invite.id);
    setBusy(false);
    const message = actionErrorMessage(result, 'Could not resend the invite.');
    if (message) {
      setError(toUserMessage(message, 'account.failed'));
      return;
    }
    if (!result.ok) return;
    await applyInviteResult(result);
    await refreshDirectory(selectedOrgId);
  }

  async function handleCopyAcceptUrl(): Promise<void> {
    if (!lastAcceptUrl) return;
    if (await copyText(lastAcceptUrl)) {
      addToast(userMessage('notice.invite-link-copied'), {
        definition: 'use-organization-settings-invite-link-copied',
      });
    } else {
      setError(userMessage('failure.could-not-copy-the-invite-link'));
    }
  }

  function handleCancelGeneral(): void {
    if (!directory) return;
    setEditName(directory.displayName);
    setEditSlug(directory.slug);
    setError(null);
  }

  async function handleSaveGeneral(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!selectedOrgId) return;
    const cloudSync = platform().cloudSync;
    if (!cloudSync?.updateOrganization) return;
    setError(null);
    setBusy(true);
    const result = await cloudSync.updateOrganization(selectedOrgId, {
      displayName: editName.trim(),
      slug: editSlug.trim(),
    });
    setBusy(false);
    const message = actionErrorMessage(result, 'Could not save changes.');
    if (message) {
      setError(toUserMessage(message, 'account.failed'));
      return;
    }
    if (!result.ok) return;
    addToast(userMessage('notice.saved-organization-settings'), {
      definition: 'use-organization-settings-saved-organization-settings',
    });
    await refreshOrganizations(result.orgId);
    await refreshDirectory(result.orgId);
  }

  async function handleDelete(): Promise<void> {
    if (!selectedOrgId || !directory) return;
    if (deleteConfirm !== directory.displayName) {
      setError(userMessage('failure.type-the-organization-name-exactly-to-confirm'));
      return;
    }
    const cloudSync = platform().cloudSync;
    if (!cloudSync?.deleteOrganization) return;
    setError(null);
    setBusy(true);
    if (!cloudSync.getOrganizationDeletionImpact) {
      setBusy(false);
      setError(userMessage('failure.could-not-verify-that-this-organization-is-empty'));
      return;
    }
    const impactResult = await cloudSync.getOrganizationDeletionImpact(selectedOrgId);
    if (!impactResult.ok) {
      setBusy(false);
      setDeletionImpact(null);
      setError(
        toUserMessage(impactResult, 'failure.could-not-verify-that-this-organization-is-empty')
      );
      return;
    }
    setDeletionImpact(impactResult.impact);
    if (!impactResult.impact.canDelete) {
      setBusy(false);
      setError(
        userMessage(
          'failure.transfer-or-archive-organization-projects-and-registry-records-before-'
        )
      );
      return;
    }
    const result = await cloudSync.deleteOrganization(selectedOrgId);
    setBusy(false);
    const message = actionErrorMessage(result, 'Could not delete the organization.');
    if (message) {
      setError(toUserMessage(message, 'account.failed'));
      return;
    }
    addToast(
      userMessageWithValues('notice.deleted-value', {
        value0: userMessageValue(directory.displayName),
      }),
      {
        definition: 'use-organization-settings-deleted-example',
      }
    );
    setDeleteConfirm('');
    const remaining = await refreshOrganizations();
    if (remaining[0]) await refreshDirectory(remaining[0].orgId);
    else setCreating(true);
  }

  async function handleRevoke(inviteId: string): Promise<void> {
    if (!selectedOrgId) return;
    const cloudSync = platform().cloudSync;
    if (!cloudSync?.revokeOrganizationInvite) return;
    setError(null);
    setBusy(true);
    const result = await cloudSync.revokeOrganizationInvite(selectedOrgId, inviteId);
    setBusy(false);
    const message = actionErrorMessage(result, 'Could not revoke the invite.');
    if (message) {
      setError(toUserMessage(message, 'account.failed'));
      return;
    }
    await refreshDirectory(selectedOrgId);
  }

  async function handleOpenProvisioningPortal(): Promise<void> {
    if (!selectedOrgId) return;
    const cloudSync = platform().cloudSync;
    if (!cloudSync?.openOrganizationProvisioningPortal) return;
    setError(null);
    setBusy(true);
    const result = await cloudSync.openOrganizationProvisioningPortal(selectedOrgId);
    setBusy(false);
    const message = actionErrorMessage(result, 'Could not open directory setup.');
    if (message) {
      setError(toUserMessage(message, 'account.failed'));
      return;
    }
    addToast(userMessage('notice.directory-setup-opened-in-your-browser'), {
      definition: 'use-organization-settings-directory-setup-opened-in-your-browser',
    });
    await refreshProvisioning(selectedOrgId, true);
  }

  async function handleProvisioningGroupRole(
    externalGroupId: string,
    roleId: WorkspaceSyncAssignableOrgRole
  ): Promise<void> {
    if (!selectedOrgId) return;
    const cloudSync = platform().cloudSync;
    if (!cloudSync?.setOrganizationProvisioningGroupRole) return;
    setError(null);
    setBusy(true);
    const result = await cloudSync.setOrganizationProvisioningGroupRole(selectedOrgId, {
      externalGroupId,
      roleId,
    });
    setBusy(false);
    const message = actionErrorMessage(result, 'Could not save the directory group role.');
    if (message) {
      setError(toUserMessage(message, 'account.failed'));
      return;
    }
    addToast(userMessage('notice.directory-group-role-saved'), {
      definition: 'use-organization-settings-directory-group-role-saved',
    });
    await refreshProvisioning(selectedOrgId, true);
  }

  async function configureRegistry(
    request: OrganizationRegistryConfigurationRequest
  ): Promise<boolean> {
    if (!selectedOrgId || !matchesScope(accountKey, selectedOrgId)) return false;
    const cloudSync = platform().cloudSync;
    if (!cloudSync?.configureOrganizationRegistry) return false;
    setError(null);
    setBusy(true);
    const result = await cloudSync.configureOrganizationRegistry(selectedOrgId, request);
    if (!matchesScope(accountKey, selectedOrgId)) return false;
    setBusy(false);
    if (!result.ok) {
      setError(toUserMessage(result, 'account.failed'));
      return false;
    }
    setRegistry(result.registry);
    setRegistrySync({
      status: 'ready',
      cursor: result.registry.state.cursor,
      pendingCount: result.registry.pendingMutations.filter((item) =>
        ['pending', 'sending', 'retry_wait'].includes(item.status)
      ).length,
      conflictCount: result.registry.conflicts.length,
    });
    addToast(userMessage('notice.organization-registry-configured'), {
      definition: 'use-organization-settings-organization-registry-configured',
    });
    await refreshRegistry(selectedOrgId, { quiet: true });
    return true;
  }

  async function mutateRegistry(
    operation: OrganizationRegistryOperation,
    payload: Record<string, unknown>
  ): Promise<boolean> {
    if (!selectedOrgId || !matchesScope(accountKey, selectedOrgId)) return false;
    const cloudSync = platform().cloudSync;
    if (!cloudSync?.mutateOrganizationRegistry) return false;
    setError(null);
    setBusy(true);
    const result = await cloudSync.mutateOrganizationRegistry(selectedOrgId, {
      mutationId: crypto.randomUUID(),
      operation,
      payload,
    });
    if (!matchesScope(accountKey, selectedOrgId)) return false;
    setBusy(false);
    if (!result.ok) {
      setError(toUserMessage(result, 'account.failed'));
      return false;
    }
    setRegistry(result.registry);
    setRegistrySync(result.sync);
    if (result.sync.status === 'ready')
      addToast(userMessage('notice.registry-change-synchronized'), {
        definition: 'use-organization-settings-registry-change-synchronized',
      });
    else if (result.sync.status === 'error')
      addToast(userMessage('notice.registry-change-queued-for-retry'), {
        definition: 'use-organization-settings-registry-change-queued-for-retry',
      });
    return true;
  }

  async function resolveRegistryConflict(
    request: OrganizationRegistryConflictResolutionRequest
  ): Promise<boolean> {
    if (!selectedOrgId || !matchesScope(accountKey, selectedOrgId)) return false;
    const cloudSync = platform().cloudSync;
    if (!cloudSync?.resolveOrganizationRegistryConflict) return false;
    setError(null);
    setBusy(true);
    const result = await cloudSync.resolveOrganizationRegistryConflict(selectedOrgId, request);
    if (!matchesScope(accountKey, selectedOrgId)) return false;
    setBusy(false);
    if (!result.ok) {
      setError(toUserMessage(result, 'account.failed'));
      return false;
    }
    setRegistry(result.registry);
    addToast(
      request.resolution === 'use_remote'
        ? userMessage('notice.kept-the-organization-version')
        : userMessage('notice.queued-the-revised-local-change'),
      { definition: 'use-organization-settings-queued-the-revised-local-change' }
    );
    return true;
  }

  return {
    organizations: activeScope ? organizations : [],
    selected: activeScope ? selected : null,
    selectedOrgId: activeScope ? selectedOrgId : null,
    directory: activeScope && directory?.orgId === selectedOrgId ? directory : null,
    loaded: activeScope && loaded,
    loading: options.enabled && (loading || !activeScope),
    busy: activeScope && busy,
    error: activeScope ? (error ?? provisioningError) : null,
    name,
    setName,
    createSlug,
    setCreateSlug,
    createSuggestions,
    editName,
    setEditName,
    editSlug,
    setEditSlug,
    deleteConfirm,
    setDeleteConfirm,
    inviteEmail,
    setInviteEmail,
    inviteRole,
    setInviteRole,
    inviteNotice,
    lastAcceptUrl,
    creating,
    setCreating,
    viewer: activeScope && directory?.orgId === selectedOrgId ? directory.viewer : null,
    canInvite:
      activeScope && directory?.orgId === selectedOrgId && Boolean(directory.viewer.canInvite),
    canViewAudit:
      activeScope && directory?.orgId === selectedOrgId && Boolean(directory.viewer.canViewAudit),
    auditEvents: activeScope ? auditEvents : [],
    auditTypes: activeScope ? auditTypes : [],
    auditFilter,
    setAuditFilter,
    registry: activeScope && registry?.orgId === selectedOrgId ? registry : null,
    registrySync: activeScope && registry?.orgId === selectedOrgId ? registrySync : null,
    registryHealth: activeScope ? registryHealth : null,
    deletionImpact: activeScope ? deletionImpact : null,
    registryLoading,
    provisioningStatus: activeScope ? provisioningStatus : null,
    provisioningLoading,
    refreshRegistry,
    refreshDirectory,
    refreshOrganizations,
    configureRegistry,
    mutateRegistry,
    resolveRegistryConflict,
    selectOrganization,
    handleCreate,
    handleSaveGeneral,
    handleCancelGeneral,
    handleDelete,
    handleInvite,
    handleRoleChange,
    handleRemove,
    handleTransfer,
    handleResend,
    handleCopyAcceptUrl,
    handleRevoke,
    handleOpenProvisioningPortal,
    handleProvisioningGroupRole,
  };
}

export type OrganizationSettingsModel = ReturnType<typeof useOrganizationSettings>;

import { toUserMessage } from '@waypoint/user-messages';
import { OrganizationRegistrationSettings } from './OrganizationRegistrationSettings';
import { settingsRowProps } from '../../components/settings-catalog';
import {
  SETTINGS_DANGER_BUTTON_CLASS,
  SETTINGS_FIELD_CLASS,
  SETTINGS_PRIMARY_BUTTON_CLASS,
  SETTINGS_SECONDARY_BUTTON_CLASS,
  SETTINGS_SURFACE_CLASS,
  SETTINGS_CARD_CLASS,
  SETTINGS_LIST_CLASS,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsInput,
  SettingsFormActions,
  SettingsNotice,
} from '../../components/SettingsSubsection';
import type {
  WorkspaceSyncOrgAuditEventView,
  WorkspaceSyncOrgInviteView,
  WorkspaceSyncOrgRole,
} from '../../shared/workspace-sync-ipc';
import {
  MANUALLY_ASSIGNABLE_ROLES,
  expiresLabel,
  orgRoleLabel,
  ROLE_LABEL,
  ROLE_RANK,
  type OrganizationSettingsModel,
  type OrganizationSettingsSection,
} from './useOrganizationSettings';

export function auditEventsToCsv(events: WorkspaceSyncOrgAuditEventView[]): string {
  const cell = (value: string) =>
    /[",\n]/.test(value) ? `"${value.split('"').join('""')}"` : value;
  const header = ['created_at', 'actor', 'event_type', 'summary'];
  const rows = events.map((event) =>
    [event.createdAt, event.actorName, event.eventType, event.summary].map(cell).join(',')
  );
  return [header.join(','), ...rows].join('\n');
}

function downloadTextFile(filename: string, contents: string): void {
  const blob = new Blob([contents], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function OrganizationSettingsContent({
  model,
  section,
}: {
  model: OrganizationSettingsModel;
  section: OrganizationSettingsSection;
}) {
  const {
    selected,
    directory,
    loading,
    busy,
    error,
    name,
    setName,
    createSlug = '',
    setCreateSlug = (_value: string) => {},
    createSuggestions = [],
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
    viewer,
    handleCreate,
    handleSaveGeneral,
    handleCancelGeneral,
    handleDelete,
    handleInvite,
    handleRoleChange,
    handleRemove,
    handleResend,
    handleCopyAcceptUrl,
    handleRevoke,
    auditEvents,
    auditTypes,
    auditFilter,
    setAuditFilter,
    registryHealth,
    deletionImpact,
    provisioningStatus,
    provisioningLoading,
    handleOpenProvisioningPortal,
    handleProvisioningGroupRole,
  } = model;

  if (loading) return <p className="text-sm text-fg-muted">Loading…</p>;
  const errorBanner = error ? (
    <SettingsNotice testId="organization-admin-error" tone="error">
      {toUserMessage(error, 'account.failed')}
    </SettingsNotice>
  ) : null;

  if (section === 'create' || (!selected && !directory) || creating) {
    return (
      <SettingsSection title="Create organization" testId="organization-settings-general" flushTop>
        {errorBanner}
        <form className="space-y-4" onSubmit={(event) => void handleCreate(event)}>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-fg">Name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Organization name"
              aria-label="Organization name"
              data-testid="organization-admin-name"
              disabled={busy}
              className={SETTINGS_FIELD_CLASS}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-fg">URL</span>
            <input
              value={createSlug}
              onChange={(event) => setCreateSlug(event.target.value)}
              placeholder="acme"
              aria-label="Organization URL"
              data-testid="organization-admin-slug"
              disabled={busy}
              className={`${SETTINGS_FIELD_CLASS} font-mono`}
            />
          </label>
          {createSuggestions.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
              <span>Try:</span>
              {createSuggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => setCreateSlug(suggestion)}
                  className={`${SETTINGS_SECONDARY_BUTTON_CLASS} font-mono`}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          ) : null}
          <button
            type="submit"
            disabled={busy || !name.trim()}
            data-testid="organization-admin-create"
            className={SETTINGS_PRIMARY_BUTTON_CLASS}
          >
            {busy ? 'Creating…' : 'Create'}
          </button>
        </form>
      </SettingsSection>
    );
  }

  if (!directory || !selected) {
    return <p className="text-sm text-fg-muted">Loading…</p>;
  }

  if (section === 'registry') {
    return <OrganizationRegistrationSettings model={model} />;
  }

  if (section === 'sync-health') {
    return (
      <SettingsSection
        title="Registry sync health"
        description="Desktop replicas, event lag, queued changes, and unresolved conflicts."
        testId="organization-registry-sync-health"
      >
        {errorBanner}
        {!selected.isAdministrator ? (
          <p className="text-sm text-fg-muted">
            Only organization administrators can view replica health.
          </p>
        ) : !registryHealth ? (
          <p className="text-sm text-fg-muted">Sync health is unavailable.</p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className={SETTINGS_CARD_CLASS}>
                <p className="text-xs text-fg-muted">Server cursor</p>
                <p className="mt-1 text-lg font-semibold text-fg">{registryHealth.cursor}</p>
              </div>
              <div className={SETTINGS_CARD_CLASS}>
                <p className="text-xs text-fg-muted">Records</p>
                <p className="mt-1 text-lg font-semibold text-fg">{registryHealth.entityCount}</p>
              </div>
              <div className={SETTINGS_CARD_CLASS}>
                <p className="text-xs text-fg-muted">Conflicts</p>
                <p className="mt-1 text-lg font-semibold text-fg">{registryHealth.conflictCount}</p>
              </div>
            </div>
            <ul className={SETTINGS_LIST_CLASS}>
              {registryHealth.replicas.length === 0 ? (
                <li className="p-4 text-sm text-fg-muted">
                  No desktop replica has synchronized yet.
                </li>
              ) : (
                registryHealth.replicas.map((replica) => (
                  <li
                    key={replica.clientId}
                    className="flex flex-wrap items-start justify-between gap-3 p-4"
                  >
                    <div>
                      <p className="text-sm font-medium text-fg">{replica.accountName}</p>
                      <p className="mt-0.5 font-mono text-xs text-fg-muted">{replica.clientId}</p>
                    </div>
                    <div className="text-right text-xs text-fg-muted">
                      <p className={replica.lagEvents === 0 ? 'text-success' : 'text-warning'}>
                        {replica.lagEvents === 0
                          ? 'Up to date'
                          : `${replica.lagEvents} events behind`}
                      </p>
                      <p className="mt-1">
                        {replica.lastPullAt
                          ? `Last pull ${new Date(replica.lastPullAt).toLocaleString()}`
                          : 'Never pulled'}
                      </p>
                    </div>
                  </li>
                ))
              )}
            </ul>
          </>
        )}
      </SettingsSection>
    );
  }

  if (section === 'provisioning') {
    const stateLabel = !provisioningStatus
      ? 'Unavailable'
      : !provisioningStatus.configured
        ? 'Not connected'
        : provisioningStatus.status === 'active'
          ? 'Active'
          : provisioningStatus.status === 'pending'
            ? 'Setup pending'
            : provisioningStatus.status === 'deleted'
              ? 'Disconnected'
              : 'Disabled';
    const actionLabel =
      provisioningStatus?.configured && provisioningStatus.status === 'active'
        ? 'Manage login directory'
        : provisioningStatus?.configured && provisioningStatus.status === 'pending'
          ? 'Continue setup'
          : 'Connect login directory';
    return (
      <SettingsSection
        title="Company login directory"
        description="Optional. Connect a university or company login system. People invited by email stay under your control."
        testId="organization-settings-provisioning"
      >
        {errorBanner}
        {!viewer?.canConfigureProvisioning ? (
          <p className="text-sm text-fg-muted">
            You do not have permission to connect a login directory.
          </p>
        ) : provisioningLoading ? (
          <p className="text-sm text-fg-muted">Checking directory status…</p>
        ) : (
          <>
            <div
              className={`flex flex-wrap items-center justify-between gap-3 ${SETTINGS_CARD_CLASS}`}
            >
              <div>
                <p className="text-sm font-medium text-fg">Login directory</p>
                <p className="mt-1 text-xs text-fg-muted">
                  {!provisioningStatus
                    ? 'Login directory status could not be verified.'
                    : !provisioningStatus.configured
                      ? 'No login directory is connected.'
                      : provisioningStatus.status === 'pending'
                        ? 'Setup has started. Finish it to choose the login system your organization already uses.'
                        : provisioningStatus.status === 'deleted'
                          ? 'The previous login directory was disconnected. People invited by email were kept.'
                          : 'People from the login directory are added and removed automatically.'}
                </p>
              </div>
              <span className="rounded-full bg-bg-muted px-2.5 py-1 text-xs font-medium text-fg">
                {stateLabel}
              </span>
            </div>

            {provisioningStatus ? (
              provisioningStatus.configured && provisioningStatus.status !== 'pending' ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <ProvisioningMetric
                    label="Membership"
                    value={`${provisioningStatus.provisionedMemberCount} provisioned`}
                  />
                  <ProvisioningMetric
                    label="Seats"
                    value={formatProvisioningSeats(
                      provisioningStatus.seatCount,
                      provisioningStatus.seatLimit
                    )}
                  />
                  <ProvisioningMetric
                    label="Directory users"
                    value={`${provisioningStatus.activeUserCount} active of ${provisioningStatus.userCount}`}
                  />
                  <ProvisioningMetric
                    label="Groups"
                    value={String(provisioningStatus.groupCount)}
                  />
                  <ProvisioningMetric
                    label="Applied events"
                    value={String(provisioningStatus.eventReceiptCount)}
                  />
                  <ProvisioningMetric label="Default role" value={provisioningStatus.defaultRole} />
                </div>
              ) : (
                <p className="text-xs text-fg-muted">
                  {formatProvisioningSeats(
                    provisioningStatus.seatCount,
                    provisioningStatus.seatLimit
                  )}
                </p>
              )
            ) : null}

            {provisioningStatus?.configured &&
            provisioningStatus.status === 'active' &&
            provisioningStatus.groups.length > 0 ? (
              <div data-testid="organization-provisioning-groups">
                <p className="text-sm font-medium text-fg">Group role mappings</p>
                <p className="mt-1 text-xs text-fg-muted">
                  A mapped group overrides the default member role. Directories can never grant
                  owner access.
                </p>
                <div className={`mt-2 ${SETTINGS_LIST_CLASS}`}>
                  {provisioningStatus.groups.map((group) => (
                    <label
                      key={group.externalId}
                      className="flex flex-wrap items-center justify-between gap-3 p-3"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm text-fg">{group.displayName}</span>
                        <span className="block truncate font-mono text-xs text-fg-muted">
                          {group.externalId}
                        </span>
                      </span>
                      <SettingsSelect
                        ariaLabel={`Role for ${group.displayName}`}
                        testId={`organization-provisioning-group-${group.externalId}`}
                        containerClassName="w-36"
                        value={group.roleId ?? 'member'}
                        disabled={busy}
                        onValueChange={(value) =>
                          void handleProvisioningGroupRole(
                            group.externalId,
                            value as 'admin' | 'member'
                          )
                        }
                        options={[
                          { value: 'member', label: 'Member' },
                          { value: 'admin', label: 'Admin' },
                        ]}
                      />
                    </label>
                  ))}
                </div>
              </div>
            ) : null}

            {provisioningStatus?.configured && provisioningStatus.pendingAccountCount > 0 ? (
              <SettingsNotice tone="warning">
                {provisioningStatus.pendingAccountCount} directory users are waiting for matching
                verified DNAForge accounts.
              </SettingsNotice>
            ) : null}
            {provisioningStatus?.configured && provisioningStatus.lastError ? (
              <SettingsNotice tone="error">
                Last provisioning error: {provisioningStatus.lastError}
              </SettingsNotice>
            ) : null}
            <button
              type="button"
              disabled={busy || !provisioningStatus}
              onClick={() => void handleOpenProvisioningPortal()}
              data-testid="organization-provisioning-connect"
              className={SETTINGS_PRIMARY_BUTTON_CLASS}
            >
              {busy ? 'Opening secure setup…' : actionLabel}
            </button>
          </>
        )}
      </SettingsSection>
    );
  }

  if (section === 'general') {
    const canEdit = Boolean(viewer?.canEditSettings);
    return (
      <SettingsSection
        title="General"
        description="Name and URL."
        testId="organization-settings-general"
      >
        {errorBanner}
        {canEdit ? (
          <form className="space-y-5" onSubmit={(event) => void handleSaveGeneral(event)}>
            <SettingsRow
              {...settingsRowProps('organization-name')}
              htmlFor="organization-settings-name"
            >
              <SettingsInput
                id="organization-settings-name"
                value={editName}
                onChange={(event) => setEditName(event.target.value)}
                aria-label="Organization name"
                data-testid="organization-admin-title"
                disabled={busy}
              />
            </SettingsRow>
            <SettingsRow
              {...settingsRowProps('organization-url')}
              htmlFor="organization-settings-url"
              description="Changing this keeps old links working (they redirect for 90 days)."
            >
              <SettingsInput
                id="organization-settings-url"
                monospace
                value={editSlug}
                onChange={(event) => setEditSlug(event.target.value.toLowerCase())}
                aria-label="Organization URL"
                data-testid="organization-settings-slug"
                disabled={busy}
              />
            </SettingsRow>
            <SettingsFormActions
              dirty={editName !== directory.displayName || editSlug !== directory.slug}
              busy={busy}
              valid={Boolean(editName.trim() && editSlug.trim())}
              onCancel={handleCancelGeneral}
              saveTestId="organization-settings-save"
            />
          </form>
        ) : (
          <>
            <SettingsRow {...settingsRowProps('organization-name')}>
              <p data-testid="organization-admin-title" className="text-sm text-fg">
                {directory.displayName}
              </p>
            </SettingsRow>
            <SettingsRow {...settingsRowProps('organization-url')}>
              <p className="font-mono text-sm text-fg" data-testid="organization-settings-slug">
                {directory.slug}
              </p>
            </SettingsRow>
          </>
        )}
        <SettingsRow label="Your role">
          <p className="text-sm text-fg" data-testid="organization-settings-role">
            {orgRoleLabel(directory.viewer.role)}
          </p>
        </SettingsRow>
        {viewer?.canDelete ? (
          <div className="rounded-md bg-error/5 p-4" data-testid="organization-settings-delete">
            <p className="text-sm font-medium text-error">Delete organization</p>
            <p className="mt-1 text-xs leading-5 text-fg-muted">
              Deletion is allowed only after organization-owned projects and Registry records are
              transferred or archived. Type {directory.displayName} to confirm.
            </p>
            <p
              className="mt-2 rounded-md bg-bg-muted px-3 py-2 text-xs text-fg-muted"
              data-testid="organization-settings-delete-impact"
            >
              {!deletionImpact
                ? 'Checking projects and Registry records…'
                : `${deletionImpact.projectCount} ${deletionImpact.projectCount === 1 ? 'project' : 'projects'} active · ${deletionImpact.registryEntityCount} Registry ${deletionImpact.registryEntityCount === 1 ? 'record' : 'records'} active · ${deletionImpact.syncStorageObjectCount} live storage ${deletionImpact.syncStorageObjectCount === 1 ? 'object' : 'objects'} · ${deletionImpact.syncStorageReservationCount} live upload ${deletionImpact.syncStorageReservationCount === 1 ? 'reservation' : 'reservations'} · ${deletionImpact.archivedProjectCount} archived ${deletionImpact.archivedProjectCount === 1 ? 'project' : 'projects'} · ${deletionImpact.archivedRegistryEntityCount} archived Registry ${deletionImpact.archivedRegistryEntityCount === 1 ? 'record' : 'records'} · ${deletionImpact.registrySchemaCount} ${deletionImpact.registrySchemaCount === 1 ? 'schema' : 'schemas'}${deletionImpact.canDelete ? ' · Ready to delete' : ' · Resolve active items and storage cleanup before deletion'}`}
            </p>
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <input
                value={deleteConfirm}
                onChange={(event) => setDeleteConfirm(event.target.value)}
                aria-label="Confirm organization name"
                data-testid="organization-settings-delete-confirm"
                disabled={busy}
                className={`${SETTINGS_FIELD_CLASS} min-w-0 flex-1`}
              />
              <button
                type="button"
                disabled={
                  busy ||
                  deleteConfirm !== directory.displayName ||
                  deletionImpact?.canDelete !== true
                }
                onClick={() => void handleDelete()}
                data-testid="organization-settings-delete-submit"
                className={SETTINGS_DANGER_BUTTON_CLASS}
              >
                {busy ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        ) : null}
      </SettingsSection>
    );
  }

  const viewerRank = ROLE_RANK[directory.viewer.role] ?? ROLE_RANK.member;
  const manuallyAssignableRoles = MANUALLY_ASSIGNABLE_ROLES.filter(
    (role) => ROLE_RANK[role] >= viewerRank
  );
  const ownerCount = directory.members.filter((member) => member.role === 'owner').length;

  if (section === 'audit') {
    return (
      <SettingsSection title="Audit log" testId="organization-settings-audit" flushTop>
        {errorBanner}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <label className="block max-w-xs">
            <span className="mb-1 block text-sm font-medium text-fg">Filter by event</span>
            <SettingsSelect
              value={auditFilter}
              onValueChange={setAuditFilter}
              testId="organization-settings-audit-filter"
              ariaLabel="Filter by event"
              options={[
                { value: '', label: 'All events' },
                ...auditTypes.map((value) => ({ value, label: value })),
              ]}
            />
          </label>
          <button
            type="button"
            data-testid="organization-settings-audit-export"
            disabled={auditEvents.length === 0}
            className={SETTINGS_SECONDARY_BUTTON_CLASS}
            onClick={() =>
              downloadTextFile(
                `${selected?.slug ?? 'organization'}-audit.csv`,
                auditEventsToCsv(auditEvents)
              )
            }
          >
            Download CSV
          </button>
        </div>
        <table className="w-full text-left text-sm" data-testid="organization-settings-audit-table">
          <thead className="text-xs uppercase tracking-wide text-fg-muted">
            <tr className="bg-black/[0.025] dark:bg-white/[0.035]">
              <th className="py-2 pr-3 font-medium">When</th>
              <th className="py-2 pr-3 font-medium">Actor</th>
              <th className="py-2 font-medium">Event</th>
            </tr>
          </thead>
          <tbody>
            {auditEvents.length === 0 ? (
              <tr>
                <td colSpan={3} className="py-8 text-center text-fg-muted">
                  No events{auditFilter ? ' for this filter' : ''} yet.
                </td>
              </tr>
            ) : (
              auditEvents.map((event) => (
                <tr key={event.id} data-testid="organization-settings-audit-row">
                  <td className="py-2 pr-3 font-mono text-xs text-fg-muted">
                    {new Date(event.createdAt).toLocaleString()}
                  </td>
                  <td className="py-2 pr-3 text-fg">{event.actorName}</td>
                  <td className="py-2 text-fg">{event.summary}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        {auditEvents.length >= 100 ? (
          <p className="text-xs text-fg-muted">Showing the latest 100 events.</p>
        ) : null}
      </SettingsSection>
    );
  }

  function renderInviteForm() {
    if (!viewer?.canInvite) return null;
    return (
      <>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => void handleInvite(event)}
        >
          <label className="min-w-0 flex-1">
            <span className="mb-1 block text-sm font-medium text-fg">Email</span>
            <input
              type="email"
              value={inviteEmail}
              onChange={(event) => setInviteEmail(event.target.value)}
              placeholder="name@example.com"
              aria-label="Invite by email"
              data-testid="organization-admin-invite-email"
              disabled={busy}
              className={SETTINGS_FIELD_CLASS}
            />
          </label>
          <label>
            <span className="mb-1 block text-sm font-medium text-fg">Role</span>
            <SettingsSelect
              value={inviteRole}
              onValueChange={(next) => {
                if (next !== 'owner' && next !== 'admin' && next !== 'member') return;
                setInviteRole(next);
              }}
              ariaLabel="Invite role"
              testId="organization-admin-invite-role"
              disabled={busy}
              options={manuallyAssignableRoles.map((value) => ({
                value,
                label: ROLE_LABEL[value],
              }))}
            />
          </label>
          <button
            type="submit"
            disabled={busy || !inviteEmail.trim()}
            data-testid="organization-admin-invite-submit"
            className={SETTINGS_PRIMARY_BUTTON_CLASS}
          >
            {busy ? 'Sending…' : 'Send invite'}
          </button>
        </form>
        {inviteNotice ? (
          <p data-testid="organization-admin-invite-notice" className="text-sm text-fg">
            {inviteNotice}
          </p>
        ) : null}
        {lastAcceptUrl ? (
          <button
            type="button"
            onClick={() => void handleCopyAcceptUrl()}
            data-testid="organization-admin-invite-copy"
            className="text-sm text-accent hover:underline"
          >
            Copy invite link
          </button>
        ) : null}
      </>
    );
  }

  function renderPendingInvite(invite: WorkspaceSyncOrgInviteView, options: { resend: boolean }) {
    return (
      <li
        key={invite.id}
        data-testid="invite-row"
        className={`flex items-center justify-between gap-3 rounded-md px-3 py-3 text-sm ${SETTINGS_SURFACE_CLASS}`}
      >
        <span className="min-w-0">
          <span className="block truncate text-fg">{invite.email}</span>
          <span className="block text-xs text-fg-muted">
            {ROLE_LABEL[invite.role]} · {expiresLabel(invite.expiresAt)}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {options.resend ? (
            <button
              type="button"
              disabled={busy}
              data-testid="invite-resend"
              onClick={() => void handleResend(invite)}
              className={`${SETTINGS_SECONDARY_BUTTON_CLASS} px-2 py-1`}
            >
              Resend
            </button>
          ) : null}
          <button
            type="button"
            disabled={busy}
            data-testid="invite-revoke"
            onClick={() => void handleRevoke(invite.id)}
            className={`${SETTINGS_DANGER_BUTTON_CLASS} px-2 py-1`}
          >
            Revoke
          </button>
        </span>
      </li>
    );
  }

  if (section === 'members') {
    return (
      <SettingsSection
        title="People"
        description="Invite someone by email."
        testId="organization-settings-members"
      >
        {errorBanner}
        {renderInviteForm()}
        <ul className="space-y-2" data-testid="organization-admin-members">
          {directory.members.map((member) => {
            const isSelf = member.accountId === viewer?.accountId;
            const showRoleEditor =
              Boolean(viewer?.canChangeRole) && !isSelf && ROLE_RANK[member.role] > viewerRank;
            const showRemove =
              Boolean(viewer?.canRemove) && !isSelf && ROLE_RANK[member.role] > viewerRank;
            const showLeave = isSelf && (member.role !== 'owner' || ownerCount > 1);
            return (
              <li
                key={member.accountId}
                data-testid="member-row"
                data-account-id={member.accountId}
                className={`flex items-center justify-between gap-3 rounded-md px-3 py-3 text-sm ${SETTINGS_SURFACE_CLASS}`}
              >
                <span className="min-w-0">
                  <span className="block truncate text-fg" title={member.email}>
                    {member.displayName}
                    {isSelf ? <span className="ml-2 text-xs text-fg-muted">(you)</span> : null}
                  </span>
                  {member.email && member.email !== member.displayName ? (
                    <span className="block truncate text-xs text-fg-muted">{member.email}</span>
                  ) : null}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {showRoleEditor ? (
                    <SettingsSelect
                      ariaLabel={`Role for ${member.email || member.displayName}`}
                      value={member.role}
                      disabled={busy}
                      testId="member-role-select"
                      onValueChange={(next) => {
                        if (next !== 'owner' && next !== 'admin' && next !== 'member') return;
                        void handleRoleChange(member.accountId, next);
                      }}
                      options={manuallyAssignableRoles.map((value) => ({
                        value,
                        label: ROLE_LABEL[value],
                      }))}
                    />
                  ) : (
                    <span className="shrink-0 text-fg-muted">
                      {ROLE_LABEL[member.role as WorkspaceSyncOrgRole] ?? member.role}
                    </span>
                  )}
                  {showRemove ? (
                    <button
                      type="button"
                      disabled={busy}
                      data-testid="member-remove"
                      onClick={() => {
                        if (window.confirm(`Remove ${member.displayName} from the organization?`)) {
                          void handleRemove(member.accountId);
                        }
                      }}
                      className={`${SETTINGS_DANGER_BUTTON_CLASS} px-2 py-1`}
                    >
                      Remove
                    </button>
                  ) : null}
                  {showLeave ? (
                    <button
                      type="button"
                      disabled={busy}
                      data-testid="member-leave"
                      onClick={() => {
                        if (window.confirm('Leave this organization?')) {
                          void handleRemove(member.accountId);
                        }
                      }}
                      className={`${SETTINGS_DANGER_BUTTON_CLASS} px-2 py-1`}
                    >
                      Leave
                    </button>
                  ) : null}
                </span>
              </li>
            );
          })}
          {viewer?.canInvite
            ? directory.invites.map((invite) => renderPendingInvite(invite, { resend: true }))
            : null}
        </ul>
        {viewer?.isOwner && ownerCount === 1 ? (
          <p className="text-xs text-fg-muted">Add another owner before leaving.</p>
        ) : null}
        {viewer?.canConfigureProvisioning ? (
          <div
            className="mt-8 border-t border-border pt-6"
            data-testid="organization-people-directory"
          >
            <p className="text-sm font-medium text-fg">Company login directory</p>
            <p className="mt-1 text-sm text-fg-muted">
              Optional. If your university or company already keeps a staff list in its login
              system, connect it here.
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleOpenProvisioningPortal()}
              data-testid="organization-people-directory-connect"
              className={`mt-3 ${SETTINGS_SECONDARY_BUTTON_CLASS}`}
            >
              {provisioningStatus?.configured && provisioningStatus.status === 'active'
                ? 'Manage login directory'
                : provisioningStatus?.configured && provisioningStatus.status === 'pending'
                  ? 'Continue setup'
                  : 'Connect login directory'}
            </button>
          </div>
        ) : null}
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title="Invites" testId="organization-settings-invitations" flushTop>
      {errorBanner}
      {viewer?.canInvite ? (
        <>
          {renderInviteForm()}
          {directory.invites.length > 0 ? (
            <ul data-testid="organization-admin-invites" className="space-y-2">
              {directory.invites.map((invite) => renderPendingInvite(invite, { resend: true }))}
            </ul>
          ) : (
            <p className="text-sm text-fg-muted">No pending invitations.</p>
          )}
        </>
      ) : (
        <p className="text-sm text-fg-muted">You cannot invite people in this organization.</p>
      )}
    </SettingsSection>
  );
}

function ProvisioningMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className={SETTINGS_CARD_CLASS}>
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd className="mt-1 text-sm font-medium text-fg">{value}</dd>
    </div>
  );
}

function formatProvisioningSeats(count: number, limit: number | null): string {
  return limit === null ? `${count} seats in use` : `${count} of ${limit} seats in use`;
}

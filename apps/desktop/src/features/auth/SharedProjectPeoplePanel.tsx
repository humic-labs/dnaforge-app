import { toUserMessage } from '@waypoint/user-messages';
import { useState } from 'react';
import { Button, TextField } from '../../components/ui';
import { openOrganizationsSettings } from './cloud-surface-store';
import type {
  WorkspaceSyncAccessListing,
  WorkspaceSyncAccessRole,
  WorkspaceSyncGrantRole,
} from '../../shared/workspace-sync-ipc';

export const GRANT_ROLE_LABEL: Record<WorkspaceSyncGrantRole, string> = {
  viewer: 'Viewer',
  editor: 'Editor',
  manager: 'Manager',
};

export const ACCESS_ROLE_LABEL: Record<WorkspaceSyncAccessRole, string> = {
  viewer: 'Viewer',
  editor: 'Editor',
  manager: 'Manager',
  owner: 'Owner',
};

export function describeAccessSource(listing: WorkspaceSyncAccessListing): string {
  const role = ACCESS_ROLE_LABEL[listing.viewer.role];
  const source = listing.viewer.sources[0];
  if (!source) return role;
  switch (source.kind) {
    case 'owner':
      return 'Owner';
    case 'org_admin':
      return `${role} · organization administrator`;
    case 'org_audience':
      return `${role} · via ${listing.owner.kind === 'org' ? listing.owner.displayName : 'organization'}`;
    default:
      return `${role} · shared with you`;
  }
}

export interface SharedProjectPeoplePanelProps {
  listing: WorkspaceSyncAccessListing | null;
  loading: boolean;
  error: string | null;
  commandInFlight: boolean;
  onInvite: (email: string, role: WorkspaceSyncGrantRole) => void;
  onChangeRole: (accountId: string, role: WorkspaceSyncGrantRole) => void;
  onRemove: (accountId: string) => void;
  onSetOrgAudience: (orgId: string, role: WorkspaceSyncGrantRole | null) => void;
  onRevokeInvite: (inviteId: string) => void;
  onResendInvite: (inviteId: string) => void;
  onRefresh: () => void;
}

export function SharedProjectPeoplePanel({
  listing,
  loading,
  error,
  commandInFlight,
  onInvite,
  onChangeRole,
  onRemove,
  onSetOrgAudience,
  onRevokeInvite,
  onResendInvite,
  onRefresh,
}: SharedProjectPeoplePanelProps) {
  const [email, setEmail] = useState('');

  const audienceGrant = listing?.grants.find((grant) => grant.subjectKind === 'org') ?? null;
  const audienceOrg =
    listing?.owner.kind === 'org'
      ? { orgId: listing.owner.orgId, name: listing.owner.displayName }
      : audienceGrant
        ? { orgId: audienceGrant.orgId ?? '', name: audienceGrant.orgName ?? 'organization' }
        : null;

  return (
    <div data-testid="shared-project-people" className="flex flex-col gap-3">
      <div className="flex items-center justify-end gap-2">
        {listing ? (
          <span
            data-testid="shared-project-your-access"
            className="mr-auto truncate text-sm text-fg-muted"
            title={describeAccessSource(listing)}
          >
            {describeAccessSource(listing)}
          </span>
        ) : null}
        <button
          type="button"
          data-testid="shared-project-manage-orgs"
          className="shrink-0 text-sm text-fg-muted hover:text-fg"
          onClick={() => openOrganizationsSettings()}
        >
          Organization
        </button>
      </div>

      {loading && !listing ? (
        <p className="mt-1 text-[11px] text-fg-muted">Loading people…</p>
      ) : null}
      {error ? (
        <p data-testid="shared-project-people-error" className="mt-1 text-[11px] text-error">
          {toUserMessage(error, 'account.failed')}{' '}
          <button type="button" className="underline" onClick={onRefresh}>
            Retry
          </button>
        </p>
      ) : null}

      {listing ? (
        <>
          <ul className="divide-y divide-border" data-testid="shared-project-people-list">
            <li className="flex items-center justify-between gap-3 py-2 text-sm">
              <span className="min-w-0 truncate text-fg">
                {listing.owner.kind === 'org'
                  ? listing.owner.displayName
                  : (listing.owner.displayName ?? listing.owner.email)}
              </span>
              <span className="shrink-0 text-fg-muted">
                {listing.owner.kind === 'org' ? 'Managing organization' : 'Owner'}
              </span>
            </li>
            {listing.admins.map((admin) => (
              <li
                key={`admin:${admin.accountId}`}
                className="flex items-center justify-between gap-3 py-2 text-sm"
              >
                <span className="min-w-0 truncate text-fg">{admin.displayName ?? admin.email}</span>
                <span className="shrink-0 text-fg-muted">Administrator</span>
              </li>
            ))}
            {listing.grants
              .filter((grant) => grant.subjectKind === 'account')
              .map((grant) => (
                <li
                  key={grant.id}
                  data-testid="shared-project-person"
                  className="flex items-center justify-between gap-3 py-2 text-sm"
                >
                  <span className="min-w-0 truncate text-fg" title={grant.email ?? ''}>
                    {grant.displayName ?? grant.email ?? grant.accountId}
                  </span>
                  {listing.canManage && grant.accountId ? (
                    <span className="flex shrink-0 items-center gap-1">
                      <select
                        aria-label={`Access for ${grant.email ?? grant.accountId}`}
                        value={grant.role}
                        disabled={commandInFlight}
                        onChange={(event) =>
                          onChangeRole(
                            grant.accountId ?? '',
                            event.target.value as WorkspaceSyncGrantRole
                          )
                        }
                        className="rounded-md border border-border bg-bg px-1.5 py-1 text-sm text-fg"
                      >
                        {(Object.keys(GRANT_ROLE_LABEL) as WorkspaceSyncGrantRole[]).map(
                          (option) => (
                            <option key={option} value={option}>
                              {GRANT_ROLE_LABEL[option]}
                            </option>
                          )
                        )}
                      </select>
                      <button
                        type="button"
                        disabled={commandInFlight}
                        onClick={() => onRemove(grant.accountId ?? '')}
                        title="Remove access"
                        aria-label={`Remove ${grant.email ?? grant.accountId}`}
                        className="text-sm text-fg-muted hover:text-fg disabled:opacity-50"
                      >
                        Remove
                      </button>
                    </span>
                  ) : (
                    <span className="shrink-0 text-fg-muted">{GRANT_ROLE_LABEL[grant.role]}</span>
                  )}
                </li>
              ))}
          </ul>

          {audienceOrg ? (
            <div
              data-testid="shared-project-audience"
              className="flex items-center justify-between gap-3 py-2 text-sm"
            >
              <span className="min-w-0 truncate text-fg-muted">Everyone in {audienceOrg.name}</span>
              {listing.canManage ? (
                <select
                  aria-label={`Access for everyone in ${audienceOrg.name}`}
                  value={audienceGrant?.role ?? 'none'}
                  disabled={commandInFlight}
                  onChange={(event) =>
                    onSetOrgAudience(
                      audienceOrg.orgId,
                      event.target.value === 'none'
                        ? null
                        : (event.target.value as WorkspaceSyncGrantRole)
                    )
                  }
                  className="rounded-md border border-border bg-bg px-1.5 py-1 text-sm text-fg"
                >
                  <option value="none">No access</option>
                  <option value="viewer">Viewer</option>
                  <option value="editor">Editor</option>
                </select>
              ) : (
                <span className="shrink-0 text-fg-muted">
                  {audienceGrant ? GRANT_ROLE_LABEL[audienceGrant.role] : 'No access'}
                </span>
              )}
            </div>
          ) : null}

          {listing.canManage && listing.invites.length > 0 ? (
            <ul className="divide-y divide-border" data-testid="shared-project-invites">
              {listing.invites.map((invite) => (
                <li
                  key={invite.id}
                  className="flex items-center justify-between gap-3 py-2 text-sm"
                >
                  <span className="min-w-0 truncate text-fg" title={invite.email}>
                    {invite.email}
                    <span className="text-fg-muted">
                      {' '}
                      · invited
                      {invite.expired ? ' · expired' : ''}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      disabled={commandInFlight}
                      data-testid="shared-project-invite-resend"
                      onClick={() => onResendInvite(invite.id)}
                      className="text-sm text-fg-muted hover:text-fg disabled:opacity-50"
                    >
                      Resend
                    </button>
                    <button
                      type="button"
                      disabled={commandInFlight}
                      onClick={() => onRevokeInvite(invite.id)}
                      className="text-sm text-fg-muted hover:text-fg disabled:opacity-50"
                    >
                      Revoke
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          {listing.canManage ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const trimmed = email.trim();
                if (!trimmed) return;
                onInvite(trimmed, 'editor');
                setEmail('');
              }}
            >
              <div className="min-w-0 flex-1">
                <TextField
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="Email"
                  aria-label="Invite by email"
                  data-testid="shared-project-invite-email"
                  disabled={commandInFlight}
                />
              </div>
              <Button
                variant="primary"
                type="submit"
                disabled={commandInFlight || !email.trim()}
                data-testid="shared-project-invite-submit"
              >
                Invite
              </Button>
            </form>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

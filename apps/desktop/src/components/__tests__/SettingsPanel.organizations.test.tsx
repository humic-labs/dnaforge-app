import { SettingsPanel } from '../SettingsPanel';
import { subscribeRegistryOpen } from '../../shared/registry-events';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { useState } from 'react';

const ORG_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1';
const ORG_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1';

const h = vi.hoisted(() => ({
  signedIn: true,
  cloudSync: {
    listOrganizations: vi.fn(),
    createOrganization: vi.fn(),
    updateOrganization: vi.fn(),
    deleteOrganization: vi.fn(),
    listOrganizationDirectory: vi.fn(),
    inviteOrganizationMember: vi.fn(),
    revokeOrganizationInvite: vi.fn(),
    changeOrganizationMemberRole: vi.fn(),
    removeOrganizationMember: vi.fn(),
    transferOrganizationOwnership: vi.fn(),
    listOrganizationAudit: vi.fn().mockResolvedValue({ ok: true, events: [], eventTypes: [] }),
    getOrganizationProvisioningStatus: vi.fn(),
    setOrganizationProvisioningGroupRole: vi.fn(),
    openOrganizationProvisioningPortal: vi.fn(),
    getOrganizationRegistry: vi.fn(),
    syncOrganizationRegistry: vi.fn(),
    mutateOrganizationRegistry: vi.fn(),
    configureOrganizationRegistry: vi.fn(),
    getOrganizationRegistrySyncHealth: vi.fn(),
    getOrganizationDeletionImpact: vi.fn(),
    resolveOrganizationRegistryConflict: vi.fn(),
  },
}));

vi.mock('../../db', () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  setSetting: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../lib/analytics', () => ({
  setAnalyticsConsent: vi.fn().mockResolvedValue(true),
  subscribeAnalyticsCaptureReady: vi.fn(() => () => undefined),
  trackRendererEvent: vi.fn(),
}));
vi.mock('../HostedContributionSettings', () => ({
  HostedContributionSettings: () => <div data-testid="hosted-contribution-settings" />,
}));
vi.mock('../../lib/workflow-telemetry', () => ({
  explicitlyBindHistoricalMeaningfulActivity: vi.fn().mockResolvedValue(0),
}));
vi.mock('../../features/ai/settings', () => ({
  useAISettingsStore: vi.fn(() => ({
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    providerStatuses: {},
    providerModels: {},
    providerCredentialNames: {},
    keyringError: null,
    setProvider: vi.fn(),
    setModel: vi.fn(),
    setApiKey: vi.fn(),
    deleteApiKey: vi.fn(),
    retryFetchModels: vi.fn(),
    refreshProviderStatuses: vi.fn(),
  })),
}));
vi.mock('../../features/ai/providers', () => ({
  PROVIDERS: [],
  getAllProviderMetas: () => [],
}));
vi.mock('../../features/agent-integrations', () => ({
  ExternalMcpRegistrationIssues: () => null,
  AgentExtensionsPanel: () => <div>extensions</div>,
  AssistantHostSettingsContent: () => <div>hosts</div>,
  ToolAccessSettingsContent: () => <div>tools</div>,
}));
vi.mock('../../shared/context/DarkModeContext', () => ({
  useDarkMode: vi.fn(() => ({
    themeMode: 'system',
    setThemeMode: vi.fn(),
    persistence: { revision: 0, phase: 'saved' },
    retryPersistence: vi.fn(),
  })),
}));
vi.mock('../../stores/workspaceStore', () => ({
  useWorkspaceStore: vi.fn(() => ({ folders: [] })),
}));
vi.mock('../../platform', () => ({
  platform: () => ({
    lims: { listSchemas: vi.fn().mockResolvedValue([]) },
    window: {
      setZoomLevel: vi.fn(async (factor: number) => ({ status: 'applied' as const, factor })),
    },
    cloudSync: h.cloudSync,
  }),
}));
vi.mock('../../utils/environment', () => ({
  isHostedBrowserRuntime: vi.fn(() => false),
  isBrowserOnly: vi.fn(() => true),
  isDesktopRuntime: vi.fn(() => false),
}));
vi.mock('../../stores/auth-store', () => ({
  useAuthStore: (
    selector: (s: {
      state:
        | { status: 'signed-out' }
        | {
            status: 'signed-in';
            session: {
              accountId: string;
              desktopSessionId: string;
              email: string;
              displayName: string;
              channel: string;
              accessTokenExpiresAt: string;
            };
          };
      updateProfile: () => void;
      signOut: () => void;
    }) => unknown
  ) =>
    selector({
      state: h.signedIn
        ? {
            status: 'signed-in',
            session: {
              accountId: 'account-1',
              desktopSessionId: 'session-1',
              email: 'alice@example.com',
              displayName: 'Alice',
              channel: 'stable',
              accessTokenExpiresAt: '2030-01-01T00:00:00Z',
            },
          }
        : { status: 'signed-out' },
      updateProfile: vi.fn(),
      signOut: vi.fn(),
    }),
}));

describe('SettingsPanel — Organizations', () => {
  it('uses the current organization permissions for search and removes account results on sign-out', async () => {
    let mounted!: ReturnType<typeof render>;

    await act(async () => {
      mounted = render(<SettingsPanel />);
    });
    const { rerender } = mounted;
    await screen.findByTestId('settings-nav-organization-audit');
    const search = screen.getByRole('searchbox', { name: 'Search settings' });
    fireEvent.change(search, { target: { value: 'audit' } });
    expect(screen.getByRole('button', { name: /Organization.*Audit log/ })).toBeVisible();
    h.signedIn = false;
    rerender(<SettingsPanel />);
    expect(screen.queryByRole('button', { name: /Organization.*Audit log/ })).toBeNull();
    expect(screen.getByText('No settings found.')).toBeVisible();
    fireEvent.change(search, { target: { value: 'profile' } });
    expect(screen.queryByRole('button', { name: /^Account\b/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Terminal.*Shell profiles/ })).toBeVisible();
  });

  it('opens account fields from search and preserves unsaved drafts while searching', async () => {
    render(<SettingsPanel />);
    await screen.findByTestId('settings-nav-account');
    const search = screen.getByRole('searchbox', { name: 'Search settings' });
    fireEvent.change(search, { target: { value: 'display name' } });
    fireEvent.click(screen.getByRole('button', { name: /Account.*Profile.*Display name/ }));
    const name = screen.getByTestId('account-settings-display-name');
    await waitFor(() => expect(name).toHaveFocus());
    expect(screen.getByTestId('settings-scope')).toHaveTextContent('Your account');
    fireEvent.change(name, { target: { value: 'Unsaved profile draft' } });
    fireEvent.change(search, { target: { value: 'theme' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clear', exact: true }));
    expect(name).toHaveValue('Unsaved profile draft');
    expect(search).toHaveFocus();
    fireEvent.change(search, { target: { value: 'email' } });
    fireEvent.click(screen.getByRole('button', { name: /Account.*Profile.*Email/ }));
    await waitFor(() => expect(screen.getByTestId('account-settings-email')).toHaveFocus());
    expect(screen.getByTestId('account-settings-email')).toHaveAttribute('readonly');
  });

  it('uses the same permitted section list for compact and sidebar navigation', async () => {
    render(<SettingsPanel />);
    await screen.findByTestId('settings-nav-organization-audit');
    const picker = screen.getByRole('combobox', { name: 'Settings section' });
    fireEvent.click(picker);
    expect(screen.getByRole('option', { name: 'Organization · General' })).toBeVisible();
    expect(screen.queryByRole('option', { name: /Extensions/ })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: 'App · Appearance' }));
    expect(screen.getByTestId('settings-nav-appearance')).toHaveAttribute(
      'aria-current',
      'location'
    );
    expect(screen.getByRole('heading', { name: 'Appearance' })).toBeVisible();
  });

  it('returns to General when switching from an administrator page to a member organization', async () => {
    const listOrganizations = h.cloudSync.listOrganizations.getMockImplementation()!;
    h.cloudSync.listOrganizations.mockImplementation(async () => {
      const result = await listOrganizations();
      return {
        ...result,
        organizations: result.organizations.map((organization: { orgId: string }) =>
          organization.orgId === ORG_B
            ? { ...organization, role: 'member', isAdministrator: false }
            : organization
        ),
      };
    });
    const listDirectory = h.cloudSync.listOrganizationDirectory.getMockImplementation()!;
    h.cloudSync.listOrganizationDirectory.mockImplementation(async (orgId: string) => {
      const result = await listDirectory(orgId);
      return orgId === ORG_B
        ? {
            ...result,
            directory: {
              ...result.directory,
              viewer: {
                ...result.directory.viewer,
                role: 'member',
                isOwner: false,
                canViewAudit: false,
                canConfigureProvisioning: false,
                canEditSettings: false,
                canDelete: false,
              },
            },
          }
        : result;
    });
    render(<SettingsPanel />);
    fireEvent.click(await screen.findByTestId('settings-nav-organization-audit'));
    const search = screen.getByRole('searchbox', { name: 'Search settings' });
    fireEvent.change(search, { target: { value: 'audit' } });
    expect(screen.getByRole('button', { name: /Organization.*Audit log/ })).toBeVisible();
    fireEvent.click(screen.getByTestId('settings-org-switcher-compact'));
    fireEvent.click(screen.getByRole('option', { name: 'Beta', exact: true }));
    await waitFor(() =>
      expect(screen.getByTestId('settings-nav-organization-general')).toHaveAttribute(
        'aria-current',
        'location'
      )
    );
    expect(await screen.findByTestId('organization-admin-title')).toHaveTextContent('Beta');
    expect(screen.queryByTestId('settings-nav-organization-audit')).toBeNull();
    fireEvent.change(search, { target: { value: 'audit' } });
    expect(screen.queryByRole('button', { name: /Organization.*Audit log/ })).toBeNull();
    expect(screen.getByText('No settings found.')).toBeVisible();
    fireEvent.change(search, { target: { value: '' } });
    expect(screen.getByTestId('settings-scope')).toHaveTextContent('Organization · Beta');
    fireEvent.click(screen.getByRole('combobox', { name: 'Settings section' }));
    for (const name of [
      'Organization · Audit log',
      'Organization · Directory sync',
      'Organization · Sync health',
    ]) {
      expect(screen.queryByRole('option', { name })).toBeNull();
    }
  });

  it('uses the shared general form heading and cancels edits without saving', async () => {
    render(<SettingsPanel />);
    fireEvent.click(await screen.findByTestId('settings-nav-organization-general'));
    const name = await screen.findByTestId('organization-admin-title');
    await waitFor(() => expect(name).toHaveValue('Acme'));
    expect(screen.getByRole('heading', { name: 'General', exact: true })).toBeVisible();
    expect(screen.getByTestId('organization-settings-save')).toBeDisabled();
    fireEvent.change(name, { target: { value: 'Edited lab' } });
    expect(screen.getByText('Unsaved changes')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel', exact: true }));
    expect(name).toHaveValue('Acme');
    expect(h.cloudSync.updateOrganization).not.toHaveBeenCalled();
  });

  it('puts the research setting in Account Privacy and removes it after sign-out', async () => {
    const { rerender } = render(<SettingsPanel />);
    expect(screen.queryByTestId('hosted-contribution-settings')).toBeNull();
    expect(screen.getByTestId('settings-nav-group-account')).toContainElement(
      screen.getByTestId('settings-nav-privacy')
    );
    fireEvent.click(screen.getByTestId('settings-nav-privacy'));
    expect(screen.getByTestId('settings-section-account-privacy')).toContainElement(
      screen.getByTestId('hosted-contribution-settings')
    );
    expect(screen.getByTestId('settings-nav-privacy')).toHaveAttribute('aria-current', 'location');
    fireEvent.click(screen.getByTestId('settings-nav-ai'));
    expect(screen.queryByTestId('hosted-contribution-settings')).toBeNull();
    fireEvent.click(screen.getByTestId('settings-nav-privacy'));
    h.signedIn = false;
    rerender(<SettingsPanel />);
    expect(screen.queryByTestId('settings-nav-privacy')).toBeNull();
    expect(screen.queryByTestId('hosted-contribution-settings')).toBeNull();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    h.signedIn = true;
    h.cloudSync.listOrganizations.mockResolvedValue({
      ok: true,
      organizations: [
        {
          orgId: ORG_A,
          slug: 'acme',
          displayName: 'Acme',
          role: 'owner',
          canCreateManagedProjects: true,
          isAdministrator: true,
        },
        {
          orgId: ORG_B,
          slug: 'beta',
          displayName: 'Beta',
          role: 'owner',
          canCreateManagedProjects: true,
          isAdministrator: true,
        },
      ],
    });
    h.cloudSync.listOrganizationDirectory.mockImplementation(async (orgId: string) => ({
      ok: true,
      directory: {
        orgId,
        slug: orgId === ORG_B ? 'beta' : 'acme',
        displayName: orgId === ORG_B ? 'Beta' : 'Acme',
        viewer: {
          accountId: 'account-1',
          role: 'owner',
          canInvite: true,
          canChangeRole: true,
          canRemove: true,
          canEditSettings: true,
          canDelete: true,
          canViewAudit: true,
          canConfigureProvisioning: true,
          isOwner: true,
        },
        members: [
          {
            accountId: orgId === ORG_B ? 'account-2' : 'account-1',
            role: 'owner',
            displayName: orgId === ORG_B ? 'Blair' : 'Alice',
            email: orgId === ORG_B ? 'blair@example.com' : 'alice@example.com',
            joinedAt: '2026-01-01T00:00:00Z',
          },
        ],
        invites: [],
      },
    }));
    h.cloudSync.syncOrganizationRegistry.mockImplementation(async (orgId: string) => ({
      ok: true,
      sync: { status: 'ready', cursor: 8, pendingCount: 0, conflictCount: 0 },
      registry: {
        orgId,
        state: {
          cursor: 8,
          status: 'ready',
          clientId: 'desktop:test',
          lastPullAt: 1_795_000_000_000,
          lastPushAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
        },
        idSchemes: [{ entityKind: '*', prefix: 'REG', padWidth: 6, nextValue: 2 }],
        schemas: [
          {
            id: 'schema-1',
            name: 'strain',
            displayName: 'Strain',
            version: 2,
            currentRevisionId: 'schema-revision-2',
          },
        ],
        schemaRevisions: [],
        entities: [
          {
            id: 'entity-1',
            registryId: 'REG-000001',
            name: 'MG1655',
            entityKind: 'strain',
            revision: 3,
            schemaVersion: 2,
            lifecycleState: 'active',
          },
        ],
        entityRevisions: [],
        relationships: [],
        placements: [
          {
            id: 'placement-1',
            entityId: 'entity-1',
            workspaceId: 'project-a',
            path: 'samples/mg1655',
          },
          {
            id: 'placement-2',
            entityId: 'entity-1',
            workspaceId: 'project-b',
            path: 'samples/mg1655',
          },
        ],
        pendingMutations: [],
        conflicts: [],
      },
    }));
    h.cloudSync.getOrganizationRegistry.mockImplementation((orgId: string) =>
      h.cloudSync.syncOrganizationRegistry(orgId)
    );
    h.cloudSync.getOrganizationProvisioningStatus.mockImplementation(async (orgId: string) => ({
      ok: true,
      status: { orgId, configured: false, seatCount: 1, seatLimit: null },
    }));
    h.cloudSync.openOrganizationProvisioningPortal.mockResolvedValue({
      ok: true,
      status: 'opened',
    });
    h.cloudSync.getOrganizationRegistrySyncHealth.mockResolvedValue({
      ok: true,
      health: {
        orgId: ORG_A,
        cursor: 8,
        entityCount: 1,
        conflictCount: 0,
        replicas: [
          {
            clientId: 'desktop:test',
            accountId: 'account-1',
            accountName: 'Alice',
            lastEventSeq: 8,
            lagEvents: 0,
            lastPushAt: null,
            lastPullAt: '2026-09-21T20:00:00Z',
            lastErrorCode: null,
            conflictCount: 0,
            updatedAt: '2026-09-21T20:00:00Z',
          },
        ],
      },
    });
    h.cloudSync.getOrganizationDeletionImpact.mockResolvedValue({
      ok: true,
      impact: {
        orgId: ORG_A,
        projectCount: 2,
        archivedProjectCount: 1,
        registryEntityCount: 1,
        archivedRegistryEntityCount: 2,
        registrySchemaCount: 1,
        registryReplicaCount: 1,
        syncStorageObjectCount: 3,
        syncStorageReservationCount: 1,
        canDelete: false,
      },
    });
  });

  it('puts organizations in Settings with a switcher and section nav', async () => {
    render(<SettingsPanel />);
    expect(screen.getByTestId('settings-nav-ai')).toBeTruthy();
    expect(screen.getByTestId('settings-nav-group-account')).toHaveTextContent('Account');
    expect(screen.getByTestId('settings-nav-group-app')).toHaveTextContent('App');
    expect(screen.getByTestId('settings-nav-group-organization')).toHaveTextContent('Organization');
    expect(screen.getByTestId('settings-nav-account')).toHaveTextContent('Profile');
    expect(await screen.findByTestId('settings-org-switcher')).toBeTruthy();
    expect(screen.getByTestId('settings-nav-organization-general')).toHaveTextContent('General');
    expect(screen.getByTestId('settings-nav-organization-members')).toHaveTextContent('People');
    expect(screen.queryByTestId('settings-nav-organization-invitations')).toBeNull();
    expect(await screen.findByTestId('settings-nav-organization-audit')).toHaveTextContent(
      'Audit log'
    );
    expect(screen.getByTestId('settings-nav-registry')).toHaveTextContent('Registry');
    expect(screen.queryByTestId('settings-nav-organization-registry')).toBeNull();
    expect(screen.getByTestId('settings-nav-organization-sync-health')).toHaveTextContent(
      'Sync health'
    );
    expect(screen.getByTestId('settings-nav-organization-provisioning')).toHaveTextContent(
      'Directory sync'
    );
    expect(screen.getByTestId('settings-nav-organization-create')).toHaveTextContent(
      'Create organization'
    );
    fireEvent.click(screen.getByTestId('settings-nav-account'));
    expect(screen.getByTestId('account-settings-display-name')).toHaveValue('Alice');
    expect(screen.getByTestId('account-settings-email')).toHaveValue('alice@example.com');
    fireEvent.click(screen.getByTestId('settings-nav-organization-general'));
    expect(await screen.findByTestId('organization-admin-title')).toHaveValue('Acme');
    expect(document.body.textContent).not.toMatch(
      /New projects|Members choose|Always managed by the lab/i
    );
    fireEvent.click(screen.getByTestId('settings-org-switcher'));
    fireEvent.click(screen.getByRole('option', { name: 'Beta' }));
    await waitFor(() => expect(screen.getByTestId('organization-admin-title')).toHaveValue('Beta'));
    fireEvent.click(screen.getByTestId('settings-nav-organization-members'));
    expect(await screen.findByText('Blair')).toBeTruthy();
    expect(screen.queryByText('Alice')).toBeNull();
    fireEvent.click(screen.getByTestId('settings-nav-organization-provisioning'));
    expect(await screen.findByTestId('organization-settings-provisioning')).toHaveTextContent(
      'Not connected'
    );
  });

  it('routes organization registration to saved-record review without publishing', async () => {
    const open = vi.fn();
    const unsubscribe = subscribeRegistryOpen(open);
    try {
      render(<SettingsPanel />);
      fireEvent.click(await screen.findByTestId('settings-nav-registry'));
      expect(await screen.findByRole('region', { name: 'Registry schemas' })).toBeVisible();
      fireEvent.click(await screen.findByRole('tab', { name: 'Registration' }));
      expect(screen.queryByLabelText('Schema fields JSON')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Registry record fields JSON')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Choose records…' }));
      expect(open).toHaveBeenLastCalledWith({
        entityId: null,
        fallbackSearch: '',
        organizationId: ORG_A,
        action: 'claim',
      });
      expect(h.cloudSync.mutateOrganizationRegistry).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it('edits organization schema fields in the shared table with the checked version', async () => {
    h.cloudSync.mutateOrganizationRegistry.mockImplementation((orgId: string) =>
      h.cloudSync.syncOrganizationRegistry(orgId)
    );
    render(<SettingsPanel />);
    fireEvent.click(await screen.findByTestId('settings-nav-registry'));
    const manager = await screen.findByRole('region', { name: 'Registry schemas' });
    fireEvent.click(
      await within(manager).findByTestId(`registry-schema-organization:${ORG_A}-strain`)
    );
    const table = within(manager).getByTestId('schema-own-fields');
    fireEvent.click(within(manager).getByRole('button', { name: 'Edit schema' }));
    expect(within(manager).getByTestId('schema-own-fields')).toBe(table);
    fireEvent.click(within(manager).getByRole('button', { name: 'Add field' }));
    fireEvent.change(within(manager).getByLabelText('Field 1 label'), {
      target: { value: 'Freezer' },
    });
    fireEvent.click(within(manager).getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(h.cloudSync.mutateOrganizationRegistry).toHaveBeenCalledWith(
        ORG_A,
        expect.objectContaining({
          operation: 'schema.refine',
          payload: expect.objectContaining({
            id: 'schema-1',
            expectedVersion: 2,
            fields: [{ key: 'freezer', label: 'Freezer', type: 'text', required: false }],
          }),
        })
      )
    );
    expect(manager).toBeVisible();
  });

  it('saves a directory group role through the shared picker without offering owner access', async () => {
    h.cloudSync.getOrganizationProvisioningStatus.mockImplementation(async (orgId: string) => ({
      ok: true,
      status: {
        orgId,
        configured: true,
        status: 'active',
        seatCount: 1,
        seatLimit: null,
        groups: [{ externalId: 'reviewers', displayName: 'Reviewers', roleId: 'member' }],
        pendingAccountCount: 0,
      },
    }));
    h.cloudSync.setOrganizationProvisioningGroupRole.mockResolvedValue({ ok: true });
    render(<SettingsPanel />);
    fireEvent.click(await screen.findByTestId('settings-nav-organization-provisioning'));
    const role = await screen.findByRole('combobox', { name: 'Role for Reviewers' });
    expect(role).toHaveAttribute('data-settings-control', 'select');
    fireEvent.click(role);
    expect(screen.queryByRole('option', { name: 'Owner', exact: true })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: 'Admin', exact: true }));
    await waitFor(() =>
      expect(h.cloudSync.setOrganizationProvisioningGroupRole).toHaveBeenCalledWith(ORG_A, {
        externalGroupId: 'reviewers',
        roleId: 'admin',
      })
    );
  });

  it('waits for memberships before choosing the organization landing section', async () => {
    const handled = vi.fn();

    function FocusedSettings() {
      const [focusTarget, setFocusTarget] = useState<'organizations' | null>('organizations');
      return (
        <SettingsPanel
          focusTarget={focusTarget}
          onFocusTargetHandled={() => {
            handled();
            setFocusTarget(null);
          }}
        />
      );
    }

    render(<FocusedSettings />);

    expect(await screen.findByTestId('organization-admin-title')).toHaveValue('Acme');
    expect(screen.queryByTestId('organization-admin-name')).toBeNull();
    expect(handled).toHaveBeenCalled();
  });

  it('opens login directory setup from the People section', async () => {
    render(<SettingsPanel />);

    fireEvent.click(await screen.findByTestId('settings-nav-organization-members'));
    expect(await screen.findByTestId('organization-people-directory')).toHaveTextContent(
      'Company login directory'
    );
    fireEvent.click(screen.getByTestId('organization-people-directory-connect'));
    await waitFor(() =>
      expect(h.cloudSync.openOrganizationProvisioningPortal).toHaveBeenCalledWith(ORG_A)
    );
  });

  it('links to canonical Registry entities and shows sync health and deletion impact', async () => {
    render(<SettingsPanel />);

    fireEvent.click(await screen.findByTestId('settings-nav-registry'));
    fireEvent.click(await screen.findByRole('tab', { name: 'Registration' }));
    expect(await screen.findByText('1 registered entity')).toBeVisible();
    expect(screen.queryByTestId('organization-registry-record-entity-1')).toBeNull();
    const open = vi.fn();
    const unsubscribe = subscribeRegistryOpen(open);
    fireEvent.click(screen.getByRole('button', { name: 'View entities' }));
    unsubscribe();
    expect(open).toHaveBeenCalledWith({
      entityId: null,
      fallbackSearch: '',
      organizationId: ORG_A,
      action: 'browse',
    });

    fireEvent.click(screen.getByTestId('settings-nav-organization-sync-health'));
    expect(await screen.findByTestId('organization-registry-sync-health')).toHaveTextContent(
      'Alice'
    );
    expect(screen.getByTestId('organization-registry-sync-health')).toHaveTextContent('Up to date');

    fireEvent.click(screen.getByTestId('settings-nav-organization-general'));
    expect(await screen.findByTestId('organization-settings-delete-impact')).toHaveTextContent(
      '2 projects'
    );
    expect(screen.getByTestId('organization-settings-delete-impact')).toHaveTextContent(
      '1 Registry record'
    );
    expect(screen.getByTestId('organization-settings-delete-impact')).toHaveTextContent(
      '3 live storage objects'
    );
    expect(screen.getByTestId('organization-settings-delete-impact')).toHaveTextContent(
      '1 live upload reservation'
    );
    expect(screen.getByTestId('organization-settings-delete-submit')).toBeDisabled();
  });

  it('rejects a Registry ID width below the server minimum before configuration', async () => {
    h.cloudSync.syncOrganizationRegistry.mockResolvedValue({
      ok: true,
      sync: { status: 'not_configured', cursor: 0, pendingCount: 0, conflictCount: 0 },
      registry: {
        orgId: ORG_A,
        state: {
          cursor: 0,
          status: 'error',
          clientId: 'desktop:test',
          lastPullAt: null,
          lastPushAt: null,
          lastErrorCode: 'NOT_CONFIGURED',
          lastErrorMessage: 'Registry setup required.',
        },
        idSchemes: [],
        schemas: [],
        schemaRevisions: [],
        entities: [],
        entityRevisions: [],
        relationships: [],
        placements: [],
        pendingMutations: [],
        conflicts: [],
      },
    });
    render(<SettingsPanel />);

    fireEvent.click(await screen.findByTestId('settings-nav-registry'));
    fireEvent.click(await screen.findByRole('tab', { name: 'Registration' }));
    fireEvent.change(await screen.findByLabelText('Number width'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set up registration' }));

    expect(await screen.findByText('ID width must be an integer from 2 through 12.')).toBeTruthy();
    expect(h.cloudSync.configureOrganizationRegistry).not.toHaveBeenCalled();
  });

  it('hides organization settings when signed out', async () => {
    h.signedIn = false;
    render(<SettingsPanel />);
    expect(screen.queryByTestId('settings-org-switcher')).toBeNull();
    expect(screen.queryByTestId('settings-nav-group-account')).toBeNull();
    expect(screen.getByTestId('settings-nav-group-app')).toContainElement(
      screen.getByTestId('settings-nav-ai')
    );
    fireEvent.click(screen.getByRole('combobox', { name: 'Settings section' }));
    expect(screen.queryByRole('option', { name: /^(Account|Organization) ·/ })).toBeNull();
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Settings section' }), {
      key: 'Escape',
    });
    expect(screen.queryByTestId('settings-nav-group-organization')).toBeNull();
    expect(screen.queryByTestId('settings-nav-account')).toBeNull();
    expect(screen.queryByTestId('settings-nav-organization-general')).toBeNull();
    expect(screen.queryByTestId('settings-nav-organization-create')).toBeNull();
    expect(screen.getByTestId('settings-nav-ai')).toBeTruthy();
  });

  it('falls back to App settings when the session ends on an account page', async () => {
    const { rerender } = render(<SettingsPanel />);
    fireEvent.click(screen.getByTestId('settings-nav-account'));
    expect(screen.getByTestId('account-settings-display-name')).toHaveValue('Alice');
    h.signedIn = false;
    rerender(<SettingsPanel />);
    expect(screen.queryByTestId('settings-nav-account')).toBeNull();
    expect(screen.queryByTestId('settings-nav-group-organization')).toBeNull();
    expect(screen.getByTestId('settings-nav-ai')).toHaveAttribute('aria-current', 'location');
    expect(screen.getByTestId('settings-section-ai')).toBeTruthy();
  });
});

import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { OrganizationRegistryView } from '../../../../shared/org-registry-sync';
import type { WorkspaceSyncOrganizationSummary } from '../../../../shared/workspace-sync-ipc';
import { UnconnectedFilterButton } from './RegistryFailedTag';
import {
  OrganizationRegistryTable,
  RegistryScopeControls,
  organizationRegistryProjects,
  organizationRegistryRecords,
  type RegistryScope,
} from './RegistryScopeSurface';

const organization: WorkspaceSyncOrganizationSummary = {
  orgId: '11111111-1111-4111-8111-111111111111',
  slug: 'acme',
  displayName: 'Acme Bio',
  role: 'member',
  canCreateManagedProjects: true,
  isAdministrator: false,
};

const registry: OrganizationRegistryView = {
  orgId: organization.orgId,
  state: {
    cursor: 12,
    accessGeneration: `home-v1:${'a'.repeat(64)}`,
    status: 'ready',
    clientId: 'desktop:test',
    lastPullAt: 1_795_000_000_000,
    lastPushAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
  },
  idSchemes: [],
  schemas: [],
  schemaRevisions: [],
  entities: [
    {
      id: 'entity-a',
      registryId: 'ACME-0001',
      name: 'MG1655',
      kind: 'strain',
      revision: 4,
      archivedAt: null,
      fields: { host: 'E. coli' },
    },
    {
      id: 'entity-b',
      registryId: 'ACME-0002',
      name: 'pUC19',
      kind: 'plasmid',
      revision: 2,
      archivedAt: null,
      fields: {},
    },
  ],
  entityRevisions: [],
  relationships: [],
  placements: [
    {
      id: 'placement-a',
      entityId: 'entity-a',
      workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      path: 'samples/mg1655.json',
    },
    {
      id: 'placement-b',
      entityId: 'entity-a',
      workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      path: 'samples/mg1655.json',
    },
    {
      id: 'placement-c',
      entityId: 'entity-b',
      workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      path: 'plasmids/puc19.gb',
    },
  ],
  pendingMutations: [],
  conflicts: [],
};

describe('Registry scope surface', () => {
  it('keeps accessible legacy homes and references even when the file-sync directory omits them', () => {
    const home = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const hidden = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const view = { ...registry, entities: [{ ...registry.entities[0], homeWorkspaceId: home }] };
    const options = organizationRegistryProjects(
      view,
      [],
      [
        { remoteWorkspaceId: home, ownerOrgId: organization.orgId, displayName: 'Legacy home' },
        {
          remoteWorkspaceId: hidden,
          ownerOrgId: organization.orgId,
          displayName: 'Hidden project',
        },
      ]
    );
    expect(options).toContainEqual({
      remoteWorkspaceId: home,
      ownerOrgId: organization.orgId,
      displayName: 'Legacy home',
    });
    expect(options.map((project) => project.remoteWorkspaceId)).toEqual(
      expect.arrayContaining([
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      ])
    );
    expect(options.some((project) => project.remoteWorkspaceId === hidden)).toBe(false);
    expect(
      organizationRegistryProjects(
        { ...view, state: { ...view.state, status: 'access_revoked' } },
        options
      )
    ).toEqual([]);
  });

  it('omits organization actions while browsing device records', () => {
    render(
      <RegistryScopeControls
        scope="local"
        setScope={vi.fn()}
        organizations={[organization]}
        selectedOrgId={organization.orgId}
        setSelectedOrgId={vi.fn()}
        loading={false}
        registry={null}
        onSync={vi.fn()}
      />
    );
    expect(screen.queryByTestId('lims-registry-scope-controls')).not.toBeInTheDocument();
    expect(screen.queryByText(/records available on this device/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/organization registration keeps/i)).not.toBeInTheDocument();
  });

  it('keeps explicit reference destinations and sync actions separate from record filtering', () => {
    const setScope = vi.fn<(scope: RegistryScope) => void>();
    const setSelectedProjectId = vi.fn();
    const onSync = vi.fn();
    render(
      <RegistryScopeControls
        scope="organization"
        setScope={setScope}
        organizations={[organization]}
        selectedOrgId={organization.orgId}
        setSelectedOrgId={vi.fn()}
        loading={false}
        registry={registry}
        onSync={onSync}
        projects={[
          {
            remoteWorkspaceId: 'project-a',
            displayName: 'Project A',
            ownerOrgId: organization.orgId,
          },
        ]}
        selectedProjectId={null}
        setSelectedProjectId={setSelectedProjectId}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Registry actions' }));
    expect(screen.getByTestId('lims-registry-organization-sync-state')).toHaveTextContent(
      'Up to date'
    );
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Project A' }));
    expect(setSelectedProjectId).toHaveBeenCalledWith('project-a');
    expect(setScope).not.toHaveBeenCalled();
    expect(onSync).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));
    expect(onSync).toHaveBeenCalledOnce();
  });

  it('combines multiple project homes and references with schema, text and archive criteria without duplicate records', () => {
    const projectA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const projectB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const view = {
      ...registry,
      entities: [
        { ...registry.entities[0], homeWorkspaceId: projectA },
        { ...registry.entities[0], id: 'entity-c', name: 'MG1655 copy', homeWorkspaceId: projectB },
        { ...registry.entities[1], homeWorkspaceId: projectB },
        { ...registry.entities[0], id: 'archived', homeWorkspaceId: projectA, archivedAt: 1 },
      ],
    };
    const records = organizationRegistryRecords(view, 'organization', null, '', {
      projectIds: [projectA, projectB],
      kinds: ['strain'],
      nameLike: 'MG1655',
      includeArchived: false,
    });
    expect(records.map((record) => record.id)).toEqual(['entity-a', 'entity-c']);
    expect(
      organizationRegistryRecords(view, 'organization', null, '', {
        projectIds: [projectA],
        registryIdLike: 'acme-0002',
        includeArchived: true,
      })
    ).toEqual([]);
    expect(
      organizationRegistryRecords(
        { ...view, state: { ...view.state, status: 'access_revoked' } },
        'organization',
        null,
        '',
        { projectIds: [projectA, projectB] }
      )
    ).toEqual([]);
  });

  it('hides an empty unresolved-links filter but keeps an active filter clearable', () => {
    const onClick = vi.fn();
    const view = render(
      <UnconnectedFilterButton active={false} count={0} onClick={onClick} testId="unresolved" />
    );
    expect(screen.queryByTestId('unresolved')).not.toBeInTheDocument();
    view.rerender(
      <UnconnectedFilterButton active count={0} onClick={onClick} testId="unresolved" />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Unresolved links (0)' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    view.rerender(
      <UnconnectedFilterButton active={false} count={2} onClick={onClick} testId="unresolved" />
    );
    expect(screen.getByRole('button', { name: 'Unresolved links (2)' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
  });

  it('shows canonical organization provenance and every project placement', () => {
    render(
      <OrganizationRegistryTable
        scope="organization"
        organization={organization}
        registry={registry}
        search=""
        loading={false}
        error={null}
        project={null}
      />
    );

    const row = screen.getByTestId('organization-registry-scope-row-entity-a');
    expect(within(row).getByText('ACME-0001')).toBeVisible();
    expect(within(row).getByText(/organization · acme bio/i)).toBeVisible();
    expect(within(row).getByText(/2 project references/i)).toBeVisible();
    expect(within(row).getAllByText('samples/mg1655.json')).toHaveLength(2);
  });

  it('filters Project scope by the bound remote project rather than by local filesystem identity', () => {
    render(
      <OrganizationRegistryTable
        scope="project"
        organization={organization}
        registry={registry}
        search=""
        loading={false}
        error={null}
        project={{
          remoteWorkspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          displayName: 'Fermentation project',
          ownerOrgId: organization.orgId,
        }}
      />
    );

    expect(screen.getAllByText(/project · fermentation project/i)).toHaveLength(2);
    expect(screen.getByTestId('organization-registry-scope-row-entity-a')).toBeVisible();
    expect(screen.queryByTestId('organization-registry-scope-row-entity-b')).toBeNull();
    expect(screen.getByText('samples/mg1655.json')).toBeVisible();
  });

  it('adds and removes an explicit project-level placement without inventing a file path', () => {
    const onAddProjectPlacement = vi.fn();
    const onRemoveProjectPlacement = vi.fn();
    const project = {
      remoteWorkspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      displayName: 'Fermentation project',
      ownerOrgId: organization.orgId,
    };
    render(
      <OrganizationRegistryTable
        scope="organization"
        organization={organization}
        registry={registry}
        search=""
        loading={false}
        error={null}
        project={project}
        onAddProjectPlacement={onAddProjectPlacement}
        onRemoveProjectPlacement={onRemoveProjectPlacement}
      />
    );

    const placed = screen.getByTestId('organization-registry-scope-row-entity-a');
    fireEvent.click(
      within(placed).getByRole('button', { name: /remove reference from fermentation project/i })
    );
    expect(onRemoveProjectPlacement).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'placement-a', entityId: 'entity-a' })
    );

    const unplaced = screen.getByTestId('organization-registry-scope-row-entity-b');
    fireEvent.click(
      within(unplaced).getByRole('button', { name: /add reference in fermentation project/i })
    );
    expect(onAddProjectPlacement).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'entity-b', registryId: 'ACME-0002' })
    );
  });

  it('includes a registered record in its home project without an optional placement', () => {
    const home = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    render(
      <OrganizationRegistryTable
        scope="project"
        organization={organization}
        registry={{
          ...registry,
          placements: [],
          entities: [
            { ...registry.entities[0], homeWorkspaceId: home },
            { ...registry.entities[1], homeWorkspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
          ],
        }}
        search=""
        loading={false}
        error={null}
        project={{
          remoteWorkspaceId: home,
          displayName: 'Home project',
          ownerOrgId: organization.orgId,
        }}
      />
    );
    expect(screen.getByTestId('organization-registry-scope-row-entity-a')).toBeVisible();
    expect(screen.queryByTestId('organization-registry-scope-row-entity-b')).toBeNull();
  });

  it('asks for an explicit project before filtering', () => {
    render(
      <OrganizationRegistryTable
        scope="project"
        organization={organization}
        registry={registry}
        search=""
        loading={false}
        error={null}
        project={null}
      />
    );

    expect(screen.getByText(/choose a project to filter registered records/i)).toBeVisible();
    expect(screen.queryByTestId('organization-registry-scope-row-entity-a')).toBeNull();
  });
});

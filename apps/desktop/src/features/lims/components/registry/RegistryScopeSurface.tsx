import { toUserMessage } from '@waypoint/user-messages';
import { safeFocus } from '../../../../shared/utils/safeFocus';
import { useEffect, useRef, useState } from 'react';
import { PortalMenu } from '../../../../components/PortalMenu';
import { Button } from '../../../../components/ui';
import { RegistryFilterChoices } from './RegistryFilters';
import { SheetSyncManagerButton } from '../SheetSyncManager';
import type { OrganizationRegistryView } from '../../../../shared/org-registry-sync';
import type { WorkspaceSyncOrganizationSummary } from '../../../../shared/workspace-sync-ipc';

export type RegistryScope = 'local' | 'organization' | 'project';

export interface RegistryProjectBinding {
  remoteWorkspaceId: string;
  displayName: string;
  ownerOrgId: string | null;
}

export function organizationRegistryProjects(
  registry: OrganizationRegistryView,
  directory: RegistryProjectBinding[],
  localNames: RegistryProjectBinding[] = []
): RegistryProjectBinding[] {
  if (registry.state.status === 'access_revoked') return [];
  const projects = new Map<string, RegistryProjectBinding>();
  for (const project of directory) {
    if (project.ownerOrgId === registry.orgId) projects.set(project.remoteWorkspaceId, project);
  }
  const visibleIds = new Set<string>();
  for (const entity of registry.entities) {
    if (typeof entity.homeWorkspaceId === 'string') visibleIds.add(entity.homeWorkspaceId);
  }
  for (const placement of registry.placements) {
    if (typeof placement.workspaceId === 'string') visibleIds.add(placement.workspaceId);
  }
  for (const id of visibleIds) {
    if (projects.has(id)) continue;
    const local = localNames.find(
      (project) => project.remoteWorkspaceId === id && project.ownerOrgId === registry.orgId
    );
    projects.set(id, {
      remoteWorkspaceId: id,
      displayName: local?.displayName ?? `Project ${id}`,
      ownerOrgId: registry.orgId,
    });
  }
  return [...projects.values()].sort(
    (a, b) =>
      a.displayName.localeCompare(b.displayName) ||
      a.remoteWorkspaceId.localeCompare(b.remoteWorkspaceId)
  );
}

export interface OrganizationRegistryRecord {
  id: string;
  homeWorkspaceId: string | null;
  registryId: string;
  name: string;
  kind: string;
  revision: number | null;
  archived: boolean;
  searchableText: string;
  raw: Record<string, unknown>;
}

export interface OrganizationRegistryPlacement {
  id: string;
  entityId: string;
  workspaceId: string;
  path: string | null;
  resourceId: string | null;
}

export function RegistryScopeControls({
  scope,
  organizations,
  selectedOrgId,
  loading,
  registry,
  onSync,
  onClaimLocal,
  projects = [],
  selectedProjectId = null,
  setSelectedProjectId,
}: {
  scope: RegistryScope;
  setScope: (scope: RegistryScope) => void;
  organizations: WorkspaceSyncOrganizationSummary[];
  selectedOrgId: string | null;
  setSelectedOrgId: (orgId: string) => void;
  loading: boolean;
  registry: OrganizationRegistryView | null;
  onSync: () => void;
  onClaimLocal?: () => void;
  projects?: RegistryProjectBinding[];
  selectedProjectId?: string | null;
  setSelectedProjectId?: (projectId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    setOpen(false);
  }, [scope, selectedOrgId]);
  const selected = organizations.find((candidate) => candidate.orgId === selectedOrgId) ?? null;
  if (scope === 'local') return <SheetSyncManagerButton />;
  if (!selected) return null;
  const syncLabel =
    registry?.state.status === 'ready'
      ? 'Up to date'
      : registry?.state.status === 'access_revoked'
        ? 'Access removed; organization cache cleared'
        : registry?.state.status === 'error'
          ? 'Offline; changes remain queued'
          : registry?.state.status === 'syncing'
            ? 'Synchronizing…'
            : 'Organization Registry not loaded';
  return (
    <div data-testid="lims-registry-scope-controls" className="ml-auto">
      <button
        ref={anchorRef}
        type="button"
        aria-label="Registry actions"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="rounded-md px-2 py-1.5 text-xs text-fg-muted hover:bg-bg-muted hover:text-fg"
      >
        •••
      </button>
      <PortalMenu
        open={open}
        anchorRef={anchorRef}
        onRequestClose={() => setOpen(false)}
        role="dialog"
        aria-label="Registry actions"
        preferredSide="bottom"
        surfaceVariant="settings"
        className="w-72 p-4"
      >
        <div
          className="space-y-3"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
              safeFocus(anchorRef.current, { preventScroll: true });
            }
          }}
        >
          <div>
            <h2 className="text-sm font-semibold text-fg">{selected.displayName}</h2>
            <p
              data-testid="lims-registry-organization-sync-state"
              className="mt-1 text-xs text-fg-subtle"
            >
              {syncLabel}
              {registry?.pendingMutations.length
                ? ` · ${registry.pendingMutations.length} queued`
                : ''}
              {registry?.conflicts.length ? ` · ${registry.conflicts.length} conflicts` : ''}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button disabled={loading} onClick={onSync}>
              {loading ? 'Syncing…' : 'Sync now'}
            </Button>
            {onClaimLocal && registry?.schemas.length ? (
              <Button
                disabled={loading}
                onClick={() => {
                  setOpen(false);
                  onClaimLocal();
                }}
              >
                Claim local records…
              </Button>
            ) : null}
          </div>
          {setSelectedProjectId ? (
            <section className="space-y-2">
              <h3 className="text-xs font-medium text-fg">Reference destination</h3>
              <RegistryFilterChoices
                facet={{
                  key: 'reference-destination',
                  label: 'Reference project',
                  searchLabel: 'Search reference destinations',
                  single: true,
                  context: true,
                  options: [
                    { value: '', label: 'No destination selected' },
                    ...projects.map((project) => ({
                      value: project.remoteWorkspaceId,
                      label: project.displayName,
                    })),
                  ],
                  selected: [selectedProjectId ?? ''],
                  onChange: (values) => setSelectedProjectId(values[0] || null),
                  description:
                    'Used only when you choose Add reference on a record. This does not filter records.',
                }}
              />
            </section>
          ) : null}
        </div>
      </PortalMenu>
    </div>
  );
}

export interface OrganizationRegistryFilters {
  projectIds?: string[];
  kinds?: string[];
  nameLike?: string;
  registryIdLike?: string;
  includeArchived?: boolean;
}

export function OrganizationRegistryTable({
  scope,
  organization,
  registry,
  search,
  loading,
  error,
  project,
  filters,
  compact = false,
  placementBusyId = null,
  onAddProjectPlacement,
  onRemoveProjectPlacement,
  selectedEntityId = null,
  onSelectRecord,
  onOpenRecord,
}: {
  scope: Exclude<RegistryScope, 'local'>;
  organization: WorkspaceSyncOrganizationSummary | null;
  registry: OrganizationRegistryView | null;
  search: string;
  loading: boolean;
  error: string | null;
  project: RegistryProjectBinding | null;
  filters?: OrganizationRegistryFilters;
  compact?: boolean;
  placementBusyId?: string | null;
  onAddProjectPlacement?: (record: OrganizationRegistryRecord) => void;
  onRemoveProjectPlacement?: (placement: OrganizationRegistryPlacement) => void;
  selectedEntityId?: string | null;
  onSelectRecord?: (record: OrganizationRegistryRecord) => void;
  onOpenRecord?: (record: OrganizationRegistryRecord) => void;
}) {
  if (loading && !registry) {
    return <RegistryScopeMessage>Synchronizing the organization Registry…</RegistryScopeMessage>;
  }
  if (error && !registry) {
    return (
      <RegistryScopeMessage tone="error">
        {toUserMessage(error, 'operation.failed')}
      </RegistryScopeMessage>
    );
  }
  if (!organization) {
    return (
      <RegistryScopeMessage>Select an organization to view its Registry.</RegistryScopeMessage>
    );
  }
  if (scope === 'project' && !project) {
    return (
      <RegistryScopeMessage>Choose a project to filter registered records.</RegistryScopeMessage>
    );
  }
  if (scope === 'project' && project?.ownerOrgId !== organization.orgId) {
    return (
      <RegistryScopeMessage>
        This project belongs to a different organization. Select that organization to view its
        placements.
      </RegistryScopeMessage>
    );
  }
  if (!registry) {
    return (
      <RegistryScopeMessage>The organization Registry is not configured yet.</RegistryScopeMessage>
    );
  }

  const placements = registry.placements.flatMap(parsePlacement);
  const placementsByEntity = new Map<string, OrganizationRegistryPlacement[]>();
  for (const placement of placements) {
    const existing = placementsByEntity.get(placement.entityId) ?? [];
    existing.push(placement);
    placementsByEntity.set(placement.entityId, existing);
  }
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const records = organizationRegistryRecords(registry, scope, project, search, filters);

  if (records.length === 0) {
    const label = normalizedSearch
      ? 'No canonical records match this search.'
      : registry.entities.length > 0
        ? 'No records match these filters.'
        : scope === 'project'
          ? 'No registered records have this home project or an accessible reference here.'
          : 'No canonical records exist in this organization Registry.';
    return <RegistryScopeMessage>{label}</RegistryScopeMessage>;
  }

  return (
    <div data-testid="organization-registry-scope-table" className="min-h-0 flex-1 overflow-auto">
      <div className="sticky top-0 z-10 grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-b-2 border-border bg-bg-muted px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-fg-muted">
        <span>
          {scope === 'project'
            ? `Project · ${project?.displayName}`
            : `Organization · ${organization.displayName}`}
        </span>
        <span>{records.length} records</span>
      </div>
      <ul className="divide-y divide-border">
        {records.map((record) => {
          const allPlacements = placementsByEntity.get(record.id) ?? [];
          const currentProjectPlacements = project
            ? allPlacements.filter(
                (placement) => placement.workspaceId === project.remoteWorkspaceId
              )
            : [];
          const visiblePlacements =
            scope === 'project'
              ? allPlacements.filter(
                  (placement) => placement.workspaceId === project?.remoteWorkspaceId
                )
              : allPlacements;
          return (
            <li
              key={record.id}
              data-testid={`organization-registry-scope-row-${record.id}`}
              tabIndex={onSelectRecord ? 0 : undefined}
              aria-label={`${record.name} Details`}
              aria-current={selectedEntityId === record.id ? 'true' : undefined}
              onClick={() => onSelectRecord?.(record)}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelectRecord?.(record);
                }
              }}
              className={`px-4 py-3 text-xs outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent ${selectedEntityId === record.id ? 'bg-accent/5' : 'hover:bg-bg-subtle'} ${record.archived ? 'opacity-55' : ''}`}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-medium text-fg" title={record.name}>
                      {record.name}
                    </span>
                    {record.archived ? (
                      <span className="rounded-full bg-bg-muted px-1.5 py-0.5 text-[10px] text-fg-muted">
                        Archived
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-[11px] text-fg-muted">
                    {scope === 'project'
                      ? `Project · ${project?.displayName}`
                      : `Organization · ${organization.displayName}`}{' '}
                    · {record.kind}
                    {record.revision === null ? '' : ` · revision ${record.revision}`}
                  </p>
                  {!compact &&
                  project?.ownerOrgId === organization.orgId &&
                  currentProjectPlacements.length === 0 &&
                  !record.archived &&
                  onAddProjectPlacement ? (
                    <button
                      type="button"
                      disabled={placementBusyId !== null}
                      onClick={(event) => {
                        event.stopPropagation();
                        onAddProjectPlacement(record);
                      }}
                      className="mt-2 rounded border border-border px-2 py-1 text-[11px] font-medium text-accent hover:bg-accent/5 disabled:opacity-50"
                    >
                      {placementBusyId === record.id
                        ? 'Placing…'
                        : `Add reference in ${project.displayName}`}
                    </button>
                  ) : null}
                </div>
                <div className="flex-shrink-0 text-right">
                  {onOpenRecord ? (
                    <button
                      type="button"
                      aria-label={`Open ${record.name}`}
                      data-testid={`organization-registry-open-${record.id}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onOpenRecord(record);
                      }}
                      className="mb-1 rounded border border-border px-2 py-1 text-[11px] font-medium text-fg hover:bg-bg-muted"
                    >
                      Open
                    </button>
                  ) : null}
                  <p className="font-mono text-[11px] font-semibold text-accent">
                    {record.registryId}
                  </p>
                  <p className="mt-1 text-[10px] text-fg-subtle">
                    {allPlacements.length}{' '}
                    {allPlacements.length === 1 ? 'project reference' : 'project references'}
                  </p>
                </div>
              </div>
              {!compact && visiblePlacements.length > 0 ? (
                <ul className="mt-2 space-y-1 border-l-2 border-border pl-2 text-[11px] text-fg-subtle">
                  {visiblePlacements.map((placement) => (
                    <li key={placement.id} className="flex min-w-0 items-center gap-2">
                      <span className="font-mono">{shortIdentifier(placement.workspaceId)}</span>
                      <span className="min-w-0 flex-1 truncate">
                        {placement.path
                          ? placement.path
                          : placement.resourceId
                            ? `Resource ${shortIdentifier(placement.resourceId)}`
                            : 'Project-level placement'}
                      </span>
                      {project?.ownerOrgId === organization.orgId &&
                      placement.workspaceId === project.remoteWorkspaceId &&
                      onRemoveProjectPlacement ? (
                        <button
                          type="button"
                          disabled={placementBusyId !== null}
                          onClick={(event) => {
                            event.stopPropagation();
                            onRemoveProjectPlacement(placement);
                          }}
                          className="flex-shrink-0 text-[11px] font-medium text-error hover:underline disabled:opacity-50"
                        >
                          {placementBusyId === placement.id
                            ? 'Removing…'
                            : `Remove reference from ${project.displayName}`}
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
      {error ? (
        <p className="border-t border-warning/40 bg-warning/5 px-4 py-2 text-xs text-warning">
          Showing the last synchronized copy. {toUserMessage(error, 'operation.failed')}
        </p>
      ) : null}
    </div>
  );
}

function RegistryScopeMessage({
  children,
  tone = 'muted',
}: {
  children: string;
  tone?: 'muted' | 'error';
}) {
  return (
    <div
      data-testid="organization-registry-scope-message"
      className={`flex min-h-0 flex-1 items-center justify-center px-6 py-12 text-center text-sm ${
        tone === 'error' ? 'text-error' : 'text-fg-muted'
      }`}
    >
      <p className="max-w-lg">{children}</p>
    </div>
  );
}

export function organizationRegistryRecords(
  registry: OrganizationRegistryView,
  scope: Exclude<RegistryScope, 'local'>,
  project: RegistryProjectBinding | null,
  search: string,
  filters?: OrganizationRegistryFilters
): OrganizationRegistryRecord[] {
  if (registry.state.status === 'access_revoked') return [];
  if (scope === 'project' && (!project || project.ownerOrgId !== registry.orgId)) return [];
  const referenced = new Set(
    registry.placements
      .flatMap(parsePlacement)
      .filter((placement) => placement.workspaceId === project?.remoteWorkspaceId)
      .map((placement) => placement.entityId)
  );
  const normalized = search.trim().toLocaleLowerCase();
  const name = filters?.nameLike?.trim().toLocaleLowerCase();
  const registryId = filters?.registryIdLike?.trim().toLocaleLowerCase();
  const projectIds = new Set(filters?.projectIds ?? []);
  const projectReferences = new Set(
    registry.placements
      .flatMap(parsePlacement)
      .filter((placement) => projectIds.has(placement.workspaceId))
      .map((placement) => placement.entityId)
  );
  return registry.entities
    .flatMap(parseRecord)
    .filter(
      (record) =>
        (scope !== 'project' ||
          record.homeWorkspaceId === project?.remoteWorkspaceId ||
          referenced.has(record.id)) &&
        (projectIds.size === 0 ||
          (record.homeWorkspaceId !== null && projectIds.has(record.homeWorkspaceId)) ||
          projectReferences.has(record.id)) &&
        (!filters?.kinds?.length || filters.kinds.includes(record.kind)) &&
        (filters?.includeArchived !== false || !record.archived) &&
        (!name || record.name.toLocaleLowerCase().includes(name)) &&
        (!registryId || record.registryId.toLocaleLowerCase().includes(registryId)) &&
        (!normalized || record.searchableText.includes(normalized))
    );
}

function parseRecord(raw: Record<string, unknown>): OrganizationRegistryRecord[] {
  if (typeof raw.id !== 'string' || typeof raw.name !== 'string') return [];
  const registryId = typeof raw.registryId === 'string' ? raw.registryId : 'ID pending';
  const kind =
    typeof raw.kind === 'string'
      ? raw.kind
      : typeof raw.entityKind === 'string'
        ? raw.entityKind
        : 'record';
  const revision = typeof raw.revision === 'number' ? raw.revision : null;
  return [
    {
      id: raw.id,
      homeWorkspaceId: typeof raw.homeWorkspaceId === 'string' ? raw.homeWorkspaceId : null,
      registryId,
      name: raw.name,
      kind,
      revision,
      archived: typeof raw.archivedAt === 'string' || typeof raw.archivedAt === 'number',
      searchableText:
        `${registryId}\n${raw.name}\n${kind}\n${safeJson(raw.fields)}`.toLocaleLowerCase(),
      raw,
    },
  ];
}

function parsePlacement(raw: Record<string, unknown>): OrganizationRegistryPlacement[] {
  if (
    typeof raw.id !== 'string' ||
    typeof raw.entityId !== 'string' ||
    typeof raw.workspaceId !== 'string'
  ) {
    return [];
  }
  return [
    {
      id: raw.id,
      entityId: raw.entityId,
      workspaceId: raw.workspaceId,
      path: typeof raw.path === 'string' ? raw.path : null,
      resourceId: typeof raw.resourceId === 'string' ? raw.resourceId : null,
    },
  ];
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '';
  }
}

function shortIdentifier(value: string): string {
  if (value.length <= 12) return value;
  return `${value.slice(0, 8)}…`;
}

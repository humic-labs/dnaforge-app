import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DBEntityReference } from '../db/entity-references';
import {
  openEntityNavigationTarget,
  referenceNavigationLinks,
  resolveEntityNavigationTarget,
} from './entity-navigation';

const state = vi.hoisted(() => ({
  folders: [{ name: 'Owner', path: '/owner', addedAt: 1 }],
  owners: [] as Array<{
    id: number;
    path: string;
    repo_uuid: string | null;
    archived_at: number | null;
    trashed_at: number | null;
  }>,
  reference: vi.fn(),
  scope: vi.fn(),
  select: vi.fn(),
  catalog: vi.fn(),
  destination: vi.fn(),
  registry: vi.fn(),
  mount: vi.fn(),
  present: vi.fn(),
  primer: vi.fn(),
  canonical: vi.fn(),
  scheme: vi.fn(),
  workQuery: vi.fn(),
  workRead: vi.fn(),
  openWork: vi.fn(),
}));
vi.mock('../db/entity-references', () => ({
  getEntityReference: state.reference,
  prepareEntityReferenceRow: vi.fn(),
}));
vi.mock('../db/workspace-catalog', () => ({
  resolveWorkspaceScope: state.scope,
  getCatalogEntityForWorkspaceRoot: state.catalog,
}));
vi.mock('../platform', () => ({
  platform: () => ({
    db: { select: state.select },
    entityNavigation: { getScheme: state.scheme },
    lims: { queryEntities: state.registry },
    workTasks: { query: state.workQuery, read: state.workRead },
  }),
}));
vi.mock('../features/work/public/work', () => ({ openWorkTask: state.openWork }));
vi.mock('../stores/workspaceStore', () => ({
  useWorkspaceStore: { getState: () => ({ folders: state.folders }) },
}));
vi.mock('../features/workspace-loader/open-workspace-from-source', () => ({
  openWorkspaceFromSource: state.mount,
}));
vi.mock('../features/primers/public/primer-references', () => ({
  resolveCanonicalPrimerReference: state.primer,
  getCanonicalOligoEntity: state.canonical,
}));
vi.mock('../features/ai/references/navigate', () => ({ presentResolvedReference: state.present }));
vi.mock('./native-catalog-destination', () => ({
  resolveExactNativeCatalogDestination: state.destination,
}));

const reference: DBEntityReference = {
  id: 'exact-selection',
  entity_type: 'sequence_region',
  display_label: '100–200',
  locator: 'entity://sequence/stable-sequence',
  data: JSON.stringify({ documentId: 'stable-sequence' }),
  deep_link_params: JSON.stringify({ start: 100, end: 200 }),
  source: 'ai',
  status: 'created',
  workspace_scope: 'owner-id',
  workspace_root_path: '/owner',
  created_at: 1,
  updated_at: 1,
};

beforeEach(() => {
  vi.resetAllMocks();
  state.folders = [{ name: 'Owner', path: '/owner', addedAt: 1 }];
  state.reference.mockResolvedValue(reference);
  state.scope.mockImplementation(async (root: string) => (root === '/owner' ? 'owner-id' : null));
  state.owners = [
    { id: 7, path: '/owner', repo_uuid: 'owner-id', archived_at: null, trashed_at: null },
  ];
  state.select.mockImplementation(async (sql: string, params: string[] = []) =>
    sql.includes('WHERE path')
      ? state.owners.filter((owner) => owner.path === params[0])
      : sql.includes('WHERE repo_uuid')
        ? state.owners.filter((owner) => owner.repo_uuid === params[0])
        : state.owners
  );
  state.registry.mockResolvedValue([]);
  state.workQuery.mockResolvedValue({ projects: [] });
  state.workRead.mockResolvedValue(null);
  state.openWork.mockReturnValue(true);
  state.scheme.mockResolvedValue('dnaforge');
  state.present.mockResolvedValue({ entityId: 'stable-sequence' });
  state.mount.mockImplementation(async (source: { path: string }) => {
    state.folders.push({ name: 'Owner', path: source.path, addedAt: 1 });
    return { superseded: false };
  });
});

describe('shared entity navigation', () => {
  it('resolves a task by its scientific project scope and refuses an inaccessible owner', async () => {
    state.workQuery.mockResolvedValue({ projects: [{ id: 'scientific-scope', root: '/owner' }] });
    state.workRead.mockResolvedValue({ id: 'task-one' });
    await openEntityNavigationTarget({
      entityId: 'work-task:task-one',
      projectId: 'scientific-scope',
    });
    expect(state.workRead).toHaveBeenCalledWith({ workspaceRoot: '/owner', taskId: 'task-one' });
    expect(state.openWork).toHaveBeenCalledWith({ workspaceRoot: '/owner', taskId: 'task-one' });
    state.workRead.mockClear();
    await expect(
      openEntityNavigationTarget({ entityId: 'work-task:task-one', projectId: 'other-scope' })
    ).rejects.toThrow('unavailable');
    expect(state.workRead).not.toHaveBeenCalled();
  });
  it.each(['archived_at', 'trashed_at'] as const)(
    'refuses a saved selection whose owner has %s without mounting it',
    async (field) => {
      state.owners[0][field] = 3;
      await expect(
        openEntityNavigationTarget({
          entityId: 'stable-sequence',
          projectId: 'owner-id',
          referenceId: 'exact-selection',
        })
      ).rejects.toThrow(/owning project is unavailable/);
      expect(state.mount).not.toHaveBeenCalled();
      expect(state.present).not.toHaveBeenCalled();
      expect(state.primer).not.toHaveBeenCalled();
    }
  );

  it('resolves a durable project fallback scope without inventing a repository UUID', async () => {
    state.owners[0].repo_uuid = null;
    state.catalog.mockResolvedValue({ id: 'stable-assembly', type: 'design', status: 'active' });
    state.destination.mockResolvedValue({ entityId: 'stable-assembly' });
    expect(
      await resolveEntityNavigationTarget({ entityId: 'stable-assembly', projectId: 'ws7' })
    ).toEqual({ kind: 'catalog', entityId: 'stable-assembly', root: '/owner' });
  });

  it('returns a real external link retaining the primary identity, owner and exact saved interval', async () => {
    const link = await referenceNavigationLinks(reference);
    expect(link).toMatchObject({
      target: {
        entityId: 'stable-sequence',
        projectId: 'owner-id',
        referenceId: 'exact-selection',
      },
    });
    expect(link.externalUrl).toContain('dnaforge://entity/open?');
    expect(state.mount).not.toHaveBeenCalled();
    expect(state.present).not.toHaveBeenCalled();
  });

  it('returns the scheme registered by this app channel', async () => {
    state.scheme.mockResolvedValue('dnaforge-dev');
    expect((await referenceNavigationLinks(reference)).externalUrl).toMatch(
      /^dnaforge-dev:\/\/entity\/open\?/
    );
  });

  it('presents the same authoritative saved reference through the external entry point', async () => {
    await openEntityNavigationTarget({
      entityId: 'stable-sequence',
      projectId: 'owner-id',
      referenceId: 'exact-selection',
    });
    expect(state.present).toHaveBeenCalledWith(reference, undefined);
    expect(state.mount).not.toHaveBeenCalled();
  });

  it('mounts the actual owner through the normal project loader after a cold start', async () => {
    state.folders = [];
    await openEntityNavigationTarget({
      entityId: 'stable-sequence',
      projectId: 'owner-id',
      referenceId: 'exact-selection',
    });
    expect(state.mount).toHaveBeenCalledWith(
      { kind: 'local-folder', path: '/owner' },
      { inPlace: true, makeCurrent: true }
    );
    expect(state.present).toHaveBeenCalledWith(reference, undefined);
  });

  it.each([
    { entityId: 'same-name-other-entity', projectId: 'owner-id', referenceId: 'exact-selection' },
    { entityId: 'stable-sequence', projectId: 'other-owner', referenceId: 'exact-selection' },
    { entityId: 'stable-sequence', referenceId: 'exact-selection' },
  ])('refuses a mismatched identity or owner without presentation: %j', async (target) => {
    await expect(openEntityNavigationTarget(target)).rejects.toThrow(
      /different entity|owning project/
    );
    expect(state.present).not.toHaveBeenCalled();
    expect(state.mount).not.toHaveBeenCalled();
  });

  it('refuses a missing saved selection without falling back to a name', async () => {
    state.reference.mockResolvedValue(null);
    await expect(
      openEntityNavigationTarget({
        entityId: 'stable-sequence',
        projectId: 'owner-id',
        referenceId: 'missing',
      })
    ).rejects.toThrow(/selection is unavailable/);
    expect(state.catalog).not.toHaveBeenCalled();
  });

  it('resolves a raw stable identity to its current catalog destination without opening a view', async () => {
    state.catalog.mockResolvedValue({ id: 'stable-assembly', type: 'design', status: 'active' });
    state.destination.mockResolvedValue({ entityId: 'stable-assembly' });
    expect(
      await resolveEntityNavigationTarget({ entityId: 'stable-assembly', projectId: 'owner-id' })
    ).toEqual({ kind: 'catalog', entityId: 'stable-assembly', root: '/owner' });
    expect(state.destination).toHaveBeenCalledWith({
      entityId: 'stable-assembly',
      workspaceRoot: '/owner',
    });
    expect(state.mount).not.toHaveBeenCalled();
    expect(state.present).not.toHaveBeenCalled();
  });

  it('does not guess a project when its stable identity is missing locally', async () => {
    await expect(
      resolveEntityNavigationTarget({ entityId: 'stable-sequence', projectId: 'unknown-owner' })
    ).rejects.toThrow(/owning project is unavailable/);
    expect(state.catalog).not.toHaveBeenCalled();
  });

  it('keeps installation-global Registry identity separate from project ownership', async () => {
    state.registry.mockResolvedValue([{ id: 'global-entity', tombstone: false, archivedAt: null }]);
    expect(await resolveEntityNavigationTarget({ entityId: 'global-entity' })).toEqual({
      kind: 'registry',
      entityId: 'global-entity',
    });
    expect(state.select).not.toHaveBeenCalled();
  });

  it('refuses a historical phantom primer reference before advertising or opening it', async () => {
    state.reference.mockResolvedValue({
      ...reference,
      entity_type: 'primer',
      locator: 'entity://primer/fake',
      data: null,
    });
    state.primer.mockRejectedValue(new Error('The reference requires an existing canonical oligo'));
    await expect(
      openEntityNavigationTarget({
        entityId: 'fake',
        projectId: 'owner-id',
        referenceId: reference.id,
      })
    ).rejects.toThrow(/existing canonical oligo/);
    expect(state.present).not.toHaveBeenCalled();
  });

  it('does not advertise a legacy primer with unqualified ownership', async () => {
    expect(
      await referenceNavigationLinks({
        ...reference,
        entity_type: 'primer',
        workspace_root_path: null,
      })
    ).toEqual({ externalUrl: null, shellCommand: null });
  });

  it('keeps an explicit global oligo reference in the Registry when an artifact owner is mounted', async () => {
    const global = {
      ...reference,
      entity_type: 'primer',
      locator: 'entity://primer/global-oligo',
      workspace_root_path: null,
      workspace_scope: null,
      deep_link_params: null,
      data: JSON.stringify({ registryEntityId: 'global-oligo', localOnly: true }),
    };
    state.reference.mockResolvedValue(global);
    state.canonical.mockResolvedValue({ id: 'global-oligo' });
    const resolved = await resolveEntityNavigationTarget({
      entityId: 'global-oligo',
      referenceId: global.id,
    });
    expect(resolved).toMatchObject({ kind: 'reference', reference: global });
    expect(state.primer).not.toHaveBeenCalled();
  });

  it('does not advertise an external project link when its ownership is unqualified', async () => {
    state.owners = [];
    expect(await referenceNavigationLinks(reference)).toEqual({
      externalUrl: null,
      shellCommand: null,
    });
  });
});

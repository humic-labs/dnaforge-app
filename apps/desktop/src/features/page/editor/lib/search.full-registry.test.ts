import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  namedEntityTypePresentation,
  resolveNamedEntityType,
} from '@waypoint/scientific-artifacts/shared/entity-types';
import type { EntityDescriptor } from '../../../../shared/entity-discovery';

const mocks = vi.hoisted(() => ({ search: vi.fn() }));
vi.mock('../../../../platform', () => ({
  platform: () => ({ entityDiscovery: { search: mocks.search } }),
}));
import { groupSearchResults, searchEntities } from './search';

function entity(
  id: string,
  name: string,
  type: EntityDescriptor['type'],
  extra: Partial<EntityDescriptor> = {}
): EntityDescriptor {
  const namedTypeKey = resolveNamedEntityType({
    type,
    registryKind: extra.registryKind,
  });
  const { iconKind, kindLabel } = namedEntityTypePresentation(namedTypeKey, null, null);
  return {
    id,
    name,
    type,
    source: type === 'registry' ? 'registry' : 'project',
    namedTypeKey,
    iconKind,
    kindLabel,
    path: null,
    contentHash: null,
    objectUuid: null,
    registryKind: null,
    registryId: null,
    schemaId: null,
    projectId: null,
    projectRoot: null,
    projectName: null,
    archived: false,
    ...extra,
  };
}
function page(items: EntityDescriptor[], nextCursor: string | null = null) {
  return {
    items,
    nextCursor,
    generation: 'catalog-generation',
    coverage: { catalog: 20, registry: 30, primers: 4, excluded: 2 },
  };
}

beforeEach(() => {
  mocks.search.mockReset().mockResolvedValue(page([]));
});

describe('notebook search consumes one canonical discovery owner', () => {
  it('preserves every returned Registry kind, canonical ID and registration label', async () => {
    const items = [
      entity('ent-strain', 'BL21(DE3)', 'registry', {
        registryKind: 'strain',
        registryId: 's000012',
        kindLabel: 'Strain',
      }),
      entity('ent-plasmid', 'pET-28a', 'registry', {
        registryKind: 'plasmid',
        registryId: 'p000003',
        kindLabel: 'Plasmid',
      }),
      entity('ent-guide', 'sgRNA-lacZ', 'registry', {
        registryKind: 'guide_rna',
        kindLabel: 'Guide RNA',
      }),
    ];
    mocks.search.mockResolvedValue(page(items));
    const results = await searchEntities('  BL21 ', '/ws/beta');
    expect(mocks.search).toHaveBeenCalledExactlyOnceWith({
      query: '  BL21 ',
      preferredProjectRoot: '/ws/beta',
    });
    expect(results.registry).toEqual(items);
  });

  it('returns an unloaded native notebook with its canonical owning project', async () => {
    mocks.search.mockResolvedValue(
      page([
        entity('repo-gamma::native-note', 'Unloaded notebook', 'page', {
          kindLabel: 'Notebook',
          path: 'Native notebook',
          projectId: 'repo-gamma',
          projectRoot: '/ws/gamma',
          projectName: 'Gamma',
        }),
      ])
    );
    expect((await searchEntities('Unloaded', '/ws/beta')).pages).toEqual([
      expect.objectContaining({
        id: 'repo-gamma::native-note',
        type: 'page',
        projectId: 'repo-gamma',
        path: 'Native notebook',
      }),
    ]);
  });

  it('passes an empty browse query to the same owner without an artificial provider cap', async () => {
    await searchEntities('', '/ws/beta');
    expect(mocks.search).toHaveBeenCalledExactlyOnceWith({
      query: '',
      preferredProjectRoot: '/ws/beta',
    });
    expect(mocks.search.mock.lastCall?.[0]).not.toHaveProperty('limit');
  });

  it('keeps Registry notebooks linkable without using loaded pages as a second authority', async () => {
    const item = entity('registry-notebook', 'Registry notebook', 'registry', {
      registryKind: 'notebook',
      kindLabel: 'Notebook',
    });
    mocks.search.mockResolvedValue(page([item]));
    expect((await searchEntities('notebook')).registry).toEqual([item]);
  });

  it('searches all accessible projects when the notebook has no owning project', async () => {
    await searchEntities('MG', null);
    expect(mocks.search).toHaveBeenCalledExactlyOnceWith({ query: 'MG' });
  });

  it('treats the notebook project as ranking context rather than a restrictive scope', async () => {
    await searchEntities('pUC', '/ws/beta');
    expect(mocks.search).toHaveBeenCalledWith({ query: 'pUC', preferredProjectRoot: '/ws/beta' });
    expect(mocks.search.mock.lastCall?.[0]).not.toHaveProperty('scope');
  });

  it('preserves portable paths, hashes and exact owners across project result types', async () => {
    const items = [
      entity('ent-seq', 'pAAV-hSyn', 'sequence', {
        path: 'vectors/pAAV.gb',
        projectId: 'repo-alpha',
        projectName: 'Alpha',
      }),
      entity('ent-structure', '1ABC', 'structure', {
        path: 'structures/1ABC.cif',
        contentHash: 'sha256:abc',
        objectUuid: 'uuid-1',
        projectId: 'repo-gamma',
        projectName: 'Gamma',
      }),
      entity('ent-protocol', 'Miniprep', 'protocol', {
        path: 'protocols/miniprep.dnaforge-protocol.json',
        projectId: 'repo-beta',
      }),
    ];
    mocks.search.mockResolvedValue(page(items));
    const results = await searchEntities('a', '/ws/beta');
    expect(results.items).toEqual(items);
    expect(results.sequences).toEqual([items[0]]);
    expect(results.project).toEqual(items.slice(1));
  });

  it('exposes the real continuation and passes the same query, scope and filter to the next page', async () => {
    mocks.search.mockResolvedValue(page([entity('one', 'pUC19', 'sequence')], 'opaque-next'));
    const scope = { projectId: 'beta', includeArchived: true };
    const filter = { category: 'sequences' as const };
    const first = await searchEntities('pUC', '/ws/beta', filter, { scope, limit: 17 });
    expect(first.nextCursor).toBe('opaque-next');
    expect(first.generation).toBe('catalog-generation');
    await searchEntities('pUC', '/ws/beta', filter, {
      scope,
      limit: 17,
      cursor: first.nextCursor!,
    });
    expect(mocks.search).toHaveBeenLastCalledWith({
      query: 'pUC',
      preferredProjectRoot: '/ws/beta',
      filter,
      scope,
      limit: 17,
      cursor: 'opaque-next',
    });
  });

  it('never strips workspace prefixes or deduplicates distinct returned identities', async () => {
    const items = [
      entity('repo-a::same', 'pUC19', 'sequence'),
      entity('repo-b::same', 'pUC19', 'registry', { registryKind: 'sequence' }),
    ];
    mocks.search.mockResolvedValue(page(items));
    expect((await searchEntities('pUC19')).items.map((item) => item.id)).toEqual([
      'repo-a::same',
      'repo-b::same',
    ]);
  });

  it('groups adjacent kinds without rearranging the native ranking', async () => {
    const items = [
      entity('strain-one', 'BL21', 'registry', { registryKind: 'strain', kindLabel: 'Strain' }),
      entity('strain-two', 'BL21-AI', 'registry', { registryKind: 'strain', kindLabel: 'Strain' }),
      entity('notes', 'BL21 notes', 'page', { kindLabel: 'Notebook' }),
      entity('plasmid', 'pBL21', 'registry', { registryKind: 'plasmid', kindLabel: 'Plasmid' }),
    ];
    mocks.search.mockResolvedValue(page(items));
    const groups = groupSearchResults(await searchEntities('bl21'), 'bl21');
    expect(groups.map((group) => group.label)).toEqual(['Strain', 'Notebook', 'Plasmid']);
    expect(groups.flatMap((group) => group.items)).toEqual(items);
  });

  it('forwards exact Registry-ID searches without converting them into a name lookup', async () => {
    const item = entity('ent-a', 'Cas9 donor', 'registry', {
      registryKind: 'plasmid',
      registryId: 'p000044',
    });
    mocks.search.mockResolvedValue(page([item]));
    expect((await searchEntities('P000044')).items[0].id).toBe('ent-a');
    expect(mocks.search).toHaveBeenCalledWith({ query: 'P000044' });
  });

  it('propagates discovery errors so the UI can distinguish failure from no matches', async () => {
    mocks.search.mockRejectedValue(new Error('ENTITY_DISCOVERY_REFRESH_REQUIRED: changed'));
    await expect(searchEntities('pUC')).rejects.toThrow('ENTITY_DISCOVERY_REFRESH_REQUIRED');
  });
});

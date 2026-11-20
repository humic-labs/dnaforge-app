import { beforeEach, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ types: vi.fn(), search: vi.fn() }));
vi.mock('../../../../platform', () => ({ platform: () => ({ entityDiscovery: native }) }));

import { discoverEntityLinkTypes, matchingEntityLinkCategories, searchEntities } from './search';

const facets = [
  {
    key: 'type:notebook',
    label: 'Notebook',
    terms: ['notebook'],
    filter: { namedTypeKey: 'type:notebook' },
    iconKind: 'notebook',
    kind: 'type',
    count: 2,
  },
  {
    key: 'type:molecular-document',
    label: 'Molecular documents',
    terms: ['molecular-document'],
    filter: { namedTypeKey: 'type:molecular-document' },
    iconKind: 'molecular-document',
    kind: 'type',
    count: 1,
  },
  {
    key: 'schema:specimen',
    label: 'Patient specimen',
    terms: ['specimen'],
    filter: { namedTypeKey: 'schema:specimen' },
    iconKind: 'record',
    kind: 'type',
    count: 3,
  },
  {
    key: 'role:primer',
    label: 'Primer',
    terms: ['primer', 'primers'],
    filter: { role: 'primer' },
    iconKind: 'primer',
    kind: 'shortcut',
    count: 1,
  },
];

beforeEach(() => {
  native.types.mockReset().mockResolvedValue({ items: facets });
  native.search.mockReset().mockResolvedValue({
    items: [],
    nextCursor: null,
    generation: 'named-types-fixture',
    coverage: { catalog: 0, registry: 0, primers: 0, excluded: 0 },
  });
});

it('uses native named types as browse entries and keeps role shortcuts search-only without injecting families', async () => {
  const scope = { projectId: 'repo-a', includeArchived: true };
  const result = await discoverEntityLinkTypes(scope);
  expect(native.types).toHaveBeenCalledExactlyOnceWith({ scope });
  expect(result.map((item) => ({ key: item.key, browse: item.browse }))).toEqual([
    { key: 'type:notebook', browse: true },
    { key: 'type:molecular-document', browse: true },
    { key: 'schema:specimen', browse: true },
    { key: 'role:primer', browse: false },
  ]);
  expect(result.map((item) => item.label)).toEqual(facets.map((item) => item.label));
  expect(result.map((item) => item.filter)).toEqual(facets.map((item) => item.filter));
});

it('returns no invented browse families when the native inventory has no populated types', async () => {
  native.types.mockResolvedValue({ items: [] });
  expect(await discoverEntityLinkTypes()).toEqual([]);
});

it.each([
  ['notebooks', 'type:notebook'],
  ['Molecular documents', 'type:molecular-document'],
  ['Patient specimens', 'schema:specimen'],
  ['primers', 'role:primer'],
])(
  'matches the displayed name or plural %s without changing its exact filter',
  async (query, key) => {
    const result = await discoverEntityLinkTypes();
    expect(matchingEntityLinkCategories(result, query)).toEqual([
      expect.objectContaining({ key, filter: facets.find((facet) => facet.key === key)!.filter }),
    ]);
  }
);

it('forwards the selected named type unchanged through search and continuation', async () => {
  const filter = { namedTypeKey: 'schema:specimen' };
  const scope = { projectId: 'repo-a' };
  await searchEntities('sample', '/fixtures/alpha', filter, {
    scope,
    cursor: 'opaque-cursor',
    limit: 1,
  });
  expect(native.search).toHaveBeenCalledExactlyOnceWith({
    query: 'sample',
    preferredProjectRoot: '/fixtures/alpha',
    filter,
    scope,
    cursor: 'opaque-cursor',
    limit: 1,
  });
});

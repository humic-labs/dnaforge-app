import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  views: [
    { entityId: 'saved-page', viewedAt: 20 },
    { entityId: 'record', viewedAt: 10 },
  ],
  resolve: vi.fn(),
}));
vi.mock('../../../../services/recent-entity-views', () => ({
  useEntityViewHistory: { getState: () => ({ views: mocks.views }) },
}));
vi.mock('../../../../platform', () => ({
  platform: () => ({ entityDiscovery: { resolve: mocks.resolve } }),
}));
import { getRecentlyViewedEntityGroups } from './search';
const nativePage = {
  id: 'saved-page',
  type: 'page',
  name: 'Fresh notebook name',
  path: 'Native notebook',
  projectId: 'project',
  projectName: 'Project',
};
const registryRecord = {
  id: 'record',
  type: 'registry',
  name: 'Fresh record name',
  registryKind: 'notebook',
};
function response(page = true, record = true) {
  return {
    items: [
      page
        ? { id: 'saved-page', status: 'available', entity: nativePage }
        : { id: 'saved-page', status: 'unavailable' },
      record
        ? { id: 'record', status: 'available', entity: registryRecord }
        : { id: 'record', status: 'unavailable' },
    ],
  };
}
beforeEach(() => {
  mocks.resolve.mockReset().mockResolvedValue(response());
});

it('resolves current names and exact owners in viewing order, including metadata-only notebook records', async () => {
  const [group] = await getRecentlyViewedEntityGroups();
  expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith({ ids: ['saved-page', 'record'] });
  expect(group.items).toEqual([nativePage, registryRecord]);
});
it('omits unavailable native notebook packages instead of returning a broken recent link', async () => {
  mocks.resolve.mockResolvedValue(response(false));
  const [group] = await getRecentlyViewedEntityGroups();
  expect(group.items.map((entity) => entity.id)).toEqual(['record']);
});
it('retains canonical native notebook resolution rather than interpreting catalog storage hints in the renderer', async () => {
  const [group] = await getRecentlyViewedEntityGroups();
  expect(group.items[0]).toMatchObject({
    id: 'saved-page',
    type: 'page',
    path: 'Native notebook',
    projectId: 'project',
  });
});
it('omits archived and deleted targets reported unavailable by their owner', async () => {
  mocks.resolve.mockResolvedValue(response(false, false));
  expect(await getRecentlyViewedEntityGroups()).toEqual([]);
});
it('resolves a restored Registry record even without a native-file result', async () => {
  mocks.resolve.mockResolvedValue(response(false));
  const [group] = await getRecentlyViewedEntityGroups();
  expect(group.items).toEqual([registryRecord]);
});
it('passes the chosen scope to exact-ID resolution and filters only fresh display names', async () => {
  const scope = { projectId: 'project', includeArchived: true };
  const [group] = await getRecentlyViewedEntityGroups('NOTEBOOK', scope);
  expect(mocks.resolve).toHaveBeenCalledWith({ ids: ['saved-page', 'record'], scope });
  expect(group.items).toEqual([nativePage]);
});
it('does not turn an owner failure into an empty recent list', async () => {
  mocks.resolve.mockRejectedValue(new Error('Native owner unavailable'));
  await expect(getRecentlyViewedEntityGroups()).rejects.toThrow('Native owner unavailable');
});

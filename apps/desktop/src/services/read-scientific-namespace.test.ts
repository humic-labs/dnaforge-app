import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ catalog: vi.fn() }));
vi.mock('../platform', () => ({
  platform: () => ({ scientificObjects: { catalog: mocks.catalog } }),
}));
vi.mock('../utils/environment', () => ({
  isBrowserOnly: () => false,
  isHostedBrowserRuntime: () => false,
}));
vi.mock('../db/workspace-catalog', () => ({ resolveWorkspaceScope: async () => 'workspace:1' }));
import { readScientificNamespace } from './read-scientific-namespace';
beforeEach(() => vi.clearAllMocks());

it('treats an explicit empty head as unenrolled, while retaining captured metadata for an enrolled project', async () => {
  mocks.catalog.mockResolvedValueOnce({ workspace: 'workspace:1', head: null, entries: [] });
  expect(await readScientificNamespace('/w')).toBeNull();
  const accepted = {
    workspace: 'workspace:1',
    head: `wv_${'a'.repeat(64)}`,
    entries: [
      {
        resourceId: 'p',
        revisionId: `rr_${'b'.repeat(64)}`,
        path: 'p.primer.json',
        lastPath: 'p.primer.json',
        tombstone: false,
      },
    ],
  };
  mocks.catalog.mockResolvedValueOnce(accepted);
  expect(await readScientificNamespace('/w')).toEqual(accepted);
});

it('keeps a failed accepted-state read distinct from an unenrolled project', async () => {
  mocks.catalog.mockRejectedValueOnce(new Error('accepted database unavailable'));
  await expect(readScientificNamespace('/w')).rejects.toThrow('accepted database unavailable');
});

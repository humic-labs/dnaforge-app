import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ namespace: vi.fn(), read: vi.fn() }));
vi.mock('../platform', () => ({ platform: () => ({ scientificObjects: { read: mocks.read } }) }));
vi.mock('./read-scientific-namespace', () => ({ readScientificNamespace: mocks.namespace }));
import { readAcceptedScientificFile } from './read-accepted-scientific-file';

const entry = {
  resourceId: 'sequence',
  revisionId: `rr_${'b'.repeat(64)}`,
  path: 'imports/source/source.gb',
  lastPath: 'imports/source/source.gb',
  tombstone: false,
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.namespace.mockResolvedValue({
    workspace: 'workspace:1',
    head: `wv_${'a'.repeat(64)}`,
    entries: [entry],
  });
  mocks.read.mockResolvedValue({
    revisionId: entry.revisionId,
    representation: { format: 'genbank-v1', text: 'native' },
  });
});

it('pins the declared revision and returns its exact bounded native bytes and identity', async () => {
  await expect(readAcceptedScientificFile('/w', entry.path, 6)).resolves.toEqual({
    bytes: new TextEncoder().encode('native'),
    resourceId: entry.resourceId,
    workspaceScope: 'workspace:1',
  });
  expect(mocks.read).toHaveBeenCalledWith({
    workspaceRoot: '/w',
    request: {
      workspace: 'workspace:1',
      resourceId: entry.resourceId,
      revisionId: entry.revisionId,
    },
  });
});

it('uses null only for an unenrolled project or an undeclared path', async () => {
  mocks.namespace.mockResolvedValueOnce(null);
  expect(await readAcceptedScientificFile('/w', entry.path, 6)).toBeNull();
  expect(await readAcceptedScientificFile('/w', 'undeclared.gb', 6)).toBeNull();
  expect(mocks.read).not.toHaveBeenCalled();
});

it('refuses deleted files and failed namespace reads without a native-byte read', async () => {
  mocks.namespace.mockResolvedValueOnce({
    workspace: 'workspace:1',
    head: 'head',
    entries: [{ ...entry, path: null, tombstone: true }],
  });
  await expect(readAcceptedScientificFile('/w', entry.path, 6)).rejects.toThrow('deleted');
  mocks.namespace.mockRejectedValueOnce(Error('accepted namespace failed'));
  await expect(readAcceptedScientificFile('/w', entry.path, 6)).rejects.toThrow(
    'accepted namespace failed'
  );
  expect(mocks.read).not.toHaveBeenCalled();
});

it('refuses missing or wrong revision authority and native bytes beyond the captured bound', async () => {
  mocks.read.mockResolvedValueOnce(null);
  await expect(readAcceptedScientificFile('/w', entry.path, 6)).rejects.toThrow('unavailable');
  mocks.read.mockResolvedValueOnce({ revisionId: 'another', representation: { text: 'native' } });
  await expect(readAcceptedScientificFile('/w', entry.path, 6)).rejects.toThrow('unavailable');
  await expect(readAcceptedScientificFile('/w', entry.path, 5)).rejects.toThrow('changed size');
});

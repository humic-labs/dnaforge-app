import { beforeEach, describe, expect, it, vi } from 'vitest';
import { contentFingerprint } from '../../shared/content-fingerprint';

const mocks = vi.hoisted(() => ({
  dirtyIds: new Set<string>(),
  savePage: vi.fn(),
  fetchPage: vi.fn(),
}));
vi.mock('../../platform', () => ({ platform: () => ({ fs: { readTextFile: async () => '{}' } }) }));
vi.mock('../../db/workspace-catalog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/workspace-catalog')>()),
  getCatalogEntityForWorkspaceRoot: async () => ({
    type: 'notebook',
    status: 'active',
    workspace_id: 1,
  }),
  getCurrentCatalogFileForEntity: async () => ({
    file_kind: 'waypoint-notebook',
    workspace_id: 1,
    path: '/project/Protocol/.forge/notebook.json',
  }),
  resolveWorkspaceScope: async () => 'owner',
}));
vi.mock('../../db/entity-references', () => ({ getEntityReferencesByIds: async () => [] }));
vi.mock('../../db/entity-substrate/notebook-source-snapshot', () => ({
  readNotebookSourceSnapshot: async () => ({
    markdown: 'saved original',
    parsed: { title: 'Protocol', content: { type: 'doc', content: [] } },
    metadata: { provenance: [] },
  }),
}));
vi.mock('./store', () => ({ usePageStore: { getState: () => mocks } }));

import { updateAuthoredNotebook } from './notebook-authoring';

const request = {
  workspaceRoot: '/project',
  mountedRoots: ['/project'],
  notebookId: 'owner::notebook',
  expectedRevision: contentFingerprint('saved original'),
  mode: 'replace' as const,
  blocks: [{ type: 'paragraph' as const, content: [{ text: 'Agent replacement' }] }],
  operationId: 'trusted-operation',
};

describe('agent notebook write protection', () => {
  beforeEach(() => {
    mocks.dirtyIds.clear();
    vi.clearAllMocks();
  });

  it('preserves unsaved human edits without invoking the notebook writer', async () => {
    mocks.dirtyIds.add(request.notebookId);
    await expect(updateAuthoredNotebook(request)).rejects.toThrow('unsaved editor changes');
    expect(mocks.savePage).not.toHaveBeenCalled();
    expect(mocks.fetchPage).not.toHaveBeenCalled();
  });

  it('refuses a stale revision before invoking the notebook writer', async () => {
    await expect(
      updateAuthoredNotebook({ ...request, expectedRevision: 'old revision' })
    ).rejects.toThrow('revision changed');
    expect(mocks.savePage).not.toHaveBeenCalled();
    expect(mocks.fetchPage).not.toHaveBeenCalled();
  });
});

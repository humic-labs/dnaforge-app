import { beforeEach, describe, expect, it, vi } from 'vitest';
import { documentReadReason } from '../../shared/document-read-failure';
import { useCanvasStore } from '../canvas/store';
import { openWorkspaceDocument } from './open-workspace-document';

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  upsert: vi.fn(),
  catalog: vi.fn(),
  design: vi.fn(),
  beginNotebookReopen: vi.fn(() => null),
  confirmNotebookReopen: vi.fn(),
  dirtyIds: new Set<string>(),
}));
vi.mock('./notebook-workflow', () => ({
  beginNotebookReopen: mocks.beginNotebookReopen,
  confirmNotebookReopen: mocks.confirmNotebookReopen,
}));
vi.mock('../../services/workspace-artifact-open', () => ({
  withWorkspaceArtifactOpen: mocks.open,
}));
vi.mock('../../db/workspace-catalog', () => ({
  findWorkspaceRootForPath: () => '/workspace',
  getCatalogEntityForFilePath: mocks.catalog,
}));
vi.mock('./store', () => ({
  usePageStore: {
    getState: () => ({ upsertPageFromArtifact: mocks.upsert, dirtyIds: mocks.dirtyIds }),
  },
}));
vi.mock('../design/store', () => ({
  useDesignStore: { getState: () => ({ upsertDesignFromArtifact: mocks.design }) },
}));

describe('workspace document opening', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dirtyIds.clear();
    useCanvasStore.setState({
      panels: { main: { id: 'main', tabs: [], activeTabId: null } },
      layout: { type: 'panel', panelId: 'main' },
      focusedPanelId: 'main',
    });
  });
  const request = {
    target: { kind: 'file', path: '/workspace/Notes/.forge/notebook.json', tabType: 'page' },
    label: 'Notes',
  } as const;
  const resolved = {
    artifact: { kind: 'notebook', id: 'portable-id', title: 'Notes', content: { type: 'doc' } },
    entity: { id: 'workspace::portable-id' },
  };

  it('projects the scoped identity and presents before the mutation lease ends', async () => {
    let leaseActive = false;
    mocks.upsert.mockImplementation(async (input) => {
      expect(leaseActive).toBe(true);
      expect(input).toMatchObject({ id: 'workspace::portable-id', mutationToken: 'lease' });
    });
    mocks.open.mockImplementation(async ({ consume }) => {
      leaseActive = true;
      const result = await consume(resolved, 'lease');
      expect(useCanvasStore.getState().panels.main.tabs).toHaveLength(1);
      leaseActive = false;
      return result;
    });
    expect(await openWorkspaceDocument(request)).toMatchObject({
      status: 'presented',
      tabType: 'page',
    });
    expect(useCanvasStore.getState().panels.main.tabs[0].entityId).toBe('workspace::portable-id');
  });

  it('does not publish a late tab if cancellation arrives during projection', async () => {
    const controller = new AbortController();
    mocks.upsert.mockImplementation(async () => controller.abort());
    mocks.open.mockImplementation(({ consume }) => consume(resolved, 'lease'));
    expect(await openWorkspaceDocument({ ...request, signal: controller.signal })).toMatchObject({
      status: 'cancelled',
    });
    expect(useCanvasStore.getState().panels.main.tabs).toEqual([]);
  });

  it.each(['page', 'design'] as const)(
    'does not present a %s tab from a catalog hint after the normal reader fails',
    async (tabType) => {
      const path = tabType === 'page' ? request.target.path : '/workspace/Sketch.wpdesign.json';
      mocks.open.mockRejectedValue(new Error('Unclassified reader failure'));
      mocks.catalog.mockResolvedValue({
        type: tabType === 'page' ? 'notebook' : 'design',
        id: 'workspace::saved',
        name: 'Saved',
      });
      await expect(
        openWorkspaceDocument({ ...request, target: { ...request.target, path, tabType } })
      ).resolves.toEqual({ status: 'blocked', message: documentReadReason('unknown') });
      expect(useCanvasStore.getState().panels.main.tabs).toEqual([]);
      expect(mocks.confirmNotebookReopen).not.toHaveBeenCalled();
    }
  );

  it('does not hand a replaced notebook file to a different viewer', async () => {
    mocks.open.mockImplementation(({ consume }) =>
      consume({ ...resolved, artifact: { kind: 'assembly-design', id: 'new-design' } }, 'lease')
    );
    await expect(openWorkspaceDocument(request)).resolves.toEqual({
      status: 'blocked',
      message: documentReadReason('unsupported-format'),
    });
    expect(useCanvasStore.getState().panels.main.tabs).toEqual([]);
  });

  it('forwards the authority fingerprint and distinguishes a created page from existing-tab focus', async () => {
    const revision = { ...resolved, authorityFingerprint: 'PRIVATE_AUTHORITY_REVISION' };
    mocks.upsert.mockResolvedValue(true);
    mocks.open.mockImplementation(({ consume }) => consume(revision, 'lease'));
    await openWorkspaceDocument(request);
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ authorityFingerprint: revision.authorityFingerprint })
    );
    expect(mocks.confirmNotebookReopen).toHaveBeenLastCalledWith(
      null,
      expect.objectContaining({
        pageId: resolved.entity.id,
        path: '/workspace/Notes',
        authorityFingerprint: revision.authorityFingerprint,
        created: true,
      })
    );
    await openWorkspaceDocument(request);
    expect(mocks.confirmNotebookReopen).toHaveBeenLastCalledWith(
      null,
      expect.objectContaining({ created: false })
    );
  });

  it.each(['repaired', 'dirty'] as const)(
    'does not attest an exact reopen for %s presentation',
    async (kind) => {
      mocks.upsert.mockResolvedValue(kind !== 'repaired');
      if (kind === 'dirty') mocks.dirtyIds.add(resolved.entity.id);
      mocks.open.mockImplementation(({ consume }) =>
        consume({ ...resolved, authorityFingerprint: 'PRIVATE_FP' }, 'lease')
      );
      await openWorkspaceDocument(request);
      expect(mocks.confirmNotebookReopen).toHaveBeenLastCalledWith(
        null,
        expect.objectContaining({ created: false })
      );
    }
  );
});

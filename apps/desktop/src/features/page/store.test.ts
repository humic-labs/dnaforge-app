import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockPlatform } = vi.hoisted(() => ({
  mockPlatform: {
    db: {
      execute: vi.fn().mockResolvedValue({ changes: 0, lastInsertRowid: 0 }),
      mutateLegacyNotebookPage: vi.fn().mockResolvedValue(null),
      deleteNotebookPage: vi.fn().mockResolvedValue(false),
      replaceNotebookProjection: vi.fn().mockResolvedValue(undefined),
      select: vi.fn().mockResolvedValue([]),
    },
  },
}));

vi.mock('../../platform', () => ({
  platform: () => mockPlatform,
  initPlatform: vi.fn().mockResolvedValue(mockPlatform),
}));

import { usePageStore } from './store';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import type { LegacyNotebookPageMutation, NotebookPageRow } from '../../shared/notebook-projection';

function nativeLegacyCommit(input: LegacyNotebookPageMutation): NotebookPageRow | null {
  if (input.operation === 'delete') return null;
  return {
    id: input.id,
    title: input.title,
    content: JSON.stringify(input.content),
    date: null,
    created_at: input.updatedAt,
    updated_at: input.updatedAt,
  };
}

afterEach(() => expect(mockPlatform.db.execute).not.toHaveBeenCalled());

beforeEach(() => {
  mockPlatform.db.select.mockReset().mockResolvedValue([]);
  mockPlatform.db.mutateLegacyNotebookPage
    .mockReset()
    .mockImplementation(async (input) => nativeLegacyCommit(input));
  mockPlatform.db.execute.mockReset();
  mockPlatform.db.deleteNotebookPage.mockReset().mockResolvedValue(false);
  mockPlatform.db.replaceNotebookProjection.mockReset().mockResolvedValue(undefined);

  const actions = usePageStore.getState();
  usePageStore.setState(
    {
      pages: {},
      pageList: [],
      loadingIds: new Set(),
      dirtyIds: new Set(),
      listLoaded: false,
      isListLoading: false,
      listError: null,
      initialized: false,
      revision: 0,
      initialize: actions.initialize,
      refreshNewPages: actions.refreshNewPages,
      fetchPage: actions.fetchPage,
      reloadPage: actions.reloadPage,
      reloadPages: actions.reloadPages,
      fetchPages: actions.fetchPages,
      savePage: actions.savePage,
      updatePageTitle: actions.updatePageTitle,
      renamePageArtifact: actions.renamePageArtifact,
      upsertPageFromArtifact: actions.upsertPageFromArtifact,
      createPage: actions.createPage,
      deletePage: actions.deletePage,
      setDirty: actions.setDirty,
      getPageIds: actions.getPageIds,
      isPageLoading: actions.isPageLoading,
    },
    true
  );
});

describe('usePageStore', () => {
  it('rejects a cancelled batch read before publishing or globally initializing pages', async () => {
    const pending = Promise.withResolvers<
      Array<{
        id: string;
        title: string;
        content: string;
        date: null;
        created_at: number;
        updated_at: number;
      }>
    >();
    mockPlatform.db.select.mockReturnValueOnce(pending.promise);
    let current = true;
    const loaded = usePageStore.getState().reloadPages(['page-1'], {
      beforePublish: () => {
        if (!current) throw new Error('Refresh cancelled');
      },
    });
    const rejected = expect(loaded).rejects.toThrow('Refresh cancelled');
    current = false;
    pending.resolve([
      {
        id: 'page-1',
        title: 'Stale',
        content: '{"type":"doc"}',
        date: null,
        created_at: 1,
        updated_at: 1,
      },
    ]);
    await rejected;
    expect(usePageStore.getState().pages).toEqual({});
    expect(usePageStore.getState().initialized).toBe(false);
    expect(mockPlatform.db.select).toHaveBeenCalledOnce();
    expect(mockPlatform.db.select).toHaveBeenCalledWith('SELECT * FROM pages WHERE id IN (?)', [
      'page-1',
    ]);
  });
  describe('reloadPage', () => {
    it('evicts a remotely deleted page from every in-memory index', async () => {
      const stalePage = {
        id: 'page-deleted',
        title: 'Stale',
        content: { type: 'doc' as const, content: [] },
        date: null,
        createdAt: new Date(1),
        updatedAt: new Date(1),
      };
      usePageStore.setState({
        initialized: true,
        pages: { [stalePage.id]: stalePage },
        pageList: [stalePage],
        dirtyIds: new Set(),
      });
      mockPlatform.db.select.mockResolvedValueOnce([]);

      await expect(usePageStore.getState().reloadPage(stalePage.id)).resolves.toBeNull();

      expect(usePageStore.getState().pages[stalePage.id]).toBeUndefined();
      expect(usePageStore.getState().pageList).toEqual([]);
      expect(usePageStore.getState().dirtyIds.has(stalePage.id)).toBe(false);
    });

    it('preserves a dirty page when a remote refresh would delete it', async () => {
      const stalePage = {
        id: 'page-dirty',
        title: 'Unsaved',
        content: { type: 'doc' as const, content: [] },
        date: null,
        createdAt: new Date(1),
        updatedAt: new Date(1),
      };
      usePageStore.setState({
        initialized: true,
        pages: { [stalePage.id]: stalePage },
        pageList: [stalePage],
        dirtyIds: new Set([stalePage.id]),
      });
      mockPlatform.db.select.mockResolvedValueOnce([]);

      await expect(usePageStore.getState().reloadPage(stalePage.id)).rejects.toThrow(
        'Cannot reload dirty notebook'
      );
      expect(usePageStore.getState().pages[stalePage.id]).toEqual(stalePage);
      expect(usePageStore.getState().dirtyIds.has(stalePage.id)).toBe(true);
    });

    it('adds a remotely created page to both the content and search indexes', async () => {
      mockPlatform.db.select.mockResolvedValueOnce([
        {
          id: 'page-new',
          title: 'Remote notebook',
          content: '{"type":"doc","content":[]}',
          date: null,
          created_at: 10,
          updated_at: 20,
        },
      ]);
      usePageStore.setState({ initialized: true });

      await expect(usePageStore.getState().reloadPage('page-new')).resolves.toMatchObject({
        id: 'page-new',
        title: 'Remote notebook',
      });

      expect(usePageStore.getState().pages['page-new']?.title).toBe('Remote notebook');
      expect(usePageStore.getState().pageList).toEqual([
        expect.objectContaining({ id: 'page-new', title: 'Remote notebook' }),
      ]);
    });
  });

  describe('refreshNewPages', () => {
    function row(id: string, title: string, content = '{}') {
      const now = Date.now();
      return { id, title, content, date: null, created_at: now, updated_at: now };
    }

    it('learns pages created after startup, which initialize() can never do', async () => {
      mockPlatform.db.select.mockResolvedValueOnce([row('page_known', 'Known')]);
      await usePageStore.getState().initialize();
      expect(Object.keys(usePageStore.getState().pages)).toEqual(['page_known']);

      mockPlatform.db.select.mockResolvedValueOnce([
        row('page_known', 'Known'),
        row('page_imported', 'Controlled Corpus A'),
      ]);

      await usePageStore.getState().initialize();
      expect(usePageStore.getState().pages.page_imported).toBeUndefined();

      const added = await usePageStore.getState().refreshNewPages();
      expect(added).toBe(1);
      expect(usePageStore.getState().pages.page_imported?.title).toBe('Controlled Corpus A');
      expect(
        usePageStore
          .getState()
          .pageList.map((p) => p.id)
          .sort()
      ).toEqual(['page_imported', 'page_known']);
    });

    it('never overwrites a page already in memory, which may hold unsaved edits', async () => {
      mockPlatform.db.select.mockResolvedValueOnce([row('page_open', 'Saved title')]);
      await usePageStore.getState().initialize();

      usePageStore.setState((state) => ({
        pages: {
          ...state.pages,
          page_open: { ...state.pages.page_open, title: 'Unsaved edit' },
        },
      }));

      mockPlatform.db.select.mockResolvedValueOnce([row('page_open', 'Saved title')]);
      const added = await usePageStore.getState().refreshNewPages();

      expect(added).toBe(0);
      expect(usePageStore.getState().pages.page_open?.title).toBe('Unsaved edit');
    });
  });

  describe('initialize', () => {
    it('loads pages from database', async () => {
      const now = Date.now();
      mockPlatform.db.select.mockResolvedValueOnce([
        {
          id: 'page_1',
          title: 'Test Page',
          content: JSON.stringify({ type: 'doc', content: [] }),
          date: null,
          created_at: now,
          updated_at: now,
        },
      ]);

      await usePageStore.getState().initialize();

      const state = usePageStore.getState();
      expect(state.initialized).toBe(true);
      expect(state.pages['page_1']).toBeDefined();
      expect(state.pages['page_1'].title).toBe('Test Page');
      expect(state.pageList).toHaveLength(1);
    });

    it('only initializes once', async () => {
      mockPlatform.db.select.mockResolvedValueOnce([]);
      await usePageStore.getState().initialize();
      await usePageStore.getState().initialize();

      expect(mockPlatform.db.select).toHaveBeenCalledTimes(1);
    });
  });

  describe('createPage', () => {
    it('keeps an explicitly identified profile notebook database-only with one project mounted', async () => {
      const previousFolders = useWorkspaceStore.getState().folders;
      useWorkspaceStore.setState({ folders: [{ path: '/project', name: 'Project', addedAt: 1 }] });
      try {
        const id = await usePageStore
          .getState()
          .createPage('Profile notebook', 'page-protein-prompt-trials-v1');
        expect(id).toBe('page-protein-prompt-trials-v1');
        await usePageStore.getState().savePage(id, { type: 'doc', content: [] });
        expect(mockPlatform.db.mutateLegacyNotebookPage).toHaveBeenCalledTimes(2);
        expect(mockPlatform.db.replaceNotebookProjection).not.toHaveBeenCalled();
      } finally {
        useWorkspaceStore.setState({ folders: previousFolders });
      }
    });
    it('creates a new page with default title', async () => {
      const pageId = await usePageStore.getState().createPage();

      expect(mockPlatform.db.mutateLegacyNotebookPage).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'upsert',
          id: expect.stringMatching(/^page-/),
          title: 'Untitled',
          expectedProjectionFingerprint: null,
        }),
        undefined
      );
      expect(pageId).toMatch(/^page-/);
      expect(usePageStore.getState().pages[pageId].title).toBe('Untitled');
    });

    it('creates a new page with custom title', async () => {
      const pageId = await usePageStore.getState().createPage('My Custom Title');
      expect(usePageStore.getState().pages[pageId].title).toBe('My Custom Title');
    });

    it('creates pages with unique IDs', async () => {
      const id1 = await usePageStore.getState().createPage();
      const id2 = await usePageStore.getState().createPage();

      expect(id1).not.toBe(id2);
      expect(Object.keys(usePageStore.getState().pages)).toHaveLength(2);
    });

    it('creates page with empty document content', async () => {
      const pageId = await usePageStore.getState().createPage();
      expect(usePageStore.getState().pages[pageId].content).toEqual({
        type: 'doc',
        content: [{ type: 'paragraph', content: [] }],
      });
    });

    it('sets createdAt and updatedAt timestamps', async () => {
      const pageId = await usePageStore.getState().createPage();
      const page = usePageStore.getState().pages[pageId];

      expect(page.createdAt).toBeInstanceOf(Date);
      expect(page.updatedAt).toBeInstanceOf(Date);
    });

    it('throws error when database insert fails', async () => {
      mockPlatform.db.mutateLegacyNotebookPage.mockRejectedValueOnce(new Error('Database error'));
      await expect(usePageStore.getState().createPage()).rejects.toThrow('Database error');
    });
  });

  describe('savePage', () => {
    it('saves page content and updates timestamp', async () => {
      const now = Date.now();
      usePageStore.setState({
        pages: {
          page_1: {
            id: 'page_1',
            title: 'Test',
            content: { type: 'doc', content: [] },
            date: null,
            createdAt: new Date(now),
            updatedAt: new Date(now),
          },
        },
      });

      const newContent = {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello world' }] }],
      };

      await usePageStore.getState().savePage('page_1', newContent);

      expect(mockPlatform.db.mutateLegacyNotebookPage).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'upsert',
          id: 'page_1',
          title: 'Test',
          content: newContent,
          updatedAt: expect.any(Number),
        }),
        undefined
      );
      expect(usePageStore.getState().pages['page_1'].content).toEqual(newContent);
    });

    it('publishes a provisional title with the same revision as its first body save', async () => {
      const now = Date.now();
      usePageStore.setState({
        pages: {
          page_1: {
            id: 'page_1',
            title: 'Untitled',
            content: { type: 'doc', content: [] },
            date: null,
            createdAt: new Date(now),
            updatedAt: new Date(now),
          },
        },
        pageList: [{ id: 'page_1', title: 'Untitled', updatedAt: new Date(now) }],
      });
      const content = {
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: { level: 1 },
            content: [{ type: 'text', text: 'Atomic title' }],
          },
        ],
      };

      await usePageStore.getState().savePage('page_1', content);

      expect(mockPlatform.db.mutateLegacyNotebookPage).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'upsert',
          id: 'page_1',
          title: 'Atomic title',
          content: content,
          updatedAt: expect.any(Number),
        }),
        undefined
      );
      expect(usePageStore.getState().pages.page_1.title).toBe('Atomic title');
      expect(usePageStore.getState().pageList[0]?.title).toBe('Atomic title');
    });

    it('does nothing if page does not exist', async () => {
      await usePageStore.getState().savePage('nonexistent', { type: 'doc', content: [] });
      expect(mockPlatform.db.mutateLegacyNotebookPage).not.toHaveBeenCalled();
    });
  });

  describe('upsertPageFromArtifact', () => {
    it('hydrates an unchanged database projection without advancing its timestamp', async () => {
      const content = {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Unchanged' }] }],
      };
      mockPlatform.db.select.mockResolvedValueOnce([
        {
          id: 'page_1',
          title: 'Test',
          content: JSON.stringify(content),
          date: null,
          created_at: 500,
          updated_at: 1_000,
        },
      ]);

      await usePageStore.getState().upsertPageFromArtifact({
        id: 'page_1',
        title: 'Test',
        content: structuredClone(content),
        workspaceRoot: '/workspace',
      });

      expect(mockPlatform.db.select).toHaveBeenCalledWith('SELECT * FROM pages WHERE id = ?', [
        'page_1',
      ]);
      expect(mockPlatform.db.mutateLegacyNotebookPage).not.toHaveBeenCalled();
      expect(usePageStore.getState().pages['page_1']).toMatchObject({
        title: 'Test',
        content,
        createdAt: new Date(500),
        updatedAt: new Date(1_000),
      });
      expect(usePageStore.getState().pageList).toEqual([
        expect.objectContaining({ id: 'page_1', updatedAt: new Date(1_000) }),
      ]);
    });

    it('repairs a stale database projection even when the renderer cache already matches', async () => {
      const content = {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Authoritative' }] }],
      };
      usePageStore.setState({
        pages: {
          page_1: {
            id: 'page_1',
            title: 'Test',
            content,
            date: null,
            createdAt: new Date(500),
            updatedAt: new Date(1_000),
          },
        },
      });
      mockPlatform.db.select.mockResolvedValueOnce([
        {
          id: 'page_1',
          title: 'Stale',
          content: JSON.stringify({ type: 'doc', content: [] }),
          date: null,
          created_at: 500,
          updated_at: 750,
        },
      ]);

      await usePageStore.getState().upsertPageFromArtifact({
        id: 'page_1',
        title: 'Test',
        content: structuredClone(content),
        workspaceRoot: '/workspace',
      });

      expect(mockPlatform.db.select).toHaveBeenCalledWith('SELECT * FROM pages WHERE id = ?', [
        'page_1',
      ]);
      expect(mockPlatform.db.mutateLegacyNotebookPage).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'upsert',
          id: 'page_1',
          title: 'Test',
          content: content,
          updatedAt: expect.any(Number),
        }),
        undefined
      );
      expect(usePageStore.getState().pages['page_1']).toMatchObject({ title: 'Test', content });
    });
  });

  describe('setDirty', () => {
    it('marks page as dirty', () => {
      usePageStore.getState().setDirty('page_1', true);
      expect(usePageStore.getState().dirtyIds.has('page_1')).toBe(true);
    });

    it('marks page as clean', () => {
      usePageStore.setState({ dirtyIds: new Set(['page_1']) });
      usePageStore.getState().setDirty('page_1', false);
      expect(usePageStore.getState().dirtyIds.has('page_1')).toBe(false);
    });

    it('preserves dirtyIds reference when nothing changes ', () => {
      usePageStore.getState().setDirty('page_1', true);
      const before = usePageStore.getState().dirtyIds;
      usePageStore.getState().setDirty('page_1', true);
      const after = usePageStore.getState().dirtyIds;
      expect(after).toBe(before);
    });

    it('preserves dirtyIds reference on no-op false→false ', () => {
      const before = usePageStore.getState().dirtyIds;
      usePageStore.getState().setDirty('page_1', false);
      const after = usePageStore.getState().dirtyIds;
      expect(after).toBe(before);
    });
  });

  describe('updatePageTitle', () => {
    it('updates page title', async () => {
      const now = Date.now();
      usePageStore.setState({
        pages: {
          page_1: {
            id: 'page_1',
            title: 'Original Title',
            content: { type: 'doc', content: [] },
            date: null,
            createdAt: new Date(now),
            updatedAt: new Date(now),
          },
        },
        pageList: [],
      });

      await usePageStore.getState().updatePageTitle('page_1', 'New Title');

      expect(mockPlatform.db.mutateLegacyNotebookPage).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'upsert',
          id: 'page_1',
          title: 'New Title',
          updatedAt: expect.any(Number),
        }),
        undefined
      );
      expect(usePageStore.getState().pages['page_1'].title).toBe('New Title');
    });

    it('does nothing for nonexistent page', async () => {
      await usePageStore.getState().updatePageTitle('nonexistent', 'Title');
      expect(mockPlatform.db.mutateLegacyNotebookPage).not.toHaveBeenCalled();
    });
  });

  describe('fetchPage', () => {
    it('returns page from store if exists', async () => {
      const now = Date.now();
      usePageStore.setState({
        initialized: true,
        pages: {
          page_1: {
            id: 'page_1',
            title: 'Test Page',
            content: { type: 'doc', content: [] },
            date: null,
            createdAt: new Date(now),
            updatedAt: new Date(now),
          },
        },
      });

      const page = await usePageStore.getState().fetchPage('page_1');
      expect(mockPlatform.db.select).not.toHaveBeenCalled();
      expect(page?.title).toBe('Test Page');
    });

    it('fetches from database if not in cache', async () => {
      const now = Date.now();
      usePageStore.setState({ initialized: true });

      mockPlatform.db.select.mockResolvedValueOnce([
        {
          id: 'page_1',
          title: 'Fetched Page',
          content: JSON.stringify({ type: 'doc', content: [] }),
          date: null,
          created_at: now,
          updated_at: now,
        },
      ]);

      const page = await usePageStore.getState().fetchPage('page_1');
      expect(mockPlatform.db.select).toHaveBeenCalledWith('SELECT * FROM pages WHERE id = ?', [
        'page_1',
      ]);
      expect(page?.title).toBe('Fetched Page');
    });

    it('returns null for nonexistent page', async () => {
      usePageStore.setState({ initialized: true });
      mockPlatform.db.select.mockResolvedValueOnce([]);

      const page = await usePageStore.getState().fetchPage('nonexistent');
      expect(page).toBeNull();
    });
  });

  describe('deletePage', () => {
    it('deletes page from store and database', async () => {
      const now = Date.now();
      usePageStore.setState({
        pages: {
          page_1: {
            id: 'page_1',
            title: 'To Delete',
            content: { type: 'doc', content: [] },
            date: null,
            createdAt: new Date(now),
            updatedAt: new Date(now),
          },
        },
        pageList: [
          {
            id: 'page_1',
            title: 'To Delete',
            date: null,
            createdAt: new Date(now),
            updatedAt: new Date(now),
          },
        ],
      });

      await usePageStore.getState().deletePage('page_1');

      expect(mockPlatform.db.mutateLegacyNotebookPage).toHaveBeenCalledWith(
        { operation: 'delete', id: 'page_1' },
        undefined
      );
      expect(usePageStore.getState().pages['page_1']).toBeUndefined();
      expect(usePageStore.getState().pageList.find((p) => p.id === 'page_1')).toBeUndefined();
    });
  });

  describe('fetchPages', () => {
    it('initializes store and returns page list', async () => {
      const now = Date.now();
      mockPlatform.db.select.mockResolvedValueOnce([
        {
          id: 'page_1',
          title: 'Page 1',
          content: JSON.stringify({ type: 'doc', content: [] }),
          date: null,
          created_at: now,
          updated_at: now,
        },
        {
          id: 'page_2',
          title: 'Page 2',
          content: JSON.stringify({ type: 'doc', content: [] }),
          date: null,
          created_at: now,
          updated_at: now,
        },
      ]);

      const pages = await usePageStore.getState().fetchPages();

      expect(pages).toHaveLength(2);
      expect(usePageStore.getState().pageList).toHaveLength(2);
      expect(usePageStore.getState().listLoaded).toBe(true);
    });
  });

  describe('store .revision (per-store-invariants)', () => {
    it('initial revision is 0', () => {
      expect(usePageStore.getState().revision).toBe(0);
    });

    it('createPage bumps revision', async () => {
      const before = usePageStore.getState().revision;
      await usePageStore.getState().createPage();
      expect(usePageStore.getState().revision).toBe(before + 1);
    });

    it('savePage bumps revision', async () => {
      const now = Date.now();
      usePageStore.setState({
        pages: {
          page_1: {
            id: 'page_1',
            title: 'Test',
            content: { type: 'doc', content: [] },
            date: null,
            createdAt: new Date(now),
            updatedAt: new Date(now),
          },
        },
      });
      const before = usePageStore.getState().revision;
      await usePageStore.getState().savePage('page_1', { type: 'doc', content: [] });
      expect(usePageStore.getState().revision).toBe(before + 1);
    });

    it('updatePageTitle bumps revision', async () => {
      const now = Date.now();
      usePageStore.setState({
        pages: {
          page_1: {
            id: 'page_1',
            title: 'Original',
            content: { type: 'doc', content: [] },
            date: null,
            createdAt: new Date(now),
            updatedAt: new Date(now),
          },
        },
        pageList: [],
      });
      const before = usePageStore.getState().revision;
      await usePageStore.getState().updatePageTitle('page_1', 'Renamed');
      expect(usePageStore.getState().revision).toBe(before + 1);
    });

    it('deletePage bumps revision', async () => {
      const now = Date.now();
      usePageStore.setState({
        pages: {
          page_1: {
            id: 'page_1',
            title: 'Doomed',
            content: { type: 'doc', content: [] },
            date: null,
            createdAt: new Date(now),
            updatedAt: new Date(now),
          },
        },
        pageList: [
          {
            id: 'page_1',
            title: 'Doomed',
            date: null,
            createdAt: new Date(now),
            updatedAt: new Date(now),
          },
        ],
      });
      const before = usePageStore.getState().revision;
      await usePageStore.getState().deletePage('page_1');
      expect(usePageStore.getState().revision).toBe(before + 1);
    });

    it('setDirty(true) bumps revision on the false→true transition only ', () => {
      const start = usePageStore.getState().revision;
      usePageStore.getState().setDirty('page_1', true);
      expect(usePageStore.getState().revision).toBe(start + 1);
      usePageStore.getState().setDirty('page_1', true);
      expect(usePageStore.getState().revision).toBe(start + 1);
      usePageStore.getState().setDirty('page_1', false);
      expect(usePageStore.getState().revision).toBe(start + 2);
    });

    it('pure read actions do NOT bump revision', () => {
      const before = usePageStore.getState().revision;
      usePageStore.getState().getPageIds();
      usePageStore.getState().isPageLoading('page_1');
      expect(usePageStore.getState().revision).toBe(before);
    });
  });
});

describe('notebook startup isolation', () => {
  it('shares a pending initial read and holds mutations until it finishes', async () => {
    const pending = Promise.withResolvers<never[]>();
    mockPlatform.db.select.mockReturnValueOnce(pending.promise);
    const first = usePageStore.getState().initialize();
    const second = usePageStore.getState().initialize();
    const created = usePageStore.getState().createPage('Created while loading');
    await Promise.resolve();
    expect(mockPlatform.db.select).toHaveBeenCalledTimes(1);
    expect(mockPlatform.db.mutateLegacyNotebookPage).not.toHaveBeenCalled();
    pending.resolve([]);
    await Promise.all([first, second]);
    const id = await created;
    expect(usePageStore.getState().pages[id].title).toBe('Created while loading');
    expect(usePageStore.getState()).toMatchObject({
      initialized: true,
      isListLoading: false,
      listError: null,
    });
  });

  it('retains rejected loading as unavailable and permits explicit retry', async () => {
    mockPlatform.db.select.mockRejectedValueOnce(new Error('Notebook read unavailable'));
    await usePageStore.getState().initialize();
    expect(usePageStore.getState()).toMatchObject({
      initialized: false,
      isListLoading: false,
      listError: 'Notebook read unavailable',
    });
    await expect(usePageStore.getState().createPage('Unsafe default')).rejects.toThrow(
      'Notebook read unavailable'
    );
    expect(mockPlatform.db.mutateLegacyNotebookPage).not.toHaveBeenCalled();
    await usePageStore.getState().initialize();
    expect(usePageStore.getState()).toMatchObject({ initialized: true, listError: null });
  });
});

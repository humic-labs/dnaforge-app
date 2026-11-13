import { isElectron } from '../../utils/environment';
import { create } from 'zustand';
import type { JSONContent } from '@tiptap/core';
import { normalizeNotebookReferences } from '../../shared/notebook-reference-normalization';
import type { Page, PageListItem } from './types';
import { platform } from '../../platform';
import {
  artifactStemFromFileName,
  renameNotebookArtifactFile,
  resolveNotebookArtifactWorkspaceOwner,
  writeNotebookArtifactSnapshot,
  trashNotebookArtifactForPage,
  type WorkspaceArtifactResult,
} from '../../db/workspace-artifacts';
import { withRevision } from '../../shared/store-revision';
import {
  captureNotebookSave,
  confirmNotebookCommit,
  observeNotebookAuthorityWrite,
  observeNotebookSaveFailure,
} from './notebook-workflow';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { resolveActiveImportRoot } from '../workspace-loader/public/resolve-import-root';
import { repairPageReferences } from './entity-ref/repair-page-references';
import { resolveOwningRootForPage } from './entity-ref/resolve-owning-root-for-page';
import { getCurrentCatalogFileForEntity, resolveWorkspaceScope } from '../../db/workspace-catalog';
import { notebookProjectionFingerprint } from '../../shared/notebook-projection';
import { hasWorkspaceScope, scopedProjectionId } from '../../shared/workspace-scoped-identity';
import { withRendererWorkspaceMutation } from '../../services/workspace-mutation-transaction';
import { extractTitle, shouldDeriveNotebookTitleFromContent } from './utils';
import { withNotebookAuthorityOperation } from './notebook-authority-queue';
import { settlePublishedNotebookProjection } from '../../db/entity-substrate/notebook-adapter';
import { canonicalNotebookJson } from '../../db/notebook-markdown-codec';
import { subscribeNotebookDocumentProjection } from './notebook-document-projection';
import {
  captureTableNotebookSave,
  confirmTableNotebookCommit,
  observeTableNotebookSaveFailure,
} from './embeds/table/notebook-observation';

interface PageState {
  pages: Record<string, Page>;
  pageList: PageListItem[];
  loadingIds: Set<string>;
  dirtyIds: Set<string>;
  listLoaded: boolean;
  isListLoading: boolean;
  listError: string | null;
  initialized: boolean;

  revision: number;
}

interface PageActions {
  initialize: () => Promise<void>;

  refreshNewPages: () => Promise<number>;
  fetchPage: (pageId: string) => Promise<Page | null>;

  reloadPage: (pageId: string) => Promise<Page | null>;

  reloadPages: (
    pageIds: readonly string[],
    options?: { beforePublish?: () => void }
  ) => Promise<{ loadedIds: string[]; missingIds: string[] }>;

  evictPages: (pageIds: readonly string[]) => void;
  fetchPages: (search?: string) => Promise<PageListItem[]>;
  savePage: (
    pageId: string,
    content: JSONContent,
    options?: {
      expectedCanonicalFingerprint?: string;
      mutationToken?: string;
      preserveDirtyState?: boolean;
      agentProvenance?: { actor: string; operationId: string };
    }
  ) => Promise<string | undefined>;
  updatePageTitle: (pageId: string, title: string, mutationToken?: string) => Promise<void>;
  renamePageArtifact: (
    pageId: string,
    title: string,
    mutationToken?: string
  ) => Promise<WorkspaceArtifactResult | null>;
  upsertPageFromArtifact: (input: {
    id: string;
    title: string;
    content: JSONContent;
    workspaceRoot?: string | null;
    authorityFingerprint?: string;
    mutationToken?: string;
  }) => Promise<boolean>;
  createPage: (title?: string, explicitId?: string, mutationToken?: string) => Promise<string>;
  deletePage: (pageId: string) => Promise<void>;

  ensureReferencesRepaired: (pageId: string) => Promise<string | undefined>;
  setDirty: (pageId: string, isDirty: boolean) => void;
  getPageIds: () => string[];
  isPageLoading: (pageId: string) => boolean;
}

type PageStore = PageState & PageActions;

function generateId(): string {
  return `page-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

const defaultContent: JSONContent = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [],
    },
  ],
};

function rowToPage(row: {
  id: string;
  title: string;
  content: string;
  date: number | null;
  created_at: number;
  updated_at: number;
}): Page {
  return {
    id: row.id,
    title: row.title,
    content: normalizeNotebookReferences(JSON.parse(row.content) as JSONContent),
    date: row.date ? new Date(row.date) : null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function rowToListItem(row: {
  id: string;
  title: string;
  date: number | null;
  created_at: number;
  updated_at: number;
}): PageListItem {
  return {
    id: row.id,
    title: row.title,
    date: row.date ? new Date(row.date) : null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

let pageInitialization: Promise<void> | null = null;

async function waitForNotebookStartup(): Promise<void> {
  if (pageInitialization) await pageInitialization;
  const state = usePageStore.getState();
  if (!state.initialized && state.listError) throw new Error(state.listError);
}

async function persistNotebookPageProjection(input: {
  pageId: string;
  title: string;
  content: JSONContent;
  workspaceRoot: string | null;
  artifact: WorkspaceArtifactResult | null;
  expectedProjectionFingerprint: string | null;
  now: number;
  mutationToken?: string;
}): Promise<boolean> {
  if (input.artifact) {
    if (!(await settlePublishedNotebookProjection(input)))
      throw new Error('The notebook file was published without a checked native projection.');
    return true;
  }
  const committed = await platform().db.mutateLegacyNotebookPage(
    {
      operation: 'upsert',
      id: input.pageId,
      title: input.title,
      content: input.content,
      updatedAt: input.now,
      expectedProjectionFingerprint: input.expectedProjectionFingerprint,
    },
    input.mutationToken
  );
  if (
    committed?.id !== input.pageId ||
    committed.title !== input.title ||
    committed.content !== JSON.stringify(input.content) ||
    committed.updated_at !== input.now
  ) {
    throw new Error('The legacy notebook save was not confirmed by its native owner.');
  }
  return false;
}

export const usePageStore = create<PageStore>()(
  withRevision((set, get) => ({
    pages: {},
    pageList: [],
    loadingIds: new Set(),
    dirtyIds: new Set(),
    listLoaded: false,
    isListLoading: false,
    listError: null,
    initialized: false,
    revision: 0,

    initialize: async () => {
      if (get().initialized) return;
      if (pageInitialization) return pageInitialization;

      pageInitialization = (async () => {
        try {
          set({ isListLoading: true, listError: null });
          const db = platform().db;

          const rows = await db.select<
            {
              id: string;
              title: string;
              content: string;
              date: number | null;
              created_at: number;
              updated_at: number;
            }[]
          >('SELECT * FROM pages ORDER BY updated_at DESC');

          const pages: Record<string, Page> = {};
          const pageList: PageListItem[] = [];

          for (const row of rows) {
            const page = rowToPage(row);
            pages[page.id] = page;
            pageList.push(rowToListItem(row));
          }

          set({
            pages,
            pageList,
            listLoaded: true,
            isListLoading: false,
            initialized: true,
          });

          console.log(`[PageStore] Loaded ${rows.length} pages from database`);
        } catch (error) {
          console.error('[PageStore] Failed to initialize:', error);
          set({
            listError: error instanceof Error ? error.message : 'Failed to load pages',
            isListLoading: false,
          });
        }
      })().finally(() => {
        pageInitialization = null;
      });
      return pageInitialization;
    },

    refreshNewPages: async () => {
      if (!get().initialized) {
        await get().initialize();
        return 0;
      }
      try {
        const db = platform().db;
        const rows = await db.select<
          {
            id: string;
            title: string;
            content: string;
            date: number | null;
            created_at: number;
            updated_at: number;
          }[]
        >('SELECT * FROM pages ORDER BY updated_at DESC');

        const known = get().pages;
        const added: Record<string, Page> = {};
        const pageList: PageListItem[] = [];
        for (const row of rows) {
          pageList.push(rowToListItem(row));

          if (known[row.id] !== undefined) continue;
          const page = rowToPage(row);
          added[page.id] = page;
        }

        const addedCount = Object.keys(added).length;
        set((state) => ({
          pages: addedCount > 0 ? { ...state.pages, ...added } : state.pages,
          pageList,
          listLoaded: true,
        }));
        if (addedCount > 0) {
          console.log(`[PageStore] Learned ${addedCount} page(s) created since startup`);
        }
        return addedCount;
      } catch (error) {
        console.error('[PageStore] Failed to refresh pages:', error);
        return 0;
      }
    },

    reloadPages: async (pageIds, options) => {
      await waitForNotebookStartup();
      const uniqueIds = [...new Set(pageIds)];
      if (uniqueIds.length === 0) return { loadedIds: [], missingIds: [] };
      const placeholders = uniqueIds.map(() => '?').join(', ');
      const rows = await platform().db.select<
        {
          id: string;
          title: string;
          content: string;
          date: number | null;
          created_at: number;
          updated_at: number;
        }[]
      >(`SELECT * FROM pages WHERE id IN (${placeholders})`, uniqueIds);
      const loadedPages = new Map(rows.map((row) => [row.id, rowToPage(row)]));
      const missingIds = uniqueIds.filter((id) => !loadedPages.has(id));
      set((state) => {
        options?.beforePublish?.();
        const dirtyTarget = uniqueIds.find((id) => state.dirtyIds.has(id));
        if (dirtyTarget) {
          throw new Error(`Cannot reload dirty notebook ${dirtyTarget} from a remote replica.`);
        }
        const pages = { ...state.pages };
        for (const id of missingIds) delete pages[id];
        for (const [id, page] of loadedPages) pages[id] = page;

        const targetIds = new Set(uniqueIds);
        const pageList = state.pageList
          .filter((item) => !targetIds.has(item.id))
          .concat(
            [...loadedPages.values()].map((page) => ({
              id: page.id,
              title: page.title,
              date: page.date,
              createdAt: page.createdAt,
              updatedAt: page.updatedAt,
            }))
          )
          .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
        return { pages, pageList };
      });
      for (const id of missingIds) repairCheckedPages.delete(id);
      return { loadedIds: [...loadedPages.keys()], missingIds };
    },

    evictPages: (pageIds) => {
      const targetIds = new Set(pageIds);
      if (targetIds.size === 0) return;
      set((state) => {
        const pages = { ...state.pages };
        for (const id of targetIds) delete pages[id];
        return {
          pages,
          pageList: state.pageList.filter((page) => !targetIds.has(page.id)),
          loadingIds: new Set([...state.loadingIds].filter((id) => !targetIds.has(id))),
          dirtyIds: new Set([...state.dirtyIds].filter((id) => !targetIds.has(id))),
        };
      });
      for (const id of targetIds) repairCheckedPages.delete(id);
    },

    reloadPage: async (pageId) => {
      try {
        if (!get().initialized) await get().initialize();
        const result = await get().reloadPages([pageId]);
        if (result.missingIds.includes(pageId)) return null;
        return get().pages[pageId] ?? null;
      } catch (error) {
        console.error('[PageStore] Failed to reload page:', error);
        throw error;
      }
    },

    fetchPage: async (pageId) => {
      if (!get().initialized) {
        await get().initialize();
      }

      const cached = get().pages[pageId];
      if (cached) {
        return (await repairIfNeeded(pageId, cached, set, get)).page;
      }

      try {
        set((state) => ({
          loadingIds: new Set([...state.loadingIds, pageId]),
        }));

        const db = platform().db;
        const rows = await db.select<
          {
            id: string;
            title: string;
            content: string;
            date: number | null;
            created_at: number;
            updated_at: number;
          }[]
        >('SELECT * FROM pages WHERE id = ?', [pageId]);

        if (rows.length === 0) {
          return null;
        }

        const loaded = rowToPage(rows[0]);
        set((state) => ({
          pages: { ...state.pages, [pageId]: loaded },
          loadingIds: new Set([...state.loadingIds].filter((id) => id !== pageId)),
        }));

        return (await repairIfNeeded(pageId, loaded, set, get)).page;
      } catch (error) {
        console.error('[PageStore] Failed to fetch page:', error);
        set((state) => ({
          loadingIds: new Set([...state.loadingIds].filter((id) => id !== pageId)),
        }));
        return null;
      }
    },

    fetchPages: async (_search?: string) => {
      if (!get().initialized) {
        await get().initialize();
      }

      return get().pageList;
    },

    savePage: async (pageId, content, options) => {
      content = normalizeNotebookReferences(content);
      const tableObservation = captureTableNotebookSave(pageId, content);
      const notebookObservation = captureNotebookSave(pageId, content);
      return withNotebookAuthorityOperation(pageId, async () => {
        try {
          await waitForNotebookStartup();
          const page = get().pages[pageId];
          if (!page) {
            observeTableNotebookSaveFailure(tableObservation);
            observeNotebookSaveFailure(notebookObservation);
            return undefined;
          }

          if (isElectron()) {
            const native = await import('./notebook-document-client');
            if (native.ownsNativeNotebookPage(pageId)) {
              const client = native.getNativeNotebookDocumentClient(pageId);
              await client.replaceContent(content);
              if (!(await client.save()))
                throw (
                  client.lastCommandError ??
                  new Error('The native notebook owner did not confirm the save.')
                );
              const committed = client.snapshot;
              confirmNotebookCommit(notebookObservation, {
                workspaceRoot: committed?.workspaceRoot ?? null,
                artifact: committed && {
                  path: committed.path,
                  fileKind: 'waypoint-notebook',
                  authorityFingerprint: committed.canonicalFingerprint,
                },
                projectionSettled: true,
                expectedFingerprint: options?.expectedCanonicalFingerprint,
              });
              return committed?.canonicalFingerprint;
            }
          }
          const now = Date.now();
          const derivedTitle = shouldDeriveNotebookTitleFromContent(page.title)
            ? extractTitle(content)
            : null;
          const title = derivedTitle ?? page.title;
          const workspaceRoot = await mutationRootForExistingPage(pageId);
          return await withRendererWorkspaceMutation(
            workspaceRoot,
            async (mutationToken) => {
              const artifact = await writeNotebookArtifactSnapshot({
                pageId,
                title,
                content,
                workspaceRoot,
                mutationToken,
                expectedCanonicalFingerprint: options?.expectedCanonicalFingerprint,
                expectedProjectionContent: page.content,
                agentProvenance: options?.agentProvenance,
              });
              observeNotebookAuthorityWrite(notebookObservation, { workspaceRoot, artifact });

              const projectionSettled = await persistNotebookPageProjection({
                pageId,
                title,
                content,
                workspaceRoot,
                artifact,
                expectedProjectionFingerprint: notebookProjectionFingerprint(
                  page.title,
                  page.content
                ),
                mutationToken,
                now,
              });
              const committedAtMs = Date.now();

              const updatedPage: Page = { ...page, title, content, updatedAt: new Date(now) };
              set((state) => ({
                pages: { ...state.pages, [pageId]: updatedPage },
                pageList: state.pageList.map((item) =>
                  item.id === pageId ? { ...item, title, updatedAt: new Date(now) } : item
                ),
                dirtyIds: options?.preserveDirtyState
                  ? state.dirtyIds
                  : new Set([...state.dirtyIds].filter((id) => id !== pageId)),
              }));
              await confirmTableNotebookCommit(tableObservation, {
                workspaceRoot,
                artifact,
                committedAtMs,
                projectionSettled,
              });
              confirmNotebookCommit(notebookObservation, {
                workspaceRoot,
                artifact,
                projectionSettled,
                expectedFingerprint: options?.expectedCanonicalFingerprint,
              });
              return artifact
                ? artifact.authorityFingerprint
                : notebookProjectionFingerprint(title, content);
            },
            options?.mutationToken
          );
        } catch (error) {
          observeTableNotebookSaveFailure(tableObservation, error);
          observeNotebookSaveFailure(notebookObservation, error);
          console.error('[PageStore] Failed to save page:', error);
          throw error;
        }
      });
    },

    updatePageTitle: async (pageId, title, parentMutationToken) =>
      withNotebookAuthorityOperation(pageId, async () => {
        await waitForNotebookStartup();
        if (isElectron()) {
          const native = await import('./notebook-document-client');
          if (native.ownsNativeNotebookPage(pageId)) {
            const client = native.getNativeNotebookDocumentClient(pageId);
            await client.flush();
            await client.command({ kind: 'set-title', title });
            if (!(await client.save()))
              throw client.lastCommandError ?? new Error('The notebook title was not saved.');
            return;
          }
        }
        try {
          const workspaceRoot = await mutationRootForExistingPage(pageId);
          await withRendererWorkspaceMutation(
            workspaceRoot,
            async (mutationToken) => {
              const page = get().pages[pageId];
              if (!page) return;
              const now = Date.now();

              const artifact = await writeNotebookArtifactSnapshot({
                pageId,
                title,
                content: page.content,
                workspaceRoot,
                mutationToken,
                expectedProjectionContent: page.content,
              });

              await persistNotebookPageProjection({
                pageId,
                title,
                content: page.content,
                workspaceRoot,
                artifact,
                expectedProjectionFingerprint: notebookProjectionFingerprint(
                  page.title,
                  page.content
                ),
                mutationToken,
                now,
              });

              set((state) => ({
                pages: {
                  ...state.pages,
                  [pageId]: { ...page, title, updatedAt: new Date(now) },
                },
                pageList: state.pageList.map((p) =>
                  p.id === pageId ? { ...p, title, updatedAt: new Date(now) } : p
                ),
              }));
            },
            parentMutationToken
          );
        } catch (error) {
          console.error('[PageStore] Failed to update page title:', error);
          throw error;
        }
      }),

    renamePageArtifact: async (pageId, requestedTitle, parentMutationToken) =>
      withNotebookAuthorityOperation(pageId, async () => {
        await waitForNotebookStartup();
        if (isElectron()) {
          const native = await import('./notebook-document-client');
          if (native.ownsNativeNotebookPage(pageId)) {
            const client = native.getNativeNotebookDocumentClient(pageId);
            await client.flush();
            const result = await client.command({ kind: 'rename', title: requestedTitle });
            return {
              path: result.path,
              name: result.path.split(/[\\/]/).pop() ?? result.title,
              fileKind: 'waypoint-notebook',
              sizeBytes: result.sizeBytes ?? 0,
              authorityFingerprint: result.canonicalFingerprint,
            };
          }
        }
        const workspaceRoot = await mutationRootForExistingPage(pageId);
        return withRendererWorkspaceMutation(
          workspaceRoot,
          async (mutationToken) => {
            const page = get().pages[pageId];
            if (!page) return null;

            const artifact = await renameNotebookArtifactFile({
              pageId,
              title: requestedTitle,
              content: page.content,
              mutationToken,
            });
            const title = artifact
              ? artifactStemFromFileName(artifact.name, 'notebook')
              : requestedTitle;
            let published = artifact;
            if (!published) {
              published = await writeNotebookArtifactSnapshot({
                pageId,
                title,
                content: page.content,
                workspaceRoot,
                mutationToken,
                expectedProjectionContent: page.content,
              });
            }

            const now = Date.now();
            await persistNotebookPageProjection({
              pageId,
              title,
              content: page.content,
              workspaceRoot,
              artifact: published,
              expectedProjectionFingerprint: notebookProjectionFingerprint(
                page.title,
                page.content
              ),
              mutationToken,
              now,
            });
            set((state) => ({
              pages: {
                ...state.pages,
                [pageId]: { ...page, title, updatedAt: new Date(now) },
              },
              pageList: state.pageList.map((item) =>
                item.id === pageId ? { ...item, title, updatedAt: new Date(now) } : item
              ),
            }));
            return artifact;
          },
          parentMutationToken
        );
      }),

    upsertPageFromArtifact: async (input) => {
      await waitForNotebookStartup();
      const { id, title, content: incoming } = input;
      const workspaceRoot = input.workspaceRoot ?? (await owningRootForPage(id));
      return withRendererWorkspaceMutation(
        workspaceRoot,
        async (mutationToken) => {
          const repair = workspaceRoot
            ? await repairPageReferences(incoming, workspaceRoot)
            : { content: incoming, repaired: 0, skipped: [], changed: false };
          const content = normalizeNotebookReferences(
            repair.changed ? (repair.content as JSONContent) : incoming
          );
          if (repair.changed) {
            console.info(
              `[PageStore] repaired ${repair.repaired} legacy reference(s) in ${id}` +
                (repair.skipped.length ? `; ${repair.skipped.length} left alone` : '')
            );
          }

          const now = Date.now();
          const db = platform().db;
          const rows = await db.select<
            Array<{
              id: string;
              title: string;
              content: string;
              date: number | null;
              created_at: number;
              updated_at: number;
            }>
          >('SELECT * FROM pages WHERE id = ?', [id]);

          if (
            !repair.changed &&
            rows[0]?.title === title &&
            rows[0].content === JSON.stringify(content)
          ) {
            const page = rowToPage(rows[0]);
            const listItem = rowToListItem(rows[0]);
            set((state) => ({
              pages: { ...state.pages, [id]: page },
              pageList: [listItem, ...state.pageList.filter((item) => item.id !== id)],
            }));
            return true;
          }

          const published = repair.changed
            ? await writeNotebookArtifactSnapshot({
                pageId: id,
                title,
                content,
                workspaceRoot,
                mutationToken,
                expectedCanonicalFingerprint: input.authorityFingerprint,
                expectedProjectionContent: incoming,
              })
            : null;
          const binding = published ? null : await getCurrentCatalogFileForEntity(id);
          const artifact =
            published ??
            (binding?.file_kind === 'waypoint-notebook'
              ? {
                  path: binding.path,
                  name: binding.path.split('/').pop() ?? binding.path,
                  fileKind: binding.file_kind,
                  sizeBytes: 0,
                  authorityFingerprint: input.authorityFingerprint,
                }
              : null);
          await persistNotebookPageProjection({
            pageId: id,
            title,
            content,
            workspaceRoot,
            artifact,
            expectedProjectionFingerprint: rows[0]
              ? notebookProjectionFingerprint(rows[0].title, rows[0].content)
              : null,
            now,
            mutationToken,
          });

          const page: Page = {
            id,
            title,
            content,
            date: null,
            createdAt: new Date(now),
            updatedAt: new Date(now),
          };
          set((state) => ({
            pages: { ...state.pages, [id]: page },
            pageList: [
              { id, title, date: null, createdAt: new Date(now), updatedAt: new Date(now) },
              ...state.pageList.filter((item) => item.id !== id),
            ],
          }));

          repairCheckedPages.add(id);
          return !repair.changed;
        },
        input.mutationToken
      );
    },

    createPage: async (title = 'Untitled', explicitId?: string, parentMutationToken?: string) => {
      await waitForNotebookStartup();

      const candidateId = explicitId ?? generateId();
      const artifactOwner = await resolveNotebookArtifactWorkspaceOwner(candidateId);
      if (artifactOwner.status === 'invalid-binding')
        throw new Error('The notebook has an invalid owning project binding.');
      const workspaceRoot =
        artifactOwner.status === 'bound'
          ? artifactOwner.workspaceRoot
          : explicitId && !hasWorkspaceScope(explicitId)
            ? null
            : ((await owningRootForPage(candidateId)) ?? activeWorkspaceRoot());
      const scope = workspaceRoot ? await resolveWorkspaceScope(workspaceRoot) : null;
      const id = workspaceRoot ? scopedProjectionId(scope, candidateId) : candidateId;
      const now = Date.now();

      const newPage: Page = {
        id,
        title,
        content: defaultContent,
        date: null,
        createdAt: new Date(now),
        updatedAt: new Date(now),
      };

      try {
        return await withRendererWorkspaceMutation(
          workspaceRoot,
          async (mutationToken) => {
            const artifact = workspaceRoot
              ? await writeNotebookArtifactSnapshot({
                  pageId: id,
                  title,
                  content: defaultContent,
                  workspaceRoot,
                  mutationToken,
                })
              : null;
            if (workspaceRoot && !artifact)
              throw new Error('The notebook could not be published to its owning project.');
            await persistNotebookPageProjection({
              pageId: id,
              title,
              content: defaultContent,
              workspaceRoot,
              artifact,
              expectedProjectionFingerprint: null,
              now,
              mutationToken,
            });

            set((state) => ({
              pages: { ...state.pages, [id]: newPage },
              pageList: [
                { id, title, date: null, createdAt: new Date(now), updatedAt: new Date(now) },
                ...state.pageList,
              ],
              initialized: true,
              listLoaded: true,
              listError: null,
            }));

            console.log('[PageStore] Created page:', id);
            return id;
          },
          parentMutationToken
        );
      } catch (error) {
        console.error('[PageStore] Failed to create page:', error);
        throw error;
      }
    },

    deletePage: async (pageId) => {
      await waitForNotebookStartup();
      try {
        const workspaceRoot = await mutationRootForExistingPage(pageId);
        await withRendererWorkspaceMutation(workspaceRoot, async (mutationToken) => {
          const deletedFile = await trashNotebookArtifactForPage(pageId, mutationToken);
          if (!deletedFile)
            await platform().db.mutateLegacyNotebookPage(
              { operation: 'delete', id: pageId },
              mutationToken
            );

          set((state) => {
            const { [pageId]: _, ...rest } = state.pages;
            return {
              pages: rest,
              pageList: state.pageList.filter((p) => p.id !== pageId),
            };
          });
        });

        console.log('[PageStore] Deleted page:', pageId);
      } catch (error) {
        console.error('[PageStore] Failed to delete page:', error);
        throw error;
      }
    },

    ensureReferencesRepaired: async (pageId) => {
      if (!get().initialized) await get().initialize();
      const page = get().pages[pageId] ?? (await get().fetchPage(pageId));
      if (!page) return undefined;
      return (await repairIfNeeded(pageId, page, set, get)).committedFingerprint;
    },

    setDirty: (pageId, isDirty) => {
      set((state) => {
        if (state.dirtyIds.has(pageId) === isDirty) return state;
        const newDirtyIds = new Set(state.dirtyIds);
        if (isDirty) newDirtyIds.add(pageId);
        else newDirtyIds.delete(pageId);
        return { dirtyIds: newDirtyIds };
      });
    },

    getPageIds: () => {
      return get().pageList.map((p) => p.id);
    },

    isPageLoading: (pageId) => {
      return get().loadingIds.has(pageId);
    },
  }))
);

const unsubscribeNotebookDocumentProjection = subscribeNotebookDocumentProjection((snapshot) => {
  const pageId = snapshot.documentId,
    page = usePageStore.getState().pages[pageId];
  if (
    page &&
    (!snapshot.dirty || page.title !== snapshot.title) &&
    (page.title !== snapshot.title ||
      canonicalNotebookJson(page.content) !== canonicalNotebookJson(snapshot.copy.content))
  )
    usePageStore.setState((state) => ({
      pages: {
        ...state.pages,
        [pageId]: {
          ...page,
          title: snapshot.title,
          content: snapshot.dirty ? page.content : snapshot.copy.content,
          updatedAt: snapshot.updatedAt ? new Date(snapshot.updatedAt) : page.updatedAt,
        },
      },
      pageList: state.pageList.map((item) =>
        item.id === pageId
          ? {
              ...item,
              title: snapshot.title,
              updatedAt: snapshot.updatedAt ? new Date(snapshot.updatedAt) : item.updatedAt,
            }
          : item
      ),
    }));
});

if (import.meta.hot) import.meta.hot.dispose(unsubscribeNotebookDocumentProjection);

const repairCheckedPages = new Set<string>();

interface ReferenceRepairResult {
  page: Page;
  committedFingerprint?: string;
}

async function repairIfNeeded(
  pageId: string,
  page: Page,
  set: (fn: (state: PageStore) => Partial<PageStore>) => void,
  get: () => PageStore
): Promise<ReferenceRepairResult> {
  if (repairCheckedPages.has(pageId)) return { page };
  const repair = await repairPageReferences(page.content, await owningRootForPage(pageId));
  if (!repair.changed) {
    repairCheckedPages.add(pageId);
    return { page };
  }

  const repaired = { ...page, content: repair.content as JSONContent };
  console.info(
    `[PageStore] repaired ${repair.repaired} legacy reference(s) in ${pageId}` +
      (repair.skipped.length ? `; ${repair.skipped.length} left alone` : '')
  );

  try {
    const committedFingerprint = await get().savePage(pageId, repaired.content);
    repairCheckedPages.add(pageId);
    return { page: get().pages[pageId] ?? repaired, committedFingerprint };
  } catch (err) {
    console.warn('[PageStore] could not persist reference repair', err);
    repairCheckedPages.delete(pageId);
    set((state) => ({
      pages: { ...state.pages, [pageId]: repaired },
      dirtyIds: new Set([...state.dirtyIds, pageId]),
    }));
    return { page: repaired };
  }
}

function activeWorkspaceRoot(): string | null {
  const { folders, selectedPath } = useWorkspaceStore.getState();
  return resolveActiveImportRoot({ folders, selectedPath });
}

async function owningRootForPage(pageId: string): Promise<string | null> {
  const { folders } = useWorkspaceStore.getState();
  return resolveOwningRootForPage({
    pageId,
    roots: folders,
    resolveScope: resolveWorkspaceScope,
  });
}

async function mutationRootForExistingPage(pageId: string): Promise<string | null> {
  const artifactOwner = await resolveNotebookArtifactWorkspaceOwner(pageId);
  if (artifactOwner.status === 'bound') return artifactOwner.workspaceRoot;
  if (artifactOwner.status === 'invalid-binding') {
    throw new Error(
      `PAGE_WORKSPACE_OWNER_INVALID: notebook ${pageId} has an unusable catalog binding at ${artifactOwner.path}`
    );
  }
  return hasWorkspaceScope(pageId) ? owningRootForPage(pageId) : null;
}

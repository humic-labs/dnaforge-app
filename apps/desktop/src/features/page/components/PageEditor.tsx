import { NotebookWorkControl } from './NotebookWorkControl';
import { Button } from '../../../components/ui';
import { useNotebookConflictStore } from '../notebook-conflict-store';
import { toUserMessage, userMessage } from '@waypoint/user-messages';
import {
  getNativeNotebookDocumentClient,
  nativeNotebookHistoryExtension,
  type NativeNotebookDocumentClient,
} from '../notebook-document-client';
import { isElectron } from '../../../utils/environment';
import { useEffect, useState, useMemo, useCallback, useRef, useSyncExternalStore } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import type { JSONContent, Editor } from '@tiptap/core';

import {
  getBaseExtensions,
  MentionExtension,
  SlashCommandsExtension,
  EmbedNode,
  builtInCommands,
} from '../editor/extensions';
import { FlowManagerProvider, useFlowManager } from '../editor/flows';

import '../embeds';
import { embedRegistry } from '../embeds/registry';
import { usePageStore } from '../store';
import { registerNotebookEditorControl } from '../notebook-editor-control';
import { useStableRef } from '../hooks/useStableRef';
import { useEditorAutosave } from '../hooks/useEditorAutosave';
import { useNotebookCloseRequests } from '../hooks/useNotebookCloseRequests';
import {
  bindTableNotebookSource,
  captureTableNotebookDocumentUpdate,
  requireNotebookCommitFingerprint,
  retireTableNotebookSource,
} from '../embeds/table/notebook-observation';
import { useNotebookEditorHydration } from '../hooks/useNotebookEditorHydration';
import { captureNotebookDocumentUpdate, retireNotebookDocumentSource } from '../notebook-workflow';
import { useNotebookFileWatcher } from '../hooks/useNotebookFileWatcher';
import { isExternalConflictError } from '../notebook-external-conflict';
import { useSmoothVerticalScroll } from '../hooks/useSmoothVerticalScroll';
import { useCanvasStore } from '../../canvas/public/store';
import { PageSkeleton } from './PageSkeleton';
import { FormattingToolbar } from './FormattingToolbar';
import { RelativeSavedLabel } from './RelativeSavedLabel';
import { NotebookSyncStatus } from './NotebookSyncStatus';
import {
  ReferenceContextProvider,
  useOptionalReferenceContext,
} from '../entity-ref/reference-context';
import { resolveItemRecord } from '../entity-ref/resolve-item-record';
import { getCurrentCatalogFileForEntity } from '../../../db/workspace-catalog';
import { platform } from '../../../platform';
import { isProviderObjectClass } from '../../../shared/provider-object-reference';
import { useOwningReferenceContext } from '../entity-ref/useOwningReferenceContext';
import { ErrorBoundary } from '@/shared/components/ErrorBoundary';
import type { PageEditorProps } from '../types';
import {
  dispatchOpenNativeEntityReference,
  isNewTabClick,
  nativeEntityReferenceIdFromElement,
  openImportedProviderReference,
} from '../editor/native-entity-links';
import {
  BenchlingExternalLinkMarkerExtension,
  refreshBenchlingExternalLinkDecorations,
} from '../editor/benchling-external-link-marker';
import {
  getReferenceGeneration,
  subscribeToReferenceGeneration,
} from '../entity-ref/reference-generation';
import { NotebookSourceDetailsControl, useNotebookSourceDetails } from './NotebookSourceDetails';
import {
  openNotebookReferenceLink,
  savedMolecularViewReferenceIdFromHref,
} from '../editor/saved-molecular-view-link';
import { useToastStore } from '../../../stores/toast-store';
import { fingerprintText, useUnsavedDraftRecovery } from '../../../shared/unsaved-draft-recovery';

function openImportedProviderReferenceFromAnchor(
  anchor: Element | null,
  event: MouseEvent,
  referenceContext: { owningRoot: string | null } | null
): boolean {
  const stableObjectId = anchor?.getAttribute('data-provider-stable-id')?.trim();
  const objectClass = anchor?.getAttribute('data-provider-object-class')?.trim();
  const owningRoot = referenceContext?.owningRoot ?? null;

  if (!stableObjectId || !isProviderObjectClass(objectClass) || !owningRoot) return false;

  if (isNewTabClick(event)) return false;

  event.preventDefault();
  void openImportedProviderReference({
    stableObjectId,
    objectClass,
    href: anchor?.getAttribute('href') ?? null,
    label: anchor?.textContent?.trim() || stableObjectId,
    owningRoot,
  });
  return true;
}

function findTabForPage(
  panels: Record<string, { tabs: Array<{ id: string; type: string; entityId: string }> }>,
  pageId: string
): { panelId: string; tabId: string } | null {
  for (const [panelId, panel] of Object.entries(panels)) {
    const tab = panel.tabs.find((t) => t.type === 'page' && t.entityId === pageId);
    if (tab) {
      return { panelId, tabId: tab.id };
    }
  }
  return null;
}

export function PageEditor({ pageId, canvasTabId }: PageEditorProps) {
  const initialized = usePageStore((state) => state.initialized);
  const error = usePageStore((state) => state.listError);
  if (initialized === false) {
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-3 p-6 text-sm text-fg-muted"
        data-testid="notebook-startup-status"
        role={error ? 'alert' : 'status'}
      >
        <p>
          {error
            ? toUserMessage(error, 'failure.could-not-load-notebooks')
            : userMessage('failure.loading-notebooks')}
        </p>
        {error && (
          <button
            className="rounded border border-border px-3 py-2"
            onClick={() => void usePageStore.getState().initialize()}
          >
            Retry notebooks
          </button>
        )}
      </div>
    );
  }
  return (
    <ErrorBoundary>
      {}
      <PageReferenceScope pageId={pageId}>
        <FlowManagerProvider>
          <PageEditorMode pageId={pageId} canvasTabId={canvasTabId} />
        </FlowManagerProvider>
      </PageReferenceScope>
    </ErrorBoundary>
  );
}

function PageReferenceScope({ pageId, children }: { pageId: string; children: React.ReactNode }) {
  const referenceContext = useOwningReferenceContext(pageId);
  const pageReferenceContext = useMemo(
    () => (referenceContext ? { ...referenceContext, pageId } : null),
    [pageId, referenceContext]
  );
  return (
    <ReferenceContextProvider value={pageReferenceContext}>{children}</ReferenceContextProvider>
  );
}

function PageEditorMode({ pageId, canvasTabId }: PageEditorProps) {
  const nativeClient = useMemo(
    () => (isElectron() ? getNativeNotebookDocumentClient(pageId) : null),
    [pageId]
  );
  const databaseOnly = useSyncExternalStore(
    nativeClient?.subscribe ?? (() => () => {}),
    () => nativeClient?.databaseOnly ?? false,
    () => nativeClient?.databaseOnly ?? false
  );
  return (
    <PageEditorInner
      key={databaseOnly ? 'database' : 'native'}
      pageId={pageId}
      canvasTabId={canvasTabId}
      nativeNotebook={databaseOnly ? null : nativeClient}
    />
  );
}

function PageEditorInner({
  pageId,
  canvasTabId,
  nativeNotebook,
}: PageEditorProps & { nativeNotebook: NativeNotebookDocumentClient | null }) {
  const nativeNotebookRef = useStableRef(nativeNotebook);
  const nativeStatus = useSyncExternalStore(
    nativeNotebook?.subscribe ?? (() => () => {}),
    () => nativeNotebook?.statusKey ?? 'browser',
    () => nativeNotebook?.statusKey ?? 'browser'
  );
  void nativeStatus;
  const { pages, dirtyIds, fetchPage, savePage, setDirty, ensureReferencesRepaired } =
    usePageStore();
  const { panels, updateTab } = useCanvasStore();
  const { startFlow, setEditor } = useFlowManager();

  const referenceContext = useOptionalReferenceContext();
  const referenceContextRef = useStableRef(referenceContext);
  const referencePageIdRef = useStableRef(pageId);
  const referenceGeneration = useSyncExternalStore(
    subscribeToReferenceGeneration,
    getReferenceGeneration,
    getReferenceGeneration
  );

  const page = pages[pageId];
  const [isLoading, setIsLoading] = useState(!page);
  const sourceDetails = useNotebookSourceDetails(pageId);

  const setDirtyRef = useStableRef(setDirty);
  const panelsRef = useStableRef(panels);
  const updateTabRef = useStableRef(updateTab);
  const startFlowRef = useStableRef(startFlow);

  const contentRef = useRef<JSONContent | null>(page?.content ?? null);
  const inputRevision = useRef(0);
  const editorRef = useRef<Editor | null>(null);
  const refreshBenchlingMarkersRef = useRef<() => void>(() => undefined);
  const referenceRepairPromiseRef = useRef<Promise<void>>(Promise.resolve());

  const scrollPaneRef = useRef<HTMLDivElement>(null);
  useSmoothVerticalScroll(scrollPaneRef, !isLoading);

  useEffect(() => {
    if (!page) {
      setIsLoading(true);
      fetchPage(pageId).finally(() => setIsLoading(false));
    }
  }, [pageId, page, fetchPage]);

  const extensions = useMemo(
    () => [
      ...getBaseExtensions("Start typing, or press '/' for commands...", Boolean(nativeNotebook)),
      ...(nativeNotebook ? [nativeNotebookHistoryExtension(() => nativeNotebookRef.current)] : []),
      BenchlingExternalLinkMarkerExtension,
      MentionExtension.configure({
        onMentionClick: (attrs) => {
          window.dispatchEvent(new CustomEvent('waypoint:open-entity', { detail: attrs }));
        },
        onCreatePage: null,

        referenceWorkspaceRoot: () => referenceContextRef.current?.owningRoot ?? null,
        referenceNotebookPageId: () => referencePageIdRef.current,

        resolveReferenceRecord: (item) =>
          resolveItemRecord(item, referenceContextRef.current, {
            lookupCatalogFile: getCurrentCatalogFileForEntity,
            contentHash: (input) => platform().fs.contentHash(input),
          }),
      }),
      SlashCommandsExtension.configure({
        commands: [...builtInCommands, ...embedRegistry.getSlashCommands()],
        onFlowCommand: (command) => {
          if (command.flowName && editorRef.current) {
            const { from } = editorRef.current.state.selection;
            startFlowRef.current(command.flowName, from);
          }
        },
      }),
      EmbedNode,
    ],
    []
  );

  const handleDirtyTransition = useCallback((id: string) => {
    setDirtyRef.current(id, true);
  }, []);

  const handleSaved = useCallback((id: string) => {
    setDirtyRef.current(id, false);
    const tabInfo = findTabForPage(panelsRef.current, id);
    if (tabInfo) {
      const title = usePageStore.getState().pages[id]?.title;
      updateTabRef.current(tabInfo.panelId, tabInfo.tabId, {
        ...(title ? { label: title } : {}),
      });
    }
  }, []);

  const discardPendingChangesRef = useRef<(() => void) | null>(null);
  const tableSourceOwnerRef = useRef<Parameters<typeof retireTableNotebookSource>[0]>(null);

  const notebookWatcher = useNotebookFileWatcher({
    pageId,
    workspaceRoot: referenceContext?.owningRoot ?? null,
    isDirty: dirtyIds.has(pageId),
    onKeepLocal: nativeNotebook
      ? async (expectedCanonicalFingerprint) => {
          await nativeNotebook.command({ kind: 'keep-local', expectedCanonicalFingerprint });
        }
      : undefined,
    onReload: (content) => {
      if (nativeNotebookRef.current) {
        const client = nativeNotebookRef.current;
        void (client.dirty ? client.discard() : client.command({ kind: 'inspect-copy' })).catch(
          (error) =>
            useToastStore
              .getState()
              .addToast(toUserMessage(error, 'failure.the-notebook-could-not-reload'), {
                definition: 'native-notebook-reload-failed',
              })
        );
        return;
      }
      retireTableNotebookSource(tableSourceOwnerRef.current);
      retireNotebookDocumentSource(tableSourceOwnerRef.current, 'discarded');
      contentRef.current = content;
      discardPendingChangesRef.current?.();
      handleSaved(pageId);
    },
  });
  const { expectedCanonicalFingerprint, recordOwnSave, reportSaveConflict } = notebookWatcher;

  useEffect(() => {
    let disposed = false;
    const repair = ensureReferencesRepaired(pageId)
      .then((committedFingerprint) => {
        if (!disposed && committedFingerprint) {
          recordOwnSave(committedFingerprint);
        }
      })
      .catch((error) => {
        console.warn('[PageEditor] legacy reference repair failed', error);
      });
    referenceRepairPromiseRef.current = repair;
    return () => {
      disposed = true;
    };
  }, [ensureReferencesRepaired, pageId, recordOwnSave]);

  const handleSaveRef = useStableRef(
    useCallback(
      async (content: JSONContent, targetPageId: string) => {
        try {
          const client = nativeNotebookRef.current;
          if (client) {
            const saved = await client.save(referenceRepairPromiseRef.current);
            if (!saved && client.lastCommandError) throw client.lastCommandError;
            recordOwnSave(client.snapshot?.canonicalFingerprint);
            return saved;
          }
          await referenceRepairPromiseRef.current;
          const committedFingerprint = await savePage(targetPageId, content, {
            expectedCanonicalFingerprint: expectedCanonicalFingerprint(),
            preserveDirtyState: true,
          });
          requireNotebookCommitFingerprint(committedFingerprint);
          recordOwnSave(committedFingerprint);
        } catch (error) {
          if (isExternalConflictError(error)) await reportSaveConflict();
          throw error;
        }
      },
      [expectedCanonicalFingerprint, recordOwnSave, reportSaveConflict, savePage]
    )
  );

  const {
    saveStatus,
    markDirty,
    ensureDirtySaveScheduled,
    saveNow,
    discardPendingChanges,
    acceptOwnerClean,
    retirePendingChanges,
  } = useEditorAutosave({
    pageId,
    workspaceRoot: referenceContext?.owningRoot,
    contentRef,
    onSave: useCallback((content, id) => handleSaveRef.current(content, id), [handleSaveRef]),
    onDirtyTransition: handleDirtyTransition,
    onSaved: handleSaved,
    debounceMs: 1000,
    nativeOwner: Boolean(nativeNotebook),
  });
  discardPendingChangesRef.current = discardPendingChanges;
  const isSaving = nativeNotebook ? nativeNotebook.saving : saveStatus === 'saving';
  const hasUnsavedChanges = nativeNotebook ? nativeNotebook.dirty : saveStatus !== 'clean';

  const recoveryBaseline = useMemo(
    () => (page ? fingerprintText(JSON.stringify(page.content ?? null)) : null),
    [page]
  );
  const { recordDraft } = useUnsavedDraftRecovery<JSONContent>({
    key: page && !nativeNotebook ? `page:${pageId}` : null,
    name: page?.title || 'This page',
    baseline: recoveryBaseline,
    dirty: hasUnsavedChanges,
    discardTarget: { kind: 'page', pageId },
    onRestore: (content) => {
      editor?.commands.setContent(content, { emitUpdate: true });
    },
  });

  const editor = useEditor({
    extensions,
    content: page?.content,
    editable: !nativeNotebook,
    editorProps: {
      attributes: {
        class: 'prose prose-sm max-w-none focus:outline-none min-h-full px-4 py-2',
      },
      handleClick: (_view, _position, event) => {
        const target = event.target;
        const nativeEntityId = nativeEntityReferenceIdFromElement(
          target instanceof Element ? target : null
        );
        const anchor = target instanceof Element ? target.closest('a[href]') : null;
        const savedViewHref = anchor?.getAttribute('href') ?? null;
        if (savedViewHref && savedMolecularViewReferenceIdFromHref(savedViewHref)) {
          event.preventDefault();
          void openNotebookReferenceLink(savedViewHref, pageId).catch((error: unknown) => {
            useToastStore
              .getState()
              .addToast(toUserMessage(error, 'failure.could-not-open-notebook-reference'), {
                definition: 'page-molecular-view-open-failed',
              });
          });
          return true;
        }
        if (!nativeEntityId) {
          return openImportedProviderReferenceFromAnchor(
            anchor,
            event,
            referenceContextRef.current
          );
        }
        event.preventDefault();
        dispatchOpenNativeEntityReference({
          entityId: nativeEntityId,
          label: anchor?.textContent?.trim() || nativeEntityId,
          owningRoot: referenceContextRef.current?.owningRoot ?? null,
        });
        return true;
      },
    },
    onUpdate: ({ editor, transaction }) => {
      if (nativeNotebookRef.current && !nativeNotebookRef.current.ready) return;
      inputRevision.current++;
      notebookWatcher.recordLocalEdit();
      contentRef.current = editor.getJSON();
      captureNotebookDocumentUpdate({
        owner: editor,
        transaction,
        pageId,
        workspaceRoot: referenceContextRef.current?.owningRoot ?? null,
        content: contentRef.current,
      });
      captureTableNotebookDocumentUpdate({
        owner: editor,
        transaction,
        pageId,
        workspaceRoot: referenceContextRef.current?.owningRoot ?? null,
        content: contentRef.current,
      });
      markDirty();
      if (nativeNotebookRef.current)
        nativeNotebookRef.current.capture(transaction, contentRef.current);
      else recordDraft(contentRef.current);
    },
  });

  useEffect(() => {
    if (!nativeNotebook || !editor) return;
    const detach = nativeNotebook.attach(editor, retirePendingChanges);
    void nativeNotebook.initialize(referenceRepairPromiseRef.current).catch((error) => {
      if (nativeNotebook.databaseOnly) return;
      useToastStore
        .getState()
        .addToast(toUserMessage(error, 'failure.the-notebook-owner-could-not-load'), {
          definition: 'native-notebook-load-failed',
        });
    });
    return detach;
  }, [nativeNotebook, editor, retirePendingChanges]);
  useEffect(() => {
    if (!nativeNotebook) return;
    return nativeNotebook.subscribe(() => {
      const snapshot = nativeNotebook.snapshot;
      if (!snapshot) return;
      if (
        !nativeNotebook.hasPending &&
        (!contentRef.current ||
          JSON.stringify(contentRef.current) !== JSON.stringify(snapshot.copy.content))
      )
        contentRef.current = snapshot.copy.content;
      if (nativeNotebook.saving) return;
      if (nativeNotebook.dirty) {
        if (!usePageStore.getState().dirtyIds.has(pageId)) handleDirtyTransition(pageId);
        if (!snapshot.recovery && !nativeNotebook.lastCommandError) ensureDirtySaveScheduled();
      } else {
        acceptOwnerClean();
        handleSaved(pageId);
      }
    });
  }, [
    nativeNotebook,
    pageId,
    handleSaved,
    handleDirtyTransition,
    ensureDirtySaveScheduled,
    acceptOwnerClean,
  ]);

  useEffect(() => {
    const root = referenceContext?.owningRoot;
    tableSourceOwnerRef.current = editor;
    if (editor && root) bindTableNotebookSource(editor, pageId, root);
  }, [editor, pageId, referenceContext?.owningRoot]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    let disposed = false;
    const refresh = (): void => {
      void refreshBenchlingExternalLinkDecorations({
        editor,
        owningRoot: referenceContext?.owningRoot ?? null,
        generation: referenceGeneration,
        isCurrent: () => !disposed && !editor.isDestroyed,
      });
    };
    refreshBenchlingMarkersRef.current = refresh;
    refresh();
    editor.on('update', refresh);
    return () => {
      disposed = true;
      if (refreshBenchlingMarkersRef.current === refresh) {
        refreshBenchlingMarkersRef.current = () => undefined;
      }
      editor.off('update', refresh);
    };
  }, [editor, referenceContext?.owningRoot, referenceGeneration]);

  useEffect(() => {
    if (!editor) return;
    return registerNotebookEditorControl(pageId, { editor, save: saveNow });
  }, [pageId, editor, saveNow]);

  useEffect(() => {
    editorRef.current = editor;
    setEditor(editor);
  }, [editor, setEditor]);

  useNotebookEditorHydration({
    editor,
    content: page?.content,
    blocked: hasUnsavedChanges || Boolean(nativeNotebook),
    canApply: () => !usePageStore.getState().dirtyIds.has(pageId),
    onHydrated: () => {
      window.requestAnimationFrame(() => refreshBenchlingMarkersRef.current());
    },
  });

  const discardNotebookChanges = useCallback(async () => {
    if (nativeNotebook) {
      try {
        await nativeNotebook.discard();
        discardPendingChanges();
        contentRef.current = nativeNotebook.snapshot?.copy.content ?? null;
        handleSaved(pageId);
      } catch (error) {
        useToastStore
          .getState()
          .addToast(toUserMessage(error, 'failure.the-notebook-could-not-be-discarded'), {
            definition: 'native-notebook-discard-failed',
          });
        throw error;
      }
      return;
    }
    retireTableNotebookSource(tableSourceOwnerRef.current);
    retireNotebookDocumentSource(tableSourceOwnerRef.current, 'discarded');
    discardPendingChanges();
    contentRef.current = usePageStore.getState().pages[pageId]?.content ?? null;
    handleSaved(pageId);
  }, [discardPendingChanges, handleSaved, pageId, nativeNotebook]);
  useNotebookCloseRequests({
    pageId,
    tabId: canvasTabId,
    owner: editor,
    contentRef,
    readRevision: nativeNotebook?.readRevision ?? (() => inputRevision.current),
    saveNow,
    onDiscard: discardNotebookChanges,
  });

  if (isLoading) {
    return <PageSkeleton />;
  }

  if (!page) {
    return (
      <div className="h-full flex items-center justify-center p-4 text-fg-muted">
        <div className="text-center">
          <div className="text-lg font-medium">Page not found</div>
          <div className="text-sm mt-1">The page may have been deleted.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col" data-page-id={pageId}>
      {}
      <FormattingToolbar editor={editor} />

      {}
      <div className="px-4 py-1 text-xs text-fg-subtle border-b border-border flex items-center gap-2">
        {isSaving ? (
          <span className="text-fg-muted">Saving...</span>
        ) : hasUnsavedChanges ? (
          <>
            <span className="text-fg-muted">Unsaved changes</span>
            <button
              type="button"
              onClick={() => void saveNow()}
              className="text-accent hover:underline"
            >
              Save now
            </button>
          </>
        ) : (
          <RelativeSavedLabel updatedAt={page.updatedAt} />
        )}
        <NotebookSourceDetailsControl details={sourceDetails} />
        {editor && nativeNotebook?.snapshot && (
          <NotebookWorkControl key={pageId} editor={editor} client={nativeNotebook} />
        )}
        {nativeNotebook?.snapshot?.publication?.status === 'pending' && (
          <div role="status" className="flex items-center gap-2">
            <span>The notebook is saved. Its project update needs to finish.</span>
            <Button type="button" onClick={() => void saveNow()}>
              Retry project update
            </Button>
          </div>
        )}
        {nativeNotebook?.snapshot?.publication?.status === 'conflict' && (
          <div role="status" className="flex items-center gap-2">
            <span>The file and application versions need comparison before saving.</span>
            <Button type="button" onClick={() => useNotebookConflictStore.getState().open(pageId)}>
              Compare versions
            </Button>
          </div>
        )}
        <NotebookSyncStatus
          state={notebookWatcher.state}
          onReload={notebookWatcher.acceptExternalChange}
          onRetry={notebookWatcher.retryExternalReload}
          onKeepLocal={notebookWatcher.dismissExternalChange}
        />
      </div>

      {}
      <div
        ref={scrollPaneRef}
        data-testid="notebook-editor-body"
        className="notebook-editor-body flex-1 overflow-auto min-h-0"
      >
        <h1
          data-testid="notebook-title"
          className="px-8 pb-2 pt-7 text-2xl font-semibold tracking-tight text-fg"
        >
          {page.title}
        </h1>
        {nativeNotebook && !nativeNotebook.ready && !nativeNotebook.error ? (
          <PageSkeleton />
        ) : (
          <EditorContent
            editor={editor}
            className={`[&_.ProseMirror]:min-h-full ${
              sourceDetails ? 'benchling-import-notebook' : ''
            }`}
          />
        )}
      </div>
    </div>
  );
}

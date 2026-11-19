import { toUserMessage } from '@waypoint/user-messages';
import { panelContentPropsEqual } from './panel-content-props';
import { StructureTabContent } from './StructureTabContent';
import { TerminalEditorTab } from '../../terminal/public/editor-tab';
import {
  useEffect,
  useCallback,
  memo,
  useRef,
  useState,
  lazy,
  Suspense,
  type ComponentType,
} from 'react';
import { StructureInspectionTab } from '../../structure-drawer/public/components/StructureInspectionTab';
import { debugLog } from '../../../utils/debug-log';
import type { Tab } from '../types';
import { resolveTabEditor } from '../tab-editor';
import { classifyTabSession } from '../tab-document-session';
import { isLegacyChatConversationId, useCanvasStore } from '../store';
import { useChatStore } from '../../ai/public/hooks/useChat';
import { useFileContent } from '../../../hooks/useFileContent';
import {
  LegacyFastaSequencePackageNotice,
  LooseSequencePackageNotice,
} from '../../sequence/public/components/LooseSequencePackageNotice';
import { useWorkspace } from '../../../hooks/useWorkspace';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { SequenceTab } from '../../sequence/public/components/SequenceTab';
import { SequenceErrorBoundary } from '../../sequence/public/components/SequenceErrorBoundary';
import { IndexedGenomeTab } from '../../sequence/public/components/IndexedGenomeTab';
import { PageEditor } from '../../page/public';
import { TablePanel } from '../../page/public/embeds/table/components/TablePanel';
import { TextViewerTab } from '../../../components/TextViewerTab';
import { TabularFileViewerTab } from '../../../components/TabularFileViewerTab';
import { ImageViewerTab } from '../../../components/ImageViewerTab';
import { PdfTab } from '../../pdf/public/PdfTab';
import { HtmlViewerTab } from '../../../components/HtmlViewerTab';
import { ScientificDocumentTab } from '../../scientific-document/public/ScientificDocumentTab';
import { FullChatView } from '../../../components/FullChatView';
import { DesignTab } from '../../design/public/components/DesignTab';
import { AssemblyPanelContent } from '../../assembly-panel';
import { TabErrorBoundary } from './TabErrorBoundary';
import { LoadingTab, DeferredSequenceTab, MissingFileTab, ErrorFileTab } from './load-states';
import { platform } from '../../../platform';
import { isTabularDataFile } from '../../../utils/fileTypes';
import { StructureFileTabContent } from '../../structure-files/public/StructureFileTabContent';
import { ProteinSequenceTab } from '../../proteins/public/components/ProteinSequenceTab';
import { ProteinCreationTab } from '../../proteins/public/components/ProteinCreationTab';
import { PrimerCreationTab } from '../../primers/public/components/PrimerCreationTab';
import { EntityRecordTab } from '../../lims/public/EntityRecordTab';
import {
  fileBackedTabPath,
  isMissingFileError,
  isWorkspaceCoordinateFileTab,
  revalidateFileTab,
} from '../oversize-scan';
import { resolveFilePathWithFallback } from '../../../hooks/resolveFilePath';
import { resolveChatWorkspacePath } from './chat-workspace';
import { useChatPortalScrollAnchor } from '../hooks/useChatPortalScrollAnchor';
import type { AssistantHostId } from '../../ai/public/assistant-hosts';
import {
  resolveSequenceDocument,
  type ResolvedSequenceDocument,
} from '../../sequence/public/sequence-document-repository';
import { isHostedBrowserRuntime } from '../../../utils/environment';
import {
  commitReadableContent,
  failReadableContent,
} from '../../../lib/readable-content-telemetry';
import { resolveNativeFastaSourceAuthority } from '../../../services/native-catalog-destination';
import type { FastaKindReadAuthority } from '../../../shared/fasta-kind';
import { inferCatalogFileKind } from '../../../shared/catalog-file-kind';
import { LegacyMigrationFastaTab } from './LegacyMigrationFastaTab';
import { PreviewFrame } from '../../external-preview/PreviewFrame';
import { FastaKindReadStatus } from '../../../components/FastaKindReadStatus';
import { sequencePresentation } from '../../../shared/sequence-presentation';
import { EntityDetailsDrawer } from '../../entity-details/public/EntityDetails';

const SourceFileViewer = lazy(() =>
  import('../../external-preview/SourceFileViewer').then((module) => ({
    default: module.SourceFileViewer,
  }))
);

const [adjacencyGraphModule] = Object.values(
  import.meta.glob<{ AdjacencyGraphWizard: ComponentType }>(
    '../../adjacency-graph/public/wizard.ts',
    {
      eager: true,
    }
  )
);
const AdjacencyGraphWizard = adjacencyGraphModule?.AdjacencyGraphWizard;

const [loadDevAssemblyBrowser] = Object.values(
  import.meta.env.DEV
    ? import.meta.glob<{ AssemblyBrowser: ComponentType }>('../../assembly-graph/public/browser.ts')
    : {}
);

const DevAssemblyBrowser = loadDevAssemblyBrowser
  ? lazy(async () => ({ default: (await loadDevAssemblyBrowser()).AssemblyBrowser }))
  : null;

function AssemblyBrowserDevOnly() {
  if (!DevAssemblyBrowser) {
    return (
      <div className="h-full flex items-center justify-center p-6 text-center text-fg-muted">
        The internal assembly fixture browser is not available in this build.
      </div>
    );
  }

  return (
    <Suspense
      fallback={
        <div className="h-full flex items-center justify-center">
          <div className="animate-spin w-8 h-8 border-2 border-accent border-t-transparent rounded-full" />
        </div>
      }
    >
      <DevAssemblyBrowser />
    </Suspense>
  );
}

function SequenceDocumentTabContent({ tab }: { tab: Tab }) {
  const ref = tab.sequenceDocument;

  const labelHintRef = useRef(tab.label);
  labelHintRef.current = tab.label;
  const handleSourceUnavailable = useCallback(() => {
    const panel = Object.values(useCanvasStore.getState().panels).find((candidate) =>
      candidate.tabs.some((candidateTab) => candidateTab.id === tab.id)
    );
    if (panel) useCanvasStore.getState().closeTab(panel.id, tab.id);
  }, [tab.id]);
  const [hostedRevisionId, setHostedRevisionId] = useState('');
  useEffect(() => {
    if (!isHostedBrowserRuntime()) return;
    let unsubscribe = () => {};
    let cancelled = false;
    void import('../../../hosted/hydrate-session').then((mod) => {
      if (cancelled) return;
      unsubscribe = mod.subscribeHostedRevision(setHostedRevisionId);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | {
        status: 'ready';
        document: ResolvedSequenceDocument;
        authority: FastaKindReadAuthority | null;
      }
  >({ status: 'loading' });

  const hostedRetryKey = state.status === 'error' ? hostedRevisionId : '';
  useEffect(() => {
    let cancelled = false;
    if (!ref) return;
    setState((current) => (current.status === 'ready' ? current : { status: 'loading' }));
    void resolveSequenceDocument(ref)
      .catch(async (error: unknown) => {
        if (!isHostedBrowserRuntime()) throw error;
        const { resolveHostedTabDocument } = await import('../../../hosted/hydrate-session');
        const recovered =
          (await resolveHostedTabDocument(tab.sourceFileName)) ??
          (await resolveHostedTabDocument(labelHintRef.current));
        if (!recovered) throw error;
        return recovered;
      })
      .then(async (resolved) => {
        const authority =
          resolved.ref.kind === 'catalog-sequence' &&
          inferCatalogFileKind(resolved.sourcePath) === 'fasta'
            ? await resolveNativeFastaSourceAuthority(resolved.sourcePath)
            : null;
        if (authority?.status === 'declared' && authority.kind !== 'sequence')
          throw new Error(
            'The current FASTA is not a DNA sequence. Open its native destination again.'
          );
        return { resolved, authority };
      })
      .then(
        ({ resolved, authority }) => {
          if (cancelled) return;
          setState({ status: 'ready', document: resolved, authority });
          if (resolved.name && resolved.name !== labelHintRef.current) {
            useCanvasStore.getState().updateTabByEntityId(tab.entityId, { label: resolved.name });
          }
          if (
            tab.entityId !== resolved.documentId ||
            JSON.stringify(ref) !== JSON.stringify(resolved.ref)
          ) {
            useCanvasStore.getState().retargetTabsByEntityId(tab.entityId, {
              type: 'sequence',
              sequenceDocument: resolved.ref,
            });
          }
        },
        (error: unknown) => {
          if (!cancelled) {
            setState({
              status: 'error',
              message: toUserMessage(error, 'failure.the-sequence-document-could-not-open'),
            });
          }
        }
      );
    return () => {
      cancelled = true;
    };
  }, [ref, tab.entityId, tab.sourceFileName, hostedRetryKey]);

  if (!ref || state.status === 'error') {
    return (
      <div className="h-full flex items-center justify-center p-6 text-sm text-fg-muted">
        {state.status === 'error'
          ? toUserMessage(state.message, 'operation.failed')
          : 'The sequence document reference is missing.'}
      </div>
    );
  }
  if (state.status === 'loading') return <LoadingTab />;
  const legacyAuthority =
    state.authority && state.authority.status !== 'declared' ? state.authority : null;
  if (legacyAuthority?.legacyReadView === 'protein')
    return (
      <ProteinSequenceTab
        entityId={state.document.sourcePath}
        onUnavailable={handleSourceUnavailable}
        legacyFasta={legacyAuthority}
      />
    );
  const readOnly = tab.readOnly || legacyAuthority?.readOnly;
  const sequenceTab = (
    <SequenceTab
      tabId={tab.id}
      filePath={state.document.sourcePath}
      documentRef={state.document.ref}
      presentation={sequencePresentation(tab.label)}
      readOnly={readOnly}
      quickLookSource={tab.quickLookSource}
    />
  );
  if (legacyAuthority)
    return (
      <div className="flex h-full flex-col">
        <FastaKindReadStatus authority={legacyAuthority} />
        {state.document.ref.kind === 'catalog-sequence' && (
          <LegacyFastaSequencePackageNotice
            tabId={tab.id}
            filePath={state.document.sourcePath}
            label={tab.label}
          />
        )}
        <div className="min-h-0 flex-1">{sequenceTab}</div>
      </div>
    );
  if (state.document.ref.kind !== 'catalog-sequence' || readOnly) return sequenceTab;
  return (
    <div className="flex h-full flex-col">
      <LooseSequencePackageNotice
        tabId={tab.id}
        filePath={state.document.sourcePath}
        label={tab.label}
      />
      <div className="min-h-0 flex-1">{sequenceTab}</div>
    </div>
  );
}

function FileTabContent({ filePath }: { filePath: string }) {
  const { rawContent, loading, error } = useFileContent(filePath);

  useEffect(() => {
    if (loading) return;
    if (error) {
      failReadableContent(filePath);
      return;
    }
    if (rawContent !== null && rawContent !== undefined) commitReadableContent(filePath);
  }, [error, filePath, loading, rawContent]);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-2 border-accent border-t-transparent rounded-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full flex items-center justify-center p-4">
        <div className="text-center">
          <div className="text-4xl mb-4">!</div>
          <div className="text-sm text-fg-muted">{toUserMessage(error, 'operation.failed')}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto">
      <pre className="p-4 text-xs font-mono text-fg whitespace-pre-wrap">{rawContent}</pre>
    </div>
  );
}

function ChatTabContent({
  conversationId,
  isOpen,
  isVisible,
  onOpenAssistantSources,
  onConfigureHost,
  onConversationIdChange,
  onRequestPanelFocus,
  onHistoryPinnedChange,
}: {
  conversationId: string;
  isOpen: boolean;
  isVisible: boolean;
  onOpenAssistantSources?: () => void;
  onConfigureHost?: (hostId: AssistantHostId) => void;
  onConversationIdChange?: (conversationId: string) => void;
  onRequestPanelFocus?: () => void;
  onHistoryPinnedChange?: (pinned: boolean) => void;
}) {
  const { path: workspacePath } = useWorkspace();
  const workspaceFolders = useWorkspaceStore((state) => state.folders);
  const chatWorkspacePath = resolveChatWorkspacePath(workspacePath, workspaceFolders);
  const surfaceRef = useRef<HTMLDivElement>(null);
  useChatPortalScrollAnchor(surfaceRef, conversationId);
  return (
    <div ref={surfaceRef} className="h-full min-h-0 w-full">
      <FullChatView
        workspacePath={chatWorkspacePath}
        conversationId={conversationId}
        isOpen={isOpen}
        isVisible={isVisible}
        onOpenAssistantSources={onOpenAssistantSources}
        onConfigureHost={onConfigureHost}
        onConversationIdChange={onConversationIdChange}
        onRequestPanelFocus={onRequestPanelFocus}
        onHistoryPinnedChange={onHistoryPinnedChange}
      />
    </div>
  );
}

interface PanelContentProps {
  tab: Tab | null;

  isActive?: boolean;
  panelId: string;
  onOpenAssistantSources?: () => void;
  onConfigureHost?: (hostId: AssistantHostId) => void;
  onChatHistoryPinnedChange?: (panelId: string, pinned: boolean) => void;
}

function PanelContentInternal({
  tab,
  isActive = true,
  panelId,
  onOpenAssistantSources,
  onConfigureHost,
  onChatHistoryPinnedChange,
}: PanelContentProps) {
  const closeTab = useCanvasStore((s) => s.closeTab);
  const updateTab = useCanvasStore((s) => s.updateTab);
  const findTab = useCanvasStore((s) => s.findTab);
  const oversizeScanComplete = useCanvasStore((s) => s.oversizeScanComplete);
  const isFocusedPanel = useCanvasStore((s) => s.focusedPanelId === panelId);
  const currentConversationId = useChatStore((s) => s.currentConversationId);
  const chatConversationTitle = useChatStore((state) => {
    if (!tab || tab.type !== 'chat') return null;
    const title = state.conversations.find(
      (conversation) => conversation.id === tab.entityId
    )?.title;
    return title?.trim() || null;
  });
  const focusPanel = useCanvasStore((s) => s.focusPanel);
  const requestPanelFocus = useCallback(() => focusPanel(panelId), [focusPanel, panelId]);
  const proteinTabId = tab?.type === 'protein' ? tab.id : null;
  const handleProteinUnavailable = useCallback(() => {
    if (!proteinTabId) return;
    const currentTab = useCanvasStore
      .getState()
      .panels[panelId]?.tabs.find((candidate) => candidate.id === proteinTabId);
    if (currentTab?.type === 'protein') closeTab(panelId, proteinTabId);
  }, [closeTab, panelId, proteinTabId]);
  const handleChatHistoryPinnedChange = useCallback(
    (pinned: boolean) => onChatHistoryPinnedChange?.(panelId, pinned),
    [onChatHistoryPinnedChange, panelId]
  );

  useEffect(() => {
    if (tab) {
      debugLog('[PanelContent] Tab rendered:', {
        type: tab.type,
        entityId: tab.entityId,
        tabId: tab.id,
        label: tab.label,
        loadStatus: tab.loadStatus,
      });
    }
  }, [tab]);

  useEffect(() => {
    if (!tab || !isActive) return;
    if (tab.type === 'page' || tab.type === 'design' || tab.type === 'protein') {
      commitReadableContent(tab.entityId);
    }
  }, [isActive, tab]);

  useEffect(() => {
    if (!tab || tab.type !== 'chat' || !isLegacyChatConversationId(tab.entityId)) return;

    const replacementConversationId =
      currentConversationId && !isLegacyChatConversationId(currentConversationId)
        ? currentConversationId
        : crypto.randomUUID();
    const found = useCanvasStore.getState().findTab('chat', tab.entityId);
    if (!found || found.tabId !== tab.id) return;

    useCanvasStore
      .getState()
      .retargetTab(
        found.panelId,
        found.tabId,
        { type: 'chat', entityId: replacementConversationId },
        { label: tab.label || 'New Chat' }
      );
  }, [currentConversationId, tab]);

  useEffect(() => {
    if (
      !tab ||
      tab.type !== 'chat' ||
      !chatConversationTitle ||
      tab.label === chatConversationTitle
    ) {
      return;
    }

    const currentTab = useCanvasStore
      .getState()
      .panels[panelId]?.tabs.find((candidate) => candidate.id === tab.id);
    if (!currentTab || currentTab.type !== 'chat' || currentTab.entityId !== tab.entityId) return;
    updateTab(panelId, tab.id, { label: chatConversationTitle });
  }, [chatConversationTitle, panelId, tab, updateTab]);

  const handleChatConversationChange = useCallback(
    (nextConversationId: string) => {
      if (!tab || tab.type !== 'chat' || tab.entityId === nextConversationId) return;

      const currentTab = useCanvasStore
        .getState()
        .panels[panelId]?.tabs.find((candidate) => candidate.id === tab.id);
      if (!currentTab || currentTab.type !== 'chat' || currentTab.entityId !== tab.entityId) return;

      const nextTitle = useChatStore
        .getState()
        .conversations.find((conversation) => conversation.id === nextConversationId)
        ?.title.trim();

      useCanvasStore
        .getState()
        .retargetTab(
          panelId,
          tab.id,
          { type: 'chat', entityId: nextConversationId },
          { ...(nextTitle ? { label: nextTitle } : {}) }
        );
    },
    [panelId, tab]
  );

  const retryStat = useCallback(async (currentTab: Tab) => {
    await revalidateFileTab(currentTab, {
      stat: (path) =>
        platform()
          .fs.stat(resolveFilePathWithFallback(path))
          .then((stat) => ({ size: stat.size }))
          .catch((err) => {
            if (isMissingFileError(err)) return null;
            throw err;
          }),
      resolveSequenceSource: async (ref) => (await resolveSequenceDocument(ref)).sourcePath,
      locateTabById: (tabId) => {
        const state = useCanvasStore.getState();
        for (const [currentPanelId, panel] of Object.entries(state.panels)) {
          const currentTabAtId = panel.tabs.find((candidate) => candidate.id === tabId);
          if (currentTabAtId) return { panelId: currentPanelId, tab: currentTabAtId };
        }
        return null;
      },
      updateTab: (currentPanelId, tabId, updates) => {
        useCanvasStore.getState().updateTab(currentPanelId, tabId, updates);
      },
    });
  }, []);

  const retryStructureFile = useCallback(
    async (currentTab: Tab) => {
      const filePath =
        currentTab.initialStructureAttrs?.structureArtifactRef?.artifactPath ??
        currentTab.initialStructureAttrs?.sourceId;
      if (!filePath) return;
      const found = findTab(currentTab.type, currentTab.entityId);
      const { openStructureFile } = await import('../../document-opening/public/compat');
      const nextTabId = await openStructureFile({
        filePath,
        label: currentTab.label,
        strategy: found ? { kind: 'panel', panelId: found.panelId } : { kind: 'focused' },
      });

      if (found && nextTabId && nextTabId !== found.tabId) {
        closeTab(found.panelId, found.tabId);
      }
    },
    [closeTab, findTab]
  );

  useEffect(() => {
    if (
      !tab ||
      !oversizeScanComplete ||
      tab.loadStatus !== 'pending' ||
      fileBackedTabPath(tab) === null
    ) {
      return;
    }
    void retryStat(tab);
  }, [oversizeScanComplete, retryStat, tab]);

  if (!tab) {
    return null;
  }

  const handleClose = () => {
    const found = useCanvasStore.getState().findTab(tab.type, tab.entityId);
    if (found) closeTab(found.panelId, found.tabId);
  };

  if (tab.sourceFileView) {
    return (
      <TabErrorBoundary key={tab.id} label={tab.label} onClose={handleClose}>
        <Suspense fallback={<LoadingTab />}>
          <SourceFileViewer key={tab.entityId} view={tab.sourceFileView} tabId={tab.id} />
        </Suspense>
      </TabErrorBoundary>
    );
  }

  const isFileTab =
    fileBackedTabPath(tab) !== null || (tab.type === 'sequence' && !!tab.sequenceDocument);
  const filePath = fileBackedTabPath(tab);
  if (isFileTab) {
    if (!oversizeScanComplete) {
      return (
        <TabErrorBoundary key={tab.id} label={tab.label} onClose={handleClose}>
          <LoadingTab />
        </TabErrorBoundary>
      );
    }
    if (tab.loadStatus === 'pending') {
      return (
        <TabErrorBoundary key={tab.id} label={tab.label} onClose={handleClose}>
          <LoadingTab />
        </TabErrorBoundary>
      );
    }
    const session = classifyTabSession(tab);
    if (session.kind === 'sequence' && session.editor === 'indexed') {
      return (
        <TabErrorBoundary key={tab.id} label={tab.label} onClose={handleClose}>
          <IndexedGenomeTab tab={tab} isActive={isActive} />
        </TabErrorBoundary>
      );
    }
    if (tab.loadStatus && tab.loadStatus !== 'loaded') {
      const placeholder = (() => {
        if (tab.loadStatus === 'deferred-oversized') {
          return (
            <DeferredSequenceTab
              documentLabel={tab.label}
              fileSizeBytes={tab.fileSizeBytes}
              onLoadRequest={() => {
                void (async () => {
                  if (tab.type === 'structure') {
                    await retryStructureFile(tab);
                  } else {
                    const found = useCanvasStore.getState().findTab(tab.type, tab.entityId);
                    const { openSequenceDocument } =
                      await import('../../document-opening/public/compat');
                    const strategy = found
                      ? ({ kind: 'panel', panelId: found.panelId } as const)
                      : ({ kind: 'smart' } as const);
                    if (!tab.sequenceDocument) return;
                    await openSequenceDocument(tab.sequenceDocument, {
                      label: tab.label,
                      strategy,
                    });
                  }
                })();
              }}
              onClose={handleClose}
            />
          );
        }
        if (tab.loadStatus === 'missing') {
          return (
            <MissingFileTab
              filePath={tab.type === 'sequence' ? undefined : (filePath ?? undefined)}
              displayName={tab.label}
              onClose={handleClose}
              onRetry={() => {
                void (tab.type === 'structure' ? retryStructureFile(tab) : retryStat(tab));
              }}
              onReveal={
                tab.type === 'sequence' || !filePath
                  ? undefined
                  : () => {
                      void platform().shell.revealItemInDir(filePath);
                    }
              }
            />
          );
        }

        return (
          <ErrorFileTab
            filePath={tab.type === 'sequence' ? undefined : (filePath ?? undefined)}
            displayName={tab.label}
            onClose={handleClose}
            onRetry={() => {
              void (tab.type === 'structure' ? retryStructureFile(tab) : retryStat(tab));
            }}
          />
        );
      })();
      return (
        <TabErrorBoundary key={tab.id} label={tab.label} onClose={handleClose}>
          {placeholder}
        </TabErrorBoundary>
      );
    }
  }

  const editor = resolveTabEditor(tab);
  const content = (() => {
    switch (editor.type) {
      case 'terminal':
        return (
          <TerminalEditorTab
            groupId={tab.entityId}
            active={isActive && isFocusedPanel}
            visible={isActive}
            onFocus={requestPanelFocus}
          />
        );
      case 'sequence':
        debugLog('[PanelContent] Rendering sequence tab with key:', tab.entityId);
        if (tab.sequenceDocument) {
          return (
            <SequenceErrorBoundary key={tab.entityId} documentLabel={tab.label}>
              <SequenceDocumentTabContent tab={tab} />
            </SequenceErrorBoundary>
          );
        }
        return (
          <SequenceErrorBoundary key={tab.entityId} documentLabel={tab.label}>
            <div className="h-full flex items-center justify-center p-6 text-sm text-fg-muted">
              This sequence has no logical document identity and cannot be opened.
            </div>
          </SequenceErrorBoundary>
        );

      case 'file':
        if (tab.legacyMigrationRead)
          return <LegacyMigrationFastaTab key={tab.entityId} request={tab.legacyMigrationRead} />;
        return <FileTabContent key={tab.entityId} filePath={tab.entityId} />;

      case 'chat':
        return (
          <ChatTabContent
            conversationId={tab.entityId}
            isOpen={isActive && isFocusedPanel}
            isVisible={isActive}
            onOpenAssistantSources={onOpenAssistantSources}
            onConfigureHost={onConfigureHost}
            onConversationIdChange={handleChatConversationChange}
            onRequestPanelFocus={requestPanelFocus}
            onHistoryPinnedChange={handleChatHistoryPinnedChange}
          />
        );

      case 'page':
        return <PageEditor key={tab.entityId} pageId={tab.entityId} canvasTabId={tab.id} />;

      case 'structure':
        if (tab.structureInspection) {
          return (
            <StructureInspectionTab
              inspection={tab.structureInspection}
              tabId={tab.id}
              panelId={panelId}
            />
          );
        }
        return isWorkspaceCoordinateFileTab(tab) ? (
          <StructureFileTabContent tab={tab} rendererHostId={`pane:${panelId}`} />
        ) : (
          <StructureTabContent tab={tab} panelId={panelId} isActive={isActive} />
        );

      case 'table':
        if (isTabularDataFile(tab.sourceFileName ?? tab.entityId)) {
          return (
            <TabularFileViewerTab
              key={tab.entityId}
              canvasTabId={tab.id}
              filePath={tab.entityId}
              sourceFileName={tab.sourceFileName}
              readOnly={tab.readOnly}
            />
          );
        }
        return (
          <TablePanel
            key={tab.entityId}
            tableId={tab.entityId}
            tableDocument={tab.tableDocument}
            canvasTabId={tab.id}
          />
        );

      case 'design':
        return (
          <SequenceErrorBoundary key={tab.entityId} documentLabel={tab.label}>
            <DesignTab
              key={editor.designId}
              designId={editor.designId}
              tab={tab}
              panelId={panelId}
              onExitToSequence={
                editor.packageOwned
                  ? () => useCanvasStore.getState().setSequenceAssemblyEdit(panelId, tab.id, null)
                  : undefined
              }
            />
          </SequenceErrorBoundary>
        );

      case 'assembly-panel':
        return <AssemblyPanelContent key={tab.entityId} designId={tab.entityId} />;

      case 'adjacency-graph':
        return AdjacencyGraphWizard ? (
          <AdjacencyGraphWizard key={tab.entityId} />
        ) : (
          <div className="h-full flex items-center justify-center p-6 text-center text-fg-muted">
            The assembly graph is not available in this build.
          </div>
        );

      case 'assembly-browser':
        return <AssemblyBrowserDevOnly key={tab.entityId} />;

      case 'text':
        return (
          <TextViewerTab
            key={tab.entityId}
            canvasTabId={tab.id}
            filePath={tab.entityId}
            sourceFileName={tab.sourceFileName}
            readOnly={tab.readOnly}
            textCursor={tab.viewState?.textCursor}
          />
        );

      case 'image':
        return (
          <ImageViewerTab
            key={tab.entityId}
            canvasTabId={tab.id}
            filePath={tab.entityId}
            sourceFileName={tab.sourceFileName}
          />
        );

      case 'pdf':
        return <PdfTab key={tab.id} filePath={tab.entityId} tabId={tab.id} isActive={isActive} />;

      case 'html':
        return <HtmlViewerTab key={tab.entityId} filePath={tab.entityId} />;

      case 'scientific-document':
        return (
          <ScientificDocumentTab key={tab.entityId} filePath={tab.entityId} canvasTabId={tab.id} />
        );

      case 'protein':
        return tab.artifactDocument?.kind === 'protein' ? (
          <ProteinCreationTab key={tab.entityId} tab={tab} panelId={panelId} />
        ) : (
          <ProteinSequenceTab
            canvasTabId={tab.id}
            key={tab.entityId}
            entityId={tab.entityId}
            onUnavailable={handleProteinUnavailable}
            legacyFasta={tab.legacyFasta}
          />
        );

      case 'record':
        return <EntityRecordTab key={tab.entityId} tab={tab} panelId={panelId} />;

      case 'primer':
        return <PrimerCreationTab key={tab.entityId} tab={tab} panelId={panelId} />;

      default: {
        const _exhaustive: never = editor;
        void _exhaustive;
        return (
          <div className="flex-1 flex flex-col items-center justify-center gap-1 p-4 text-center text-fg-muted">
            <span>DNAForge cannot display this tab.</span>
            <span className="text-xs text-fg-subtle">
              Close it to remove it. If it returns, the saved layout is damaged.
            </span>
          </div>
        );
      }
    }
  })();

  return (
    <TabErrorBoundary key={tab.id} label={tab.label} onClose={handleClose}>
      {tab.quickLookSource ? <PreviewFrame>{content}</PreviewFrame> : content}
      {tab.type !== 'primer' &&
      tab.viewState?.entityDetailsOpen &&
      tab.viewState.entityDetailsEntityId ? (
        <EntityDetailsDrawer
          entityId={tab.viewState.entityDetailsEntityId}
          onClose={() =>
            useCanvasStore.getState().setTabViewState(panelId, tab.id, { entityDetailsOpen: false })
          }
        />
      ) : null}
    </TabErrorBoundary>
  );
}

export const PanelContent = memo(PanelContentInternal, panelContentPropsEqual);

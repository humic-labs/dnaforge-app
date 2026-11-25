import { CHAT_FIRST_INPUT, installChatFirstHumanInputGuard } from './lib/chat-first-input';
import { toUserMessage } from '@waypoint/user-messages';
import { initDevConsole } from './shared/utils/devConsoleInit';
initDevConsole();
import { installNativeWheelMetadataSource } from '@waypoint/platform/wheel-motion';
import { installPresentationInput } from './presentation/browser-input';
const disposePresentationInput = installPresentationInput(document);
import.meta.hot?.dispose(disposePresentationInput);
const sequenceWheel = window.electronAPI?.sequenceWheel;
if (sequenceWheel?.nativeWheelMetadata) {
  const dispose = installNativeWheelMetadataSource(document, (handler) =>
    sequenceWheel.onWheelMetadata(handler)
  );
  import.meta.hot?.dispose(dispose);
}

document.documentElement.dataset.dnaforgeMacTeamIdCutoverBuild =
  __DNAFORGE_MAC_TEAM_ID_CUTOVER_RENDERER_MARKER__;
document.documentElement.dataset.dnaforgeHostedAiBuild = __DNAFORGE_HOSTED_AI_RENDERER_MARKER__;

const __searchParams__ = new URLSearchParams(window.location.search);
const __harnessMode__ = __searchParams__.has('harness');
const __importPickerDesignMode__ =
  import.meta.env.DEV && __searchParams__.get('design') === 'import-picker';
const __e2eMode__ = __searchParams__.get('e2e') === 'true';

import { initSentryRenderer } from './lib/sentry';
if (!__harnessMode__ && !__importPickerDesignMode__ && !__e2eMode__) {
  void initSentryRenderer();
}

import { installRendererErrorReporter } from './lib/renderer-error-reporter';
if (import.meta.env.PROD && !__harnessMode__ && !__importPickerDesignMode__ && !__e2eMode__) {
  installRendererErrorReporter();
}

import { installBreadcrumbCapture } from './lib/renderer-breadcrumbs';
if (import.meta.env.PROD && !__harnessMode__ && !__importPickerDesignMode__ && !__e2eMode__) {
  installBreadcrumbCapture();
}

if (import.meta.env.DEV || import.meta.env.MODE === 'test') {
  (
    window as typeof window & {
      __WAYPOINT_RENDERER_BOOTED_AT__?: number;
      __WAYPOINT_RENDERER_BUILD__?: {
        appVersion: string;
        mode: string;
        sourceFingerprint: string;
        sourceCommit: string | null;
      };
    }
  ).__WAYPOINT_RENDERER_BOOTED_AT__ = Date.now();
  (
    window as typeof window & {
      __WAYPOINT_RENDERER_BUILD__?: {
        appVersion: string;
        mode: string;
        sourceFingerprint: string;
        sourceCommit: string | null;
      };
    }
  ).__WAYPOINT_RENDERER_BUILD__ = {
    appVersion: __APP_VERSION__,
    mode: import.meta.env.MODE,
    sourceFingerprint: __WAYPOINT_BUILD_SOURCE_FINGERPRINT__,
    sourceCommit: __DNAFORGE_APP_BUILD__?.sourceCommit ?? null,
  };
}

import React from 'react';
import ReactDOM from 'react-dom/client';
import { initPlatform } from './platform';
import App from './App';
import { StartupSurface, type StartupStage } from './startup/StartupSurface';
import { prepareSequenceFonts } from './startup/sequence-fonts';
import { ErrorBoundary } from './shared/components/ErrorBoundary';
import { isBrowserOnly } from './utils/environment';
import { retainTestBridgeOperation } from './lib/test-bridge-operations';
import {
  MacTeamIdCutoverBlocker,
  shouldShowMacTeamIdCutoverBlocker,
} from './components/MacTeamIdCutoverBlocker';
import { Providers } from './shared/context';
import { CommandScopeProvider } from './commands';
import { useCanvasStore } from './features/canvas/store';
import { observeEntityViews } from './services/observe-entity-views';
import './index.css';
import type { ResidueLocation, Structure3dAttrs } from './features/page/embeds/structure3d/types';

let rendererAgentBridgeDisposer: (() => void) | null = null;
const startupDisposers: Array<() => void> = [];
if (CHAT_FIRST_INPUT) startupDisposers.push(installChatFirstHumanInputGuard(document));
function disposeRendererStartup(): void {
  for (const dispose of startupDisposers.splice(0).reverse()) dispose();
}
window.addEventListener('pagehide', disposeRendererStartup, { once: true });
if (import.meta.hot) import.meta.hot.dispose(disposeRendererStartup);

import { useSequenceStore } from './features/sequence/store';
import { useAnnotationReviewStore } from './features/sequence/annotation-review-store';
import { perfTimeAsync, perfTime, perfLog } from '@waypoint/genome-renderer';
import { platform } from './platform';
import {
  parseBinarySequenceFileAsAnnotated,
  parseTextSequenceFileAsAnnotated,
} from './shared/parse-sequence-file';
import type { JSONContent } from '@tiptap/core';
import { usePageStore } from './features/page/store';
import { assemblyDispatcher, useDesignStore } from './features/design/store';
import { hasPendingDesignArtifactMirror } from './features/design/design-artifact-mirror';
import { useRichSequenceClipboardStore } from './features/sequence-clipboard/store';
import { describeDesignAssemblyState } from './features/design/assembly-debug';
import { useSettingsStore } from './features/junction-workbench/settings';
import type { TmModel } from './shared/primer-thermodynamics/tm-model';
import { useAuthStore } from './stores/auth-store';
import type { DesktopAuthState } from './shared/auth-types';
import {
  getAnalyticsPreidentityDiagnosticsForTest,
  disposeAnalyticsPreidentityDiagnosticsForTest,
} from './lib/analytics';
import { isWorkspaceEditorInputFrozen } from './services/workspace-editor-mutation-state';
import { getTraceProbeState } from './features/sequence/tracks/trace-probe';
import { attachReadToReference } from './features/sequence/tracks/attach-read-to-reference';
import { resolveRendererAssetUrl } from './hosted/renderer-asset-url';
import { useAttachedReadsStore } from './features/sequence/tracks/attached-reads-store';
import { primerBindingToViewState } from './features/sequence/primer-binding-viewstate';
import { useStructureDrawerStore, type ResolverResult } from './features/structure-drawer';
import { getAnnotationViewportDetailAuthLifecycleSnapshot } from './features/sequence/annotation-viewport-detail-auth-worker-runtime';
import { getAlignmentAutoLoadLifecycleSnapshot } from './features/alignment-manager/panel/alignment-auto-load-registry';
import {
  residueSelectionsToCodingDnaRanges,
  selectedCodonsToResidueSelections,
  type CodingDnaSelectionRange,
  type ResidueSelection,
  type ResidueSelectionCommand,
} from '@waypoint/workspace-editor';

type PageSaveForTest = ReturnType<typeof usePageStore.getState>['savePage'];

type RendererTestWindow = Window & {
  __webglExposeForTests?: boolean;
  __test?: Record<string, unknown>;
};

if (import.meta.env.DEV || import.meta.env.MODE === 'test') {
  if (import.meta.env.MODE === 'test') {
    startupDisposers.push(disposeAnalyticsPreidentityDiagnosticsForTest);
  }
  (window as RendererTestWindow).__webglExposeForTests = true;
  const structureHoverBridgeDisposers = new Map<string, () => void>();
  const structureSelectionBridgeDisposers = new Map<string, () => void>();
  const structureHoverBridgeKey = (entityId: string, structureId: string, ownerId?: string) =>
    `${entityId}\u0000${structureId}\u0000${ownerId ?? ''}`;
  const sameStructureHoverForTestBridge = (
    a: { chain: string; position: number; compId?: string; operator?: string } | null | undefined,
    b: { chain: string; position: number; compId?: string; operator?: string } | null | undefined
  ): boolean => {
    if (!a || !b) return a === b;
    return (
      a.chain === b.chain &&
      a.position === b.position &&
      a.compId === b.compId &&
      a.operator === b.operator
    );
  };
  const resolveStructureRegistrationKeyForTestBridge = (
    structureId: string,
    expandedStructures: Record<string, { data: Structure3dAttrs }>
  ): string => {
    if (expandedStructures[structureId]) return structureId;
    return (
      Object.entries(expandedStructures).find(
        ([, entry]) =>
          entry.data.structureBinding?.structureId === structureId ||
          entry.data.structureArtifactRef?.structureId === structureId
      )?.[0] ?? structureId
    );
  };
  const resolveStructureInteractionKeyForTestBridge = (
    structureId: string,
    expandedStructures: Record<string, { data: Structure3dAttrs }>
  ): string => {
    const registrationKey = resolveStructureRegistrationKeyForTestBridge(
      structureId,
      expandedStructures
    );
    return expandedStructures[registrationKey]?.data.structureBinding?.bindingId ?? structureId;
  };

  (window as RendererTestWindow).__test = {
    hostedToolRequiresUserApproval: async (toolName: string) =>
      (
        await import('./features/ai/orchestration/hosted-policy-tools')
      ).hostedToolRequiresUserApproval(toolName),
    waitForNativeDocumentReadiness: async () =>
      (
        await import('./features/workspace/public/file-document-client')
      ).waitForNativeFileDocumentReadiness(),
    pdfReviewStateForTest: async (
      registration?: import('./features/paper-protocol-review/store').ProtocolReviewRegistration
    ) => {
      if (import.meta.env.MODE !== 'test') throw new Error('PDF controls require test mode');
      const { usePaperProtocolReviewStore } =
        await import('./features/paper-protocol-review/store');
      if (registration) usePaperProtocolReviewStore.getState().registerProtocol(registration);
      return usePaperProtocolReviewStore.getState().pdfs;
    },
    pdfTestControl: async (
      action: 'hold' | 'release' | 'fail' | 'entered' | 'reset',
      phase: import('./features/pdf/pdf-test-controls').PdfTestPhase = 'text'
    ) => {
      if (import.meta.env.MODE !== 'test') throw new Error('PDF controls require test mode');
      const controls = await import('./features/pdf/pdf-test-controls');
      if (action === 'hold') controls.holdPdfPhase(phase);
      if (action === 'release') controls.releasePdfPhase(phase);
      if (action === 'fail') controls.failPdfPhaseOnce(phase);
      if (action === 'reset') controls.resetPdfTestControls();
      return controls.pdfPhaseEntered(phase);
    },
    analyticsPreidentity: () => getAnalyticsPreidentityDiagnosticsForTest(),
    setAnalyticsConsent: async (enabled: boolean) => {
      const choice = await import('./lib/usage-analytics-setting-source');
      await choice.setUsageAnalyticsChoice(enabled);
      return (await choice.readUsageAnalyticsChoice()) === enabled;
    },
    openChatTab: () => useCanvasStore.getState().openChatTab(),
    recordEntityArtifactForTest: async (
      input: import('./features/lims/public/record-entity-artifact').RecordEntityArtifactInput
    ) =>
      (await import('./features/lims/public/record-entity-artifact')).recordEntityArtifact(input),
    createFileAuthoritativePrimerForTest: async (
      input: import('./shared/primer-artifacts/types').CreatePrimerInput
    ) =>
      (
        await import('./features/primers/public/create-file-authoritative-primer')
      ).createFileAuthoritativePrimer(input),

    loadMocloKitCatalog: async (projectRoot: string) =>
      (await import('./features/design/public/moclo-schema-catalog')).loadMocloSchemaCatalog(
        projectRoot
      ),
    getFullChatViewReferenceRootCacheDiagnostics: async () =>
      (await import('./components/FullChatView')).getFullChatViewReferenceRootCacheDiagnostics(),
    holdNextStructureOpenBeforeCommit: async () =>
      (
        await import('./features/structure-files/openStructureFile')
      ).holdNextStructureOpenBeforeCommitForTest(),
    getStructureOpenCancellationDiagnostics: async () =>
      (
        await import('./features/structure-files/openStructureFile')
      ).getStructureOpenCancellationDiagnosticsForTest(),
    openWorkspaceDocumentForTest: async (input: { path: string; label: string }) =>
      (await import('./features/page/public/open-workspace-document')).openWorkspaceDocument({
        target: { kind: 'file', path: input.path, tabType: 'page' },
        label: input.label,
      }),
    getSequenceStore: () => useSequenceStore.getState(),
    isSequenceEditorInputFrozen: isWorkspaceEditorInputFrozen,
    getRichSequenceClipboard: () => useRichSequenceClipboardStore.getState().copiedRegion,
    getAnnotationReviewSession: (filePath: string) =>
      useAnnotationReviewStore.getState().getSession(filePath) ?? null,
    isAnnotationReviewActive: (filePath: string) =>
      useAnnotationReviewStore.getState().isActive(filePath),
    seedLibraryPrimer: async (input: {
      name: string;
      sequence: string;
      workspaceRoot?: string;
    }) => {
      const { resolveMountedProjectRoot } = await import('./shared/project-root-selection');
      const { useWorkspaceStore } = await import('./stores/workspaceStore');
      const owner = resolveMountedProjectRoot(
        useWorkspaceStore.getState().folders,
        input.workspaceRoot
      );
      if (!owner) throw new Error('The primer fixture requires one exact writable project.');
      const { primerServices } = await import('./features/primers/primer-services');
      const result = await primerServices.persistence.writeAndProjectArtifact({
        name: input.name,
        sequence: input.sequence,
        workspaceRoot: owner.path,
        artifactPath: `${owner.path.replace(/[\\/]+$/, '')}/primers/${crypto.randomUUID()}.primer.json`,
        requireRegistry: true,
        origin: 'manual',
      });
      return result.primer.id;
    },
    seedNotebookPrimerArtifact: async (input: {
      artifactId?: string;
      workspaceRoot: string;
      name: string;
      sequence: string;
    }) => {
      const relativePath = `primers/${input.name}.primer.json`;
      const separator = input.workspaceRoot.includes('\\') ? '\\' : '/';
      const root = input.workspaceRoot.replace(/[\\/]+$/, '');
      const primerDir = `${root}${separator}primers`;
      const artifactPath = `${primerDir}${separator}${input.name}.primer.json`;
      await platform().fs.mkdir(primerDir, { recursive: true });
      const { primerServices } = await import('./features/primers/primer-services');
      const result = await primerServices.persistence.writeAndProjectArtifact({
        artifactId: input.artifactId,
        workspaceRoot: input.workspaceRoot,
        artifactPath,
        name: input.name,
        sequence: input.sequence,
        requireRegistry: true,
        origin: 'manual',
      });
      return {
        primerId: result.primer.id,
        registryEntityId: result.limsEntity.id,
        relativePath,
      };
    },
    seedBoundPrimerArtifact: async (input: {
      workspaceRoot: string;
      name: string;
      sequence: string;
      targetFilePath: string;
      targetDocumentId: string;
      targetLength: number;
      targetTopology: 'linear' | 'circular';
      bindingSequenceId: number;
      bindingStart: number;
      bindingEnd: number;
      bindingStrand: 1 | -1;
    }) => {
      const separator = input.workspaceRoot.includes('\\') ? '\\' : '/';
      const root = input.workspaceRoot.replace(/[\\/]+$/, '');
      const artifactPath = `${root}${separator}${input.name}.primer.json`;
      const { primerServices } = await import('./features/primers/primer-services');
      const result = await primerServices.persistence.saveArtifact({
        ...input,
        artifactPath,
        requireRegistry: true,
        origin: 'manual',
      });
      primerServices.persistence.notifyBindingsChanged(input.bindingSequenceId);
      return {
        primerId: result.primer.id,
        artifactPath: result.artifactPath,
      };
    },
    seedNotebookReferencePage: async (input: {
      title?: string;
      open?: boolean;
      reuseExisting?: boolean;
      refs: Array<{
        label: string;
        entityType?: string;
        entityId?: string | null;
        path?: string | null;
        contentHash?: string | null;
      }>;
    }) => {
      const pageStore = usePageStore.getState();
      const title = input.title ?? 'Reference chips';
      const existing = input.reuseExisting
        ? Object.values(pageStore.pages).find((page) => page.title === title)
        : undefined;
      if (existing) return existing.id;
      const pageId = await pageStore.createPage(title);

      const inline: JSONContent[] = [{ type: 'text', text: 'Parts used: ' }];
      input.refs.forEach((ref, index) => {
        if (index > 0) inline.push({ type: 'text', text: ', ' });
        inline.push({
          type: 'mention',
          attrs: {
            id: ref.entityId ?? ref.path ?? null,
            label: ref.label,
            entityType: ref.entityType ?? 'sequence',
            entityId: ref.entityId ?? null,
            path: ref.path ?? null,
            contentHash: ref.contentHash ?? null,
          },
        });
      });
      inline.push({ type: 'text', text: '.' });

      await usePageStore
        .getState()
        .savePage(pageId, { type: 'doc', content: [{ type: 'paragraph', content: inline }] });

      if (input.open !== false) {
        const canvas = useCanvasStore.getState();
        canvas.openTab(canvas.focusedPanelId ?? canvas.panels[0]?.id, {
          type: 'page',
          entityId: pageId,
          label: title,
        });
      }
      return pageId;
    },

    queryCatalogFiles: async (pathLike: string) => {
      const { platform } = await import('./platform');
      return platform().db.select<
        Array<{
          path: string;
          relative_path: string | null;
          status: string;
          object_uuid: string | null;
          content_hash: string | null;
          entity_id: string;
        }>
      >(
        `SELECT path, relative_path, status, object_uuid, content_hash, entity_id
           FROM catalog_entity_files
          WHERE path LIKE ?
          ORDER BY path`,
        [pathLike]
      );
    },

    getPageStore: () => {
      const state = usePageStore.getState();
      return {
        ...state,
        createPage: (...args: Parameters<typeof state.createPage>) =>
          retainTestBridgeOperation(state.createPage(...args)),
        get savePage() {
          const savePage = usePageStore.getState().savePage;
          return (...args: Parameters<typeof savePage>) =>
            retainTestBridgeOperation(savePage(...args));
        },
        set savePage(savePage: typeof state.savePage) {
          usePageStore.setState({ savePage });
        },
      };
    },
    interceptPageSaveForTest: (
      createInterceptor: (savePage: PageSaveForTest) => PageSaveForTest
    ) => {
      const savePage = usePageStore.getState().savePage;
      const interceptedSavePage = createInterceptor(savePage);
      usePageStore.setState({ savePage: interceptedSavePage });
      return () => {
        if (usePageStore.getState().savePage === interceptedSavePage) {
          usePageStore.setState({ savePage });
        }
      };
    },
    getCanvasStore: () => useCanvasStore.getState(),
    getDesignStore: () => useDesignStore.getState(),
    runAssemblyCommandForTest: async (input: {
      designId: string;
      command: 'validate' | 'run';
      mode: 'refuse_stale' | 'cancel';
    }) => {
      const version = useDesignStore.getState().designs[input.designId]?.version ?? 0;
      const operation = assemblyDispatcher.dispatch({
        type: input.command,
        designId: input.designId,
        expectedVersion: version + (input.mode === 'refuse_stale' ? 1 : 0),
      });
      if (input.mode === 'cancel') operation.abort();
      return operation.result;
    },
    hasPendingDesignArtifactMirror: (designId: string) =>
      hasPendingDesignArtifactMirror([designId]),
    createDesignArtifactForTest: async (input: {
      workspaceRoot: string;
      design: import('./features/design/types').SequenceDesign;
      fileName?: string;
    }) => {
      const { registerCatalogEntity, getCurrentCatalogFileForEntity } =
        await import('./db/workspace-catalog');
      const { createDesignArtifactFile } = await import('./db/workspace-artifacts');
      const entity = await registerCatalogEntity({
        id: input.design.id,
        type: 'design',
        name: input.design.name,
        locator: `entity://design/${input.design.id}`,
        storageType: 'localStorage',
        workspaceRoot: input.workspaceRoot,
        metadata: {
          createdBy: 'e2e-state-injection',
          backingStore: 'waypoint-designs',
        },
      });
      const artifact = await createDesignArtifactFile({
        entityId: entity.id,
        designId: input.design.id,
        name: input.design.name,
        design: input.design,
        fileName: input.fileName,
        workspaceRoot: input.workspaceRoot,
        context: {
          targetPath: input.workspaceRoot,
          targetKind: 'folder',
          parentPath: input.workspaceRoot,
          workspaceRoot: input.workspaceRoot,
        },
      });
      return {
        artifact,
        binding: await getCurrentCatalogFileForEntity(input.design.id),
      };
    },
    getAuthState: () => useAuthStore.getState().state,

    setAuthState: (state: DesktopAuthState) =>
      useAuthStore.setState({ state, initialized: true, hydrated: true }),
    getJunctionWorkbenchEnabled: () => useSettingsStore.getState().experimentalJunctionWorkbench,
    setJunctionWorkbenchEnabled: (enabled: boolean) =>
      useSettingsStore.getState().setExperimentalJunctionWorkbench(enabled),
    setPrimerTmModel: (model: TmModel) => useSettingsStore.getState().setTmModel(model),
    getPrimerTmModel: () => ({
      model: useSettingsStore.getState().tmModel,
      explicit: useSettingsStore.getState().tmModelExplicit,
    }),
    restorePrimerTmConfigForTest: (config: { model: TmModel; explicit: boolean }) =>
      useSettingsStore.setState({
        tmModel: config.model,
        tmModelExplicit: config.explicit,
      }),
    getJunctionWorkbenchViewportVariant: () =>
      useSettingsStore.getState().junctionWorkbenchViewportVariant,
    setJunctionWorkbenchViewportVariant: (
      variant: 'legacy-linked-camera' | 'registered-assembly-viewport'
    ) => useSettingsStore.getState().setJunctionWorkbenchViewportVariant(variant),
    getAssemblyState: (designId: string) => {
      const state = useDesignStore.getState();
      const design = state.designs[designId];
      return {
        state: design?.assemblyState ?? null,
        validationErrors: design?.validationErrors ?? [],
        pendingDispatchId: state.pendingDispatchId,
        version: design?.version ?? null,
      };
    },
    getAssemblyDebugSnapshot: (designId?: string) => {
      const state = useDesignStore.getState();
      const id = designId ?? state.activeDesignId;
      const design = id ? state.designs[id] : null;
      return design ? describeDesignAssemblyState(design) : null;
    },
    getJunctionWorkbenchModels: async (designId?: string) => {
      const state = useDesignStore.getState();
      const id = designId ?? state.activeDesignId;
      const design = id ? state.designs[id] : null;
      if (!design) return null;
      const { buildJunctionWorkbenchModels } = await import('./features/junction-workbench/model');
      const { SourceContextRegistry, createJunctionSourceWindowRequests } =
        await import('./features/junction-workbench/SourceContextRegistry');
      const sequenceCache = useSequenceStore.getState().sequences;
      const registry = new SourceContextRegistry(sequenceCache);
      const sourceWindows = registry.resolveWindows(createJunctionSourceWindowRequests(design));
      const models = buildJunctionWorkbenchModels(design, { sourceWindows });
      return models.map((model) => ({
        id: model.id,
        method: model.method,
        junctionIndex: model.junctionIndex,
        editable: model.editable,
        rows: model.rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          sequenceLength: row.sequence.length,
          sequence: row.sequence,
          anchorRowPosition: row.anchorRowPosition,
          coordinateStart: row.coordinateStart,
          spacerColumns: row.spacerColumns ?? [],
          mutedColumns: row.mutedColumns ?? [],
          contributingColumns: row.contributingColumns ?? [],
          visibleColumns: row.visibleColumns ?? [],
          constraints: row.constraints ?? [],
          pointSamples: row.points.map((point) => ({
            rowPosition: point.rowPosition,
            bioCol: point.bioCol,
            kind: point.kind,
            productPosition: point.productPosition,
            sourcePosition: point.sourcePosition,
          })),
          primers: (row.primers ?? []).map((primer) => ({
            id: primer.id,
            sourcePrimerId: primer.sourcePrimerId,
            direction: primer.direction,
            start: primer.start,
            end: primer.end,
            overhangLength: primer.overhangLength ?? 0,
            spacerLength: primer.spacerLength ?? 0,
            bases: primer.bases,
          })),
        })),
      }));
    },
    getCanvasState: () => {
      const state = useCanvasStore.getState();
      return {
        focusedPanelId: state.focusedPanelId,
        panels: Object.values(state.panels).map((panel) => ({
          id: panel.id,
          activeTabId: panel.activeTabId,
          tabs: panel.tabs.map((tab) => ({
            id: tab.id,
            type: tab.type,
            entityId: tab.entityId,
            label: tab.label,
            isDirty: tab.isDirty ?? false,
          })),
        })),
      };
    },
    resetCanvas: () => useCanvasStore.getState().reset(),
    getTraceProbe: () => getTraceProbeState(),
    attachReadToReference: async (documentId: string, ab1Path: string) => {
      const [{ resolveSequenceDocumentById }, { useWorkspaceStore }] = await Promise.all([
        import('./features/sequence/sequence-document-repository'),
        import('./stores/workspaceStore'),
      ]);
      const source = await resolveSequenceDocumentById(
        documentId,
        useWorkspaceStore.getState().folders.map((folder) => folder.path)
      );
      return attachReadToReference(documentId, source.sourcePath, ab1Path);
    },
    getAttachedReads: () => useAttachedReadsStore.getState().attachedBySequenceId,
    detachRead: (sequenceId?: string, readId?: string) => {
      const store = useAttachedReadsStore.getState();
      if (sequenceId && readId) store.detach(sequenceId, readId);
      else store.clear(sequenceId);
    },
    setSequenceViewMode: (documentId: string, mode: '2d' | '1d' | 'tracks') => {
      const cs = useCanvasStore.getState();
      for (const panel of Object.values(cs.panels)) {
        const tab = panel.tabs.find((t) => t.type === 'sequence' && t.entityId === documentId);
        if (tab) {
          cs.setTabViewState(panel.id, tab.id, { sequenceViewMode: mode });
          return { ok: true, panelId: panel.id, tabId: tab.id };
        }
      }
      return { ok: false, reason: `no sequence tab with documentId=${documentId}` };
    },
    highlightRange: (
      documentId: string,
      range: { start: number; end: number; wraps?: boolean }
    ) => {
      const cs = useCanvasStore.getState();
      for (const panel of Object.values(cs.panels)) {
        const tab = panel.tabs.find((t) => t.type === 'sequence' && t.entityId === documentId);
        if (tab) {
          const base = primerBindingToViewState(range.start, range.end);
          cs.setTabViewState(panel.id, tab.id, {
            scrollPosition: base.scrollPosition,
            highlightRange: {
              ...base.highlightRange!,
              ...(range.wraps != null ? { wraps: range.wraps } : {}),
            },
            sequenceNavigationRequestId: Date.now(),
          });
          return {
            ok: true,
            panelId: panel.id,
            tabId: tab.id,
            range: { start: range.start, end: range.end },
          };
        }
      }
      return { ok: false, reason: `no sequence tab with documentId=${documentId}` };
    },
    setActiveSequenceTab: async (documentId: string) => {
      const cs = useCanvasStore.getState();
      for (const panel of Object.values(cs.panels)) {
        for (const tab of panel.tabs) {
          if (tab.type !== 'sequence' || tab.entityId !== documentId) continue;
          cs.setActiveTab(panel.id, tab.id);
          return { ok: true, panelId: panel.id, tabId: tab.id };
        }
      }
      return { ok: false, reason: `no sequence tab with documentId=${documentId}` };
    },
    getSequenceAnnotations: (documentId: string) =>
      (useSequenceStore.getState().sequences[documentId]?.annotations ?? []).map((a) => ({
        name: a.name,
        type: a.type,
        start: a.start,
        end: a.end,
        qualifierKeys: Object.keys(a.qualifiers ?? {}),
      })),
    getLoadedSequences: () => {
      const state = useSequenceStore.getState();
      const canvas = useCanvasStore.getState();
      const focusedPanel = canvas.focusedPanelId ? canvas.panels[canvas.focusedPanelId] : null;
      const activeTab = focusedPanel?.tabs.find((tab) => tab.id === focusedPanel.activeTabId);
      return {
        activeDocumentId: activeTab?.type === 'sequence' ? activeTab.entityId : null,
        loadingDocumentIds: Array.from(state.loadingDocumentIds),
        sequences: Object.entries(state.sequences).map(([documentId, seq]) => ({
          documentId,
          name: seq.name ?? null,
          length: seq.sequence.length,
          circular: seq.circular ?? false,
          annotationCount: seq.annotations?.length ?? 0,
          version: state.sequenceVersions[documentId] ?? 0,
          dirty: state.dirtyPaths[documentId] === true,
          scrollPosition: state.scrollPositions[documentId] ?? null,
        })),
      };
    },
    saveSequence: async (documentId: string) => {
      const { resolveSequenceDocument } =
        await import('./features/sequence/sequence-document-repository');
      const tab = Object.values(useCanvasStore.getState().panels)
        .flatMap((panel) => panel.tabs)
        .find((candidate) => candidate.type === 'sequence' && candidate.entityId === documentId);
      const seq = tab ? useSequenceStore.getState().sequences[tab.entityId] : undefined;
      if (!tab?.sequenceDocument || !seq) throw new Error(`No sequence for ${documentId}`);
      const filePath = (await resolveSequenceDocument(tab.sequenceDocument)).sourcePath;
      const { serializeGenBank } = await import('@waypoint/sequence-utils');
      const { platform } = await import('./platform');
      const genbank = serializeGenBank(seq);
      await platform().fs.writeTextFile(filePath, genbank);
      useSequenceStore.getState().markClean(tab.entityId);
    },
    importSequence: async (args: Record<string, unknown>) => {
      const { createImportSequenceTool } = await import('./features/ai/tools/import-sequence');
      const { useWorkspaceStore } = await import('./stores/workspaceStore');
      const folders = useWorkspaceStore.getState().folders;
      const tool = createImportSequenceTool(folders);
      if (!tool.execute) throw new Error('import_sequence tool has no execute');
      return tool.execute(args as never, { toolCallId: 'test-bridge', messages: [] } as never);
    },
    closeAllTabs: () => {
      const store = useCanvasStore.getState();
      for (const [, panel] of Object.entries(store.panels)) {
        for (const tab of [...panel.tabs]) {
          store.closeTab(panel.id, tab.id);
        }
      }
    },
    openDocument: async (
      request: import('./features/document-opening/public/types').OpenDocumentRequest
    ) => (await import('./features/document-opening/public/open-document')).openDocument(request),
    openFile: async (filePath: string) => {
      const fileName = filePath.split('/').pop() || 'Untitled';
      const { openSequenceFile } = await import('./features/document-opening/compat');
      return openSequenceFile({
        filePath,
        label: fileName,
        strategy: { kind: 'focused' },
      });
    },
    openFileAndGetDocument: async (filePath: string) => {
      const fileName = filePath.split('/').pop() || 'Untitled';
      const { openSequenceFile } = await import('./features/document-opening/compat');
      const tabId = await openSequenceFile({
        filePath,
        label: fileName,
        strategy: { kind: 'focused' },
      });
      if (!tabId) return null;
      const tab = Object.values(useCanvasStore.getState().panels)
        .flatMap((panel) => panel.tabs)
        .find((candidate) => candidate.id === tabId);
      if (tab?.type !== 'sequence') return null;
      return { tabId, documentId: tab.entityId };
    },
    resolveSequenceDocumentIdForSource: async (filePath: string) => {
      const { getCatalogEntityForFilePath } = await import('./db/workspace-catalog');
      return (await getCatalogEntityForFilePath(filePath))?.id ?? null;
    },
    stageAskAiEvalTurn: async (args: {
      locator: string;
      range: { start: number; end: number; wraps?: boolean };
      question: string;
      displayLabel?: string;
      overlays?: import('./features/ai/selection-descriptor/active-overlays').ActiveOverlaySnapshot;
    }): Promise<{ refId: string; descriptor: unknown; prompt: string }> => {
      const [{ askAiAboutSelection }, chat, { useWorkspaceStore }, catalog] = await Promise.all([
        import('./features/ai/ask-ai-about-selection'),
        import('./features/ai/hooks/useChat'),
        import('./stores/workspaceStore'),
        import('./db/workspace-catalog'),
      ]);
      const folders = useWorkspaceStore.getState().folders;
      const file = await catalog.getCurrentSequenceFileForDocumentId(args.locator);
      const base = args.locator.split(/[\\/]/).pop() ?? args.locator;
      const ref = await askAiAboutSelection({
        entityType: 'sequence_region',
        displayLabel: args.displayLabel ?? `${base} ${args.range.start}–${args.range.end}`,
        locator: args.locator,
        workspaceRootPath: catalog.findWorkspaceRootForPath(folders, file?.path),
        deepLinkParams: args.range,
        seedText: undefined,
        activeOverlays: args.overlays,
      });
      chat.useChatStore.getState().setPendingAskAiPicker(null);

      const descriptor: unknown = ref.data ? JSON.parse(ref.data) : null;

      const fence = await chat.expandReferencesFromIds('', [ref.id]);
      const userContent = `${fence}\n\n${args.question}`;
      const userMsg = {
        id: crypto.randomUUID(),
        role: 'user' as const,
        content: userContent,
        createdAt: Date.now(),
      };
      const hasWorkspace = folders.some((f) => !f.pinned);
      const prompt = chat.buildAgentSdkPrompt(folders, [userMsg], 'native-cli', hasWorkspace, [
        ref,
      ]);

      return { refId: ref.id, descriptor, prompt };
    },
    stageStructureAskAiEvalContext: async (args: {
      structureRef: string;
      displayLabel: string;
      residues: ResidueLocation[];
    }): Promise<{ refId: string; descriptor: unknown }> => {
      const [{ askAiAboutSelection }, { structureSelectionsFromResidues }] = await Promise.all([
        import('./features/ai/ask-ai-about-selection'),
        import('./features/ai/selection-descriptor/structure'),
      ]);
      const selections = structureSelectionsFromResidues(args.residues).map(
        ({ regions, ...selection }) => ({
          ...selection,
          ranges: regions.map(({ start, end }) => [start, end] as [number, number]),
        })
      );
      const ref = await askAiAboutSelection(
        {
          entityType: 'structure',
          displayLabel: args.displayLabel,
          locator: args.structureRef,
          deepLinkParams: {
            highlightGroups: [
              {
                id: `ask-ai-eval-selection:${args.structureRef}`,
                label: 'Selected residues',
                selections,
                visible: true,
              },
            ],
          },
          structure: {
            residues: args.residues,
            visibleRepresentations: [
              {
                layerId: 'polymer-cartoon',
                representation: 'cartoon',
                target: 'whole-structure',
                colorMode: 'chain',
              },
            ],
          },
        },
        { route: 'seed-focused-chat' }
      );
      return {
        refId: ref.id,
        descriptor: ref.data ? JSON.parse(ref.data) : null,
      };
    },
    openReferenceById: async (referenceId: string) => {
      const [{ getEntityReference }, { navigateToReference }] = await Promise.all([
        import('./db/entity-references'),
        import('./features/ai/references/navigate'),
      ]);
      const reference = await getEntityReference(referenceId);
      if (!reference) return { ok: false, reason: 'missing_reference', referenceId };

      return {
        ok: true,
        referenceId,
        navigation: navigateToReference(reference),
      };
    },
    getEntityReferenceForTest: async (referenceId: string) => {
      const { getEntityReference } = await import('./db/entity-references');
      return getEntityReference(referenceId);
    },
    resolveMolecularDocumentResultForTest: async (
      target: string | import('./shared/molecular-document-reference').MolecularDocumentReference
    ) => {
      const {
        resolveMolecularDocumentResult,
        resolveMolecularDocumentReference,
        molecularDocumentReferenceRecord,
      } = await import('./features/molecular-documents/public/references');
      const resolved =
        typeof target === 'string'
          ? await resolveMolecularDocumentResult(target)
          : await resolveMolecularDocumentReference(target);
      return {
        ...resolved,
        reference: molecularDocumentReferenceRecord(
          resolved.documentReference,
          resolved.snapshot.title
        ),
      };
    },
    createEntityReferenceForTest: async (params: {
      entityType: string;
      displayLabel: string;
      locator: string;
      deepLinkParams: Record<string, unknown> | null;
      data: Record<string, unknown> | null;
      source: string;
      workspaceScope?: string | null;
      workspaceRootPath?: string | null;
    }) => {
      const { createEntityReference } = await import('./db/entity-references');
      const { getCurrentWorkspaceScope, useWorkspaceStore } =
        await import('./stores/workspaceStore');
      const { workspaceRootPathForGitLocator } =
        await import('./features/ai/references/inline/origin');
      return createEntityReference({
        ...params,
        workspaceScope:
          params.workspaceScope === undefined ? getCurrentWorkspaceScope() : params.workspaceScope,
        workspaceRootPath:
          params.workspaceRootPath ??
          workspaceRootPathForGitLocator(params.locator, useWorkspaceStore.getState().folders),
      });
    },
    setWorkspaceFoldersForTest: async (paths: string[]) => {
      const { useWorkspaceStore } = await import('./stores/workspaceStore');
      const { getWorkspaceProjectControl } =
        await import('./features/workspace-loader/workspace-project-control');
      const { waitForNativeFileDocumentReadiness } =
        await import('./features/workspace/public/file-document-client');
      const control = getWorkspaceProjectControl();
      if (!control) throw new Error('Workspace project controls are unavailable.');
      const roots = await Promise.all(
        paths.map(async (path) => (await platform().fs.stat(path)).canonicalPath)
      );
      for (const path of roots) {
        if (
          !(await control.open(
            { kind: 'local-folder', path },
            { inPlace: true, replaceCurrent: false, makeCurrent: false, telemetrySource: 'e2e' }
          ))
        )
          throw new Error(`Could not mount test workspace: ${path}`);
      }
      for (const folder of useWorkspaceStore.getState().folders) {
        if (!roots.includes(folder.path)) {
          await control.unmount(folder.path);
          useWorkspaceStore.getState().removeFolder(folder.path);
        }
      }
      useWorkspaceStore.getState().setActiveWorkspaceFile(null);
      await waitForNativeFileDocumentReadiness();
    },
    getWorkspaceFoldersForTest: async () => {
      const { useWorkspaceStore } = await import('./stores/workspaceStore');
      return useWorkspaceStore.getState().folders.map((folder) => ({ ...folder }));
    },
    armWorkspaceOperationFailure: async (input: {
      stage: 'reconstruction' | 'display';
      workspaceRoot?: string | null;
    }) => {
      (await import('./services/workspace-operation-test-injection')).armWorkspaceOperationFailure(
        input
      );
    },
    disarmWorkspaceOperationFailure: async () => {
      (
        await import('./services/workspace-operation-test-injection')
      ).disarmWorkspaceOperationFailure();
    },
    workspaceOperationFailureState: async () =>
      (
        await import('./services/workspace-operation-test-injection')
      ).workspaceOperationFailureState(),
    workspaceDisplayParticipantCount: async () =>
      (
        await import('./services/workspace-display-participants')
      ).workspaceDisplayParticipantCount(),
    armRendererOperationBarrier: async (phase: 'before-handler' | 'after-handler') => {
      (
        await import('./features/agent-bridge/renderer-operation-test-barrier')
      ).armRendererOperationBarrier(phase);
    },
    rendererOperationBarrierState: async () =>
      (
        await import('./features/agent-bridge/renderer-operation-test-barrier')
      ).rendererOperationBarrierState(),
    releaseRendererOperationBarrier: async () => {
      (
        await import('./features/agent-bridge/renderer-operation-test-barrier')
      ).releaseRendererOperationBarrier();
    },
    rebindRendererAgentBridgeForTest: async () => {
      const { installRendererAgentBridge } =
        await import('./features/agent-bridge/install-renderer-agent-bridge');
      rendererAgentBridgeDisposer?.();
      rendererAgentBridgeDisposer = installRendererAgentBridge();
    },
    getStructureFileSnapshotCacheDiagnostics: async () => {
      const { getStructureFileSnapshotCacheDiagnostics } =
        await import('./features/structure-files/structure-file-snapshots');
      return getStructureFileSnapshotCacheDiagnostics();
    },
    setStructureFileSnapshotRegistrationPausedForTest: async (paused: boolean) => {
      const { setStructureFileSnapshotRegistrationPausedForTests } =
        await import('./features/structure-files/structure-file-snapshots');
      setStructureFileSnapshotRegistrationPausedForTests(paused);
    },
    openStructureDataForTest: async (
      data: string,
      label: string,
      format: 'pdb' | 'cif' = 'pdb'
    ) => {
      const { handleMolOpenTab } = await import('./features/agent-bridge/structure-tools');
      return handleMolOpenTab({ structure: { kind: 'data', format, data }, label });
    },
    registerStructureDataForTest: async (structureId: string, data: string, label: string) => {
      const { useStructure3dStore } = await import('./features/page/embeds/structure3d/store');
      const attrs: Structure3dAttrs = {
        source: 'file',
        sourceId: data,
        label,
        showSequenceViewer: true,
        highlightGroups: [],
      };
      useStructure3dStore.getState().registerStructure(structureId, attrs, label);
      return structureId;
    },
    mountDefaultMolstarControlForTest: async (data: string, chain: string, authSeqId: number) => {
      const { mountDefaultMolstarControl } = await import('./test/default-molstar-control');
      return mountDefaultMolstarControl(data, chain, authSeqId);
    },
    disposeDefaultMolstarControlForTest: async () => {
      const { disposeDefaultMolstarControl } = await import('./test/default-molstar-control');
      await disposeDefaultMolstarControl();
    },
    openReferenceAssembly: async (
      assemblyId: string,
      options?: {
        initialAnnotationMapperPolicy?: {
          isoformMode: 'canonical' | 'expanded';
          laneLimit: number | null;
        };
      }
    ) => {
      const [{ openAssembly }, { referenceAssemblyById }, { referenceAssemblyEntryForTest }] =
        await Promise.all([
          import('./features/sequence/openAssembly'),
          import('./features/sequence/reference-catalog'),
          import('./test/reference-assembly-entry'),
        ]);
      const localReferences = await platform()
        .referenceAssets.listLocal()
        .catch(() => []);
      let entry = localReferences.find((candidate) => candidate.id === assemblyId);
      if (!entry) {
        const hosted = (await platform().referenceAssets.listHosted()).find(
          (candidate) => candidate.id === assemblyId
        );
        entry = hosted
          ? (
              await platform().referenceAssets.installHosted({
                catalogId: assemblyId,
                themeMode: 'light',
                intent: 'open-view',
              })
            ).entry
          : referenceAssemblyById(assemblyId);
      }
      if (!entry) return { ok: false, reason: 'unknown_assembly', assemblyId };
      const policy = options?.initialAnnotationMapperPolicy;
      const validPolicy =
        !policy ||
        ((policy.isoformMode === 'canonical' || policy.isoformMode === 'expanded') &&
          (policy.laneLimit === null ||
            (Number.isSafeInteger(policy.laneLimit) && policy.laneLimit > 0)));
      if (!validPolicy) {
        return { ok: false, reason: 'invalid_annotation_mapper_policy', assemblyId };
      }
      const prepared = await referenceAssemblyEntryForTest(entry);
      const tabId = await openAssembly(prepared, {
        ...(policy ? { initialAnnotationMapperPolicy: policy } : {}),
      });
      const openedTab = tabId
        ? Object.values(useCanvasStore.getState().panels)
            .flatMap((panel) => panel.tabs)
            .find((tab) => tab.id === tabId)
        : null;
      return {
        ok: Boolean(tabId),
        tabId: tabId ?? null,
        assemblyId,
        created: Boolean(tabId),
        initialAnnotationMapperPolicy: openedTab?.initialAnnotationMapperPolicy ?? null,
      };
    },
    getAssemblyOverviewChroms: async (assemblyId: string) => {
      const [
        { buildGenomeAssembly, joinProjectPath, referenceAssemblyById, referenceAssemblyCacheRoot },
        { resolveCurrentReferenceAssetPublicationV1 },
      ] = await Promise.all([
        import('./features/sequence/reference-catalog'),
        import('./features/sequence/reference-asset-publication'),
      ]);
      const entry = referenceAssemblyById(assemblyId);
      if (!entry) return null;
      const sharedCacheRoot = await platform()
        .path.referenceAssetCacheRoot()
        .catch(() => null);
      if (!sharedCacheRoot) return null;
      const publicationRoot = await (
        platform().path.referenceAssetPublicationRoot?.() ?? Promise.resolve(sharedCacheRoot)
      ).catch(() => sharedCacheRoot);
      const assemblyCacheRoot = referenceAssemblyCacheRoot(sharedCacheRoot, entry);
      const publicationAssemblyRoot = referenceAssemblyCacheRoot(publicationRoot, entry);
      const currentPublication = await resolveCurrentReferenceAssetPublicationV1({
        assemblyCacheRoot,
        publicationAssemblyRoot,
        fallbackPublicationAssemblyRoot:
          publicationAssemblyRoot === assemblyCacheRoot ? null : assemblyCacheRoot,
        assetCacheKey: entry.assetCacheKey,
        readTextFile: (path) => platform().fs.readTextFile(path),
      });
      if (!currentPublication) return null;
      const assembly = buildGenomeAssembly(entry, (rel) =>
        joinProjectPath(currentPublication.sourceGenerationRoot, rel)
      );
      return assembly.chromosomes.map((c) => ({
        chrom: c.chrom,
        sourcePath: c.manifest.gffPath ?? null,
        length: c.length,
      }));
    },
    buildAssemblyOverviewTexturePrecomputeGenome: async (
      assemblyId: string,
      workspaceRoot: string
    ) => {
      const { buildAssemblyOverviewTexturePrecomputeGenome } =
        await import('./features/sequence/components/assembly-overview-texture-precompute');
      const referenceAssetCacheRoot = await platform()
        .path.referenceAssetCacheRoot()
        .catch(() => null);
      const referenceAssetPublicationRoot = referenceAssetCacheRoot
        ? await (
            platform().path.referenceAssetPublicationRoot?.() ??
            Promise.resolve(referenceAssetCacheRoot)
          ).catch(() => referenceAssetCacheRoot)
        : null;
      return buildAssemblyOverviewTexturePrecomputeGenome({
        assemblyId,
        referenceAssetCacheRoot,
        referenceAssetPublicationRoot,
        workspaceRoot,
      });
    },
    openSequenceTab: async (filePath: string) => {
      return perfTimeAsync(
        'app.openSequenceTab',
        async () => {
          const bytes = await perfTimeAsync('app.readFile', () => platform().fs.readFile(filePath));
          perfLog('app.readFile.size', { bytes: bytes.length });
          const ext = filePath.split('.').pop()?.toLowerCase();
          const parsed =
            ext === 'ab1' || ext === 'abi' || ext === 'dna'
              ? perfTime(
                  'app.parseBinarySequenceFileAsAnnotated',
                  () => parseBinarySequenceFileAsAnnotated(bytes, filePath).sequence,
                  {
                    bytes: bytes.length,
                  }
                )
              : (() => {
                  const text = perfTime(
                    'app.decodeUtf8',
                    () => new TextDecoder('utf-8').decode(bytes),
                    {
                      bytes: bytes.length,
                    }
                  );
                  return perfTime(
                    'app.parseTextSequenceFileAsAnnotated',
                    () => parseTextSequenceFileAsAnnotated(text, filePath).sequence,
                    {
                      bytes: text.length,
                    }
                  );
                })();
          perfLog('app.parseTextSequenceFileAsAnnotated.result', {
            annotations: parsed.annotations?.length ?? 0,
            seqLen: parsed.sequence?.length ?? 0,
          });
          const { openSequenceFile } = await import('./features/document-opening/compat');
          const tabId = await openSequenceFile({
            filePath,
            label: filePath.split(/[\\/]/).pop() ?? filePath,
            strategy: { kind: 'focused' },
            sourceSurface: 'unknown',
          });
          if (tabId) {
            const opened = Object.values(useCanvasStore.getState().panels)
              .flatMap((panel) => panel.tabs)
              .find((tab) => tab.id === tabId);
            if (opened?.type === 'sequence') {
              perfTime('app.setSequence', () =>
                useSequenceStore.getState().setSequence(opened.entityId, parsed)
              );
            }
          }
          return tabId;
        },
        { filePath }
      );
    },
    getActiveEnzymeNames: (): string[] => {
      try {
        const raw = window.localStorage.getItem('waypoint-active-enzymes');
        return raw ? (JSON.parse(raw) as string[]) : [];
      } catch {
        return [];
      }
    },
    setActiveEnzymeNames: (names: string[]) => {
      window.localStorage.setItem('waypoint-active-enzymes', JSON.stringify(names));
    },
    getCutSitesForSequence: async (
      sequenceDocumentId: string,
      enzymeNames?: string[]
    ): Promise<null | Array<{
      enzymeName: string;
      recognitionStart: number;
      recognitionEnd: number;
      cutPositionTop: number;
      cutPositionBottom: number;
      strand: 'forward' | 'reverse';
    }>> => {
      const seq = useSequenceStore.getState().sequences[sequenceDocumentId];
      if (!seq) return null;
      const [{ findAllCutSites }, { platform }] = await Promise.all([
        import('@waypoint/sequence-utils'),
        import('./platform'),
      ]);
      const dataUrl = new URL(
        resolveRendererAssetUrl({
          path: 'data/rebase/merged-enzymes.json',
          documentUrl: window.location.href,
          baseUrl: import.meta.env.BASE_URL,
          hostedBrowser: document.documentElement.dataset.dnaforgeRuntime === 'hosted-browser',
        })
      );
      let enzymeText: string;
      if (dataUrl.protocol === 'http:' || dataUrl.protocol === 'https:') {
        const res = await fetch(dataUrl.toString());
        enzymeText = await res.text();
      } else if (dataUrl.protocol === 'file:') {
        enzymeText = await platform().fs.readTextFile(decodeURIComponent(dataUrl.pathname));
      } else {
        throw new Error(`Unsupported renderer protocol: ${dataUrl.protocol}`);
      }
      const allEnzymes = (JSON.parse(enzymeText) as { enzymes: unknown[] }).enzymes as Array<{
        name: string;
      }>;
      const targetNames =
        enzymeNames ??
        (() => {
          try {
            const raw = window.localStorage.getItem('waypoint-active-enzymes');
            return raw ? (JSON.parse(raw) as string[]) : [];
          } catch {
            return [];
          }
        })();
      const targets = allEnzymes.filter((e) => targetNames.includes(e.name));
      const hits = findAllCutSites(seq.sequence, targets as never);
      return hits.map((h) => ({
        enzymeName: h.enzyme.name,
        recognitionStart: h.recognitionStart,
        recognitionEnd: h.recognitionEnd,
        cutPositionTop: h.cutPositionTop,
        cutPositionBottom: h.cutPositionBottom,
        strand: h.strand,
      }));
    },
    seedTablePage: async (rows = 5, cols = 5): Promise<string> => {
      const pageStore = usePageStore.getState();
      await pageStore.initialize();
      const pageId = await pageStore.createPage(' table E2E');

      const refId = `table-${Date.now()}`;
      const cells = Array.from({ length: rows }, () =>
        Array.from({ length: cols }, () => ({ value: '', type: 'text' as const }))
      );

      const content = {
        type: 'doc',
        content: [
          {
            type: 'embed',
            attrs: {
              type: 'table',
              refId,
              data: { rows, cols, cells, name: 'TestTable' },
            },
          },
        ],
      };

      await pageStore.savePage(pageId, content);
      useCanvasStore.getState().openWithSmartPlacement('page', pageId, ' table E2E');
      return pageId;
    },
    openStructureDrawer: async (request: {
      translation: string;
      moleculeType?: import('./features/structure-drawer').StructureMoleculeType;
      cdsLabel?: string;
      entityId?: string;
      skipSteps?: import('./features/structure-drawer').ResolverSource[];
      hints: import('./features/structure-drawer').ResolveHints;
    }): Promise<void> => {
      const activeTarget = Object.values(useCanvasStore.getState().panels).some((panel) =>
        panel.tabs.some(
          (tab) =>
            tab.id === panel.activeTabId &&
            tab.type === 'sequence' &&
            tab.entityId === request.entityId
        )
      );
      if (activeTarget && request.entityId) {
        const { hasViewStructureByLabelHandler } =
          await import('./features/structure-drawer/api/view-structure-handler-registry');
        const deadline = Date.now() + 5_000;
        while (!hasViewStructureByLabelHandler(request.entityId) && Date.now() < deadline)
          await new Promise((resolve) => window.setTimeout(resolve, 16));
        if (!hasViewStructureByLabelHandler(request.entityId))
          throw new Error('Active sequence structure handler did not mount');
      }
      return useStructureDrawerStore.getState().open(request);
    },
    setStructureDrawerResolverResultForTest: (
      result: ResolverResult | null,
      delayMs = 0,
      persistResult = false
    ): void => {
      useStructureDrawerStore.getState().setResolver(async (request, signal) => {
        if (delayMs > 0) {
          await new Promise<void>((resolve, reject) => {
            const timeout = window.setTimeout(resolve, delayMs);
            signal.addEventListener(
              'abort',
              () => {
                window.clearTimeout(timeout);
                reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
              },
              { once: true }
            );
          });
        }
        if (signal.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
        if (result && persistResult) {
          const { setCachedExternalResourceResult } =
            await import('./features/structure-drawer/hooks/useExternalResourceCache');
          await setCachedExternalResourceResult(request, result, signal);
        }
        return { result, cacheHit: false };
      });
    },
    openStructureDrawerForAnnotationLabel: async (
      filePath: string,
      labelToken: string
    ): Promise<{
      ok: boolean;
      reason?: string;
      request?: unknown;
    }> => {
      const { invokeViewStructureByLabelHandler } =
        await import('./features/structure-drawer/api/view-structure-handler-registry');
      return invokeViewStructureByLabelHandler(filePath, labelToken);
    },
    openStructureDrawerForCdsLabel: async (
      filePath: string,
      labelToken: string
    ): Promise<{
      ok: boolean;
      reason?: string;
      request?: unknown;
    }> => {
      const { invokeViewStructureByLabelHandler } =
        await import('./features/structure-drawer/api/view-structure-handler-registry');
      return invokeViewStructureByLabelHandler(filePath, labelToken);
    },
    getStructureDrawerState: () => {
      const s = useStructureDrawerStore.getState();
      return {
        requestId: s.requestId,
        status: s.status,
        request: s.request,
        resolved: s.resolved,
        cacheHit: s.cacheHit,
        currentStep: s.currentStep,
        error: s.error === null ? null : toUserMessage(s.error, 'operation.failed'),
        committedCandidateId: s.committedCandidateId,
        previewCandidateId: s.previewCandidateId,
        candidatePickerOpen: s.candidatePickerOpen,
        isSlowLoad: s.isSlowLoad,
      };
    },
    handleStructureDrawerSlowForTest: (): void => {
      const s = useStructureDrawerStore.getState();
      s.handleViewerSlow(s.requestId);
    },
    forceStructureDrawerError: (
      message: string,
      failedStep:
        | 'pdb_xref'
        | 'uniprot_xref'
        | 'protein_sequence'
        | 'protein_id'
        | 'refseq_xref'
        | 'geneid_xref'
        | 'locus_tag'
        | 'gene_sequence_overlap'
        | 'gene_organism'
    ): void => {
      const s = useStructureDrawerStore.getState();
      s._markError(s.requestId, { code: 'simulated', message, failedStep });
    },
    setHoveredResidue: async (
      entityId: string,
      key: (ResidueLocation & { structureId: string }) | null
    ): Promise<{ ok: boolean; reason?: string }> => {
      const { getWorkspaceResidueStore } =
        await import('./features/structure-drawer/state/hovered-residue-registry');
      const store = getWorkspaceResidueStore(entityId);
      if (!store) return { ok: false, reason: `no workspace mounted for ${entityId}` };
      store.set(key);
      return { ok: true };
    },
    getHoveredResidue: async (
      entityId: string
    ): Promise<(ResidueLocation & { structureId: string }) | null> => {
      const { getWorkspaceResidueStore } =
        await import('./features/structure-drawer/state/hovered-residue-registry');
      const store = getWorkspaceResidueStore(entityId);
      return store?.getSnapshot() ?? null;
    },
    setSequenceCodonHover: async (
      entityId: string,
      codon: { start: number; end: number; strand: 1 | -1 } | null
    ): Promise<{ ok: boolean; reason?: string }> => {
      const { getWorkspaceCodonStore } =
        await import('./features/structure-drawer/state/hovered-codon-registry');
      const store = getWorkspaceCodonStore(entityId);
      if (!store) return { ok: false, reason: `no workspace mounted for ${entityId}` };
      store.set(codon ? { ...codon, source: 'sequence' } : null);
      return { ok: true };
    },
    getSequenceCodonHover: async (
      entityId: string
    ): Promise<{
      start: number;
      end: number;
      strand: 1 | -1;
      source?: 'sequence' | 'structure';
    } | null> => {
      const { getWorkspaceCodonStore } =
        await import('./features/structure-drawer/state/hovered-codon-registry');
      return getWorkspaceCodonStore(entityId)?.getSnapshot() ?? null;
    },
    setSequenceSelectedCodons: async (
      entityId: string,
      codons: ReadonlyArray<CodingDnaSelectionRange>
    ): Promise<{ ok: boolean; reason?: string }> => {
      const { getWorkspaceResidueSelectionsStore } =
        await import('./features/structure-drawer/state/selected-codon-registry');
      const store = getWorkspaceResidueSelectionsStore(entityId);
      if (!store) return { ok: false, reason: `no workspace mounted for ${entityId}` };
      store.set(selectedCodonsToResidueSelections(entityId, codons));
      return { ok: true };
    },
    getSequenceSelectedCodons: async (
      entityId: string
    ): Promise<ReadonlyArray<CodingDnaSelectionRange>> => {
      const { getWorkspaceResidueSelectionsStore } =
        await import('./features/structure-drawer/state/selected-codon-registry');
      return residueSelectionsToCodingDnaRanges(
        getWorkspaceResidueSelectionsStore(entityId)?.getSnapshot() ?? [],
        entityId
      );
    },
    setSequenceResidueSelections: async (
      entityId: string,
      selections: ReadonlyArray<ResidueSelection>
    ): Promise<{ ok: boolean; reason?: string }> => {
      const { getWorkspaceResidueSelectionsStore } =
        await import('./features/structure-drawer/state/selected-codon-registry');
      const store = getWorkspaceResidueSelectionsStore(entityId);
      if (!store) return { ok: false, reason: `no workspace mounted for ${entityId}` };
      store.set(selections);
      return { ok: true };
    },
    getSequenceResidueSelections: async (
      entityId: string
    ): Promise<ReadonlyArray<ResidueSelection>> => {
      const { getWorkspaceResidueSelectionsStore } =
        await import('./features/structure-drawer/state/selected-codon-registry');
      return getWorkspaceResidueSelectionsStore(entityId)?.getSnapshot() ?? [];
    },
    getSequenceResidueSelectionState: async (
      entityId: string
    ): Promise<{ revision: number; selections: ReadonlyArray<ResidueSelection> }> => {
      const { getWorkspaceResidueSelectionsStore } =
        await import('./features/structure-drawer/state/selected-codon-registry');
      const store = getWorkspaceResidueSelectionsStore(entityId);
      return {
        revision: store?.getRevision() ?? 0,
        selections: store?.getSnapshot() ?? [],
      };
    },
    dispatchResidueSelectionCommand: async (
      entityId: string,
      command: ResidueSelectionCommand
    ): Promise<{ ok: boolean; reason?: string; revision?: number }> => {
      const { getWorkspaceResidueSelectionsStore } =
        await import('./features/structure-drawer/state/selected-codon-registry');
      const store = getWorkspaceResidueSelectionsStore(entityId);
      if (!store) return { ok: false, reason: `no workspace mounted for ${entityId}` };
      store.dispatch(command);
      return { ok: true, revision: store.getRevision() };
    },
    getResidueLinkBpRange: async (
      entityId: string
    ): Promise<{ start: number; end: number } | null> => {
      const [
        { getWorkspaceResidueStore },
        { useStructureLinkRegistry },
        { computeResidueLinkBpRange },
      ] = await Promise.all([
        import('./features/structure-drawer/state/hovered-residue-registry'),
        import('./features/structure-drawer/state/use-structure-link-registry'),
        import('./features/structure-drawer/hooks/useResidueLinkOverlays'),
      ]);
      const store = getWorkspaceResidueStore(entityId);
      const hovered = store?.getSnapshot() ?? null;
      const links = useStructureLinkRegistry.getState().links;
      const range = computeResidueLinkBpRange(hovered, links, entityId);
      if (!range) return null;
      return { start: range.start, end: range.end };
    },
    getStructureInteractionState: async (
      structureId: string
    ): Promise<{
      hovered: ResidueLocation | null;
      selected: ResidueLocation[];
      selectedCount: number;
      selectionAnchor: ResidueLocation | null;
    } | null> => {
      const { useStructure3dStore } = await import('./features/page/embeds/structure3d/store');
      const structureStore = useStructure3dStore.getState();
      const interactionKey = resolveStructureInteractionKeyForTestBridge(
        structureId,
        structureStore.expandedStructures
      );
      const state = structureStore.interactionState[interactionKey];
      if (!state) return null;
      return {
        hovered: state.hovered ?? null,
        selected: state.selected,
        selectedCount: state.selected.length,
        selectionAnchor: structureStore.selectionAnchor[interactionKey] ?? null,
      };
    },
    getActiveStructureCameraSnapshotForTest: async (
      structureKey: string
    ): Promise<
      | { ok: true; snapshot: unknown }
      | { ok: false; code?: string; message: string; details?: unknown }
    > => {
      const { withActivePlugin } = await import('./features/page/embeds/structure3d/viewerCache');
      try {
        return await withActivePlugin(structureKey, ({ plugin }) => {
          const snapshot = plugin.canvas3d?.camera?.getSnapshot?.() ?? null;
          return {
            ok: true as const,
            snapshot: JSON.parse(JSON.stringify(snapshot)),
          };
        });
      } catch (error) {
        const record = error as { code?: unknown; message?: unknown; details?: unknown };
        return {
          ok: false,
          code: typeof record.code === 'string' ? record.code : undefined,
          message: toUserMessage(record, 'operation.failed'),
          details: record.details,
        };
      }
    },
    getActiveStructureCoordinateDigestForTest: async (structureKey: string): Promise<string> => {
      const [{ withActivePlugin }, { getMolViewSpecCoordinates }, { coordinateDigest }] =
        await Promise.all([
          import('./features/page/embeds/structure3d/viewerCache'),
          import('./features/page/embeds/structure3d/molstar/molViewSpec'),
          import('./shared/molecular-view'),
        ]);
      return withActivePlugin(structureKey, ({ plugin }) =>
        coordinateDigest(getMolViewSpecCoordinates(plugin).text)
      );
    },
    beginMolecularEditObservationForTest: async (structureKey: string, cacheKey?: string) => {
      const { withActivePlugin } = await import('./features/page/embeds/structure3d/viewerCache');
      const { observeMolecularEdits } =
        await import('./features/page/embeds/structure3d/molstar/molecularEditObservation');
      const holder = window as unknown as {
        __MOLECULAR_EDIT_OBSERVER__?: ReturnType<typeof observeMolecularEdits>;
      };
      holder.__MOLECULAR_EDIT_OBSERVER__?.stop();
      await withActivePlugin(
        structureKey,
        ({ plugin }) => {
          holder.__MOLECULAR_EDIT_OBSERVER__ = observeMolecularEdits(plugin);
        },
        { cacheKey }
      );
      return { ok: true };
    },
    readMolecularEditObservationForTest: async (stop = false) => {
      const holder = window as unknown as {
        __MOLECULAR_EDIT_OBSERVER__?: { read(): unknown; stop(): void };
      };
      const result = holder.__MOLECULAR_EDIT_OBSERVER__?.read();
      if (stop) {
        holder.__MOLECULAR_EDIT_OBSERVER__?.stop();
        delete holder.__MOLECULAR_EDIT_OBSERVER__;
      }
      return result;
    },
    getActiveStructureColorSamplesForTest: async (
      structureKey: string,
      includeAtoms = false,
      cacheKey?: string,
      backboneOnly = false
    ) => {
      const { withActivePlugin } = await import('./features/page/embeds/structure3d/viewerCache');
      const { StructureElement, Unit } = await import('molstar/lib/mol-model/structure');
      const { extractEffectiveChainInfo } =
        await import('./features/page/embeds/structure3d/utils/molstarChainUtils');
      const { chainInstanceIdForIdentity } =
        await import('./features/page/embeds/structure3d/utils/structureIds');
      return withActivePlugin(
        structureKey,
        ({ plugin }) => {
          const samples = new Map<
            string,
            {
              unitId: number;
              modelNumber: number;
              labelAsymId: string;
              authAsymId: string;
              chainInstanceId: string | null;
              authSeqId: number;
              labelSeqId: number;
              colors: number[];
              atomId?: number;
              atomName?: string;
            }
          >();
          for (const structure of plugin.managers.structure.hierarchy.current.structures) {
            for (const component of structure.components) {
              for (const ref of component.representations) {
                const repr = ref.cell.obj?.data.repr;
                if (!repr?.state.visible || !('color' in repr.theme.color)) continue;
                if (backboneOnly) {
                  const type = ref.cell.params?.values.type.name;
                  const visuals = repr.props.visuals;
                  if (
                    type !== 'backbone' &&
                    (type !== 'cartoon' ||
                      (Array.isArray(visuals) && !visuals.includes('polymer-trace')))
                  )
                    continue;
                }
                if (
                  !repr.renderObjects.some(
                    (object) =>
                      object.state.visible &&
                      object.values.drawCount.ref.value > 0 &&
                      object.values.uAlpha.ref.value > 0
                  )
                )
                  continue;
                const theme = repr.theme.color;
                repr.eachLocation((location, secondary) => {
                  if (!StructureElement.Location.is(location) || !Unit.isAtomic(location.unit))
                    return;
                  const { unit, element } = location;
                  const residueIndex = unit.residueIndex[element];
                  const chainIndex = unit.chainIndex[element];
                  const hierarchy = unit.model.atomicHierarchy;
                  const chainInfo = extractEffectiveChainInfo(unit, hierarchy.chains, chainIndex);
                  if (
                    backboneOnly &&
                    hierarchy.derived.residue.traceElementIndex[residueIndex] !== element
                  )
                    return;
                  const key = `${unit.model.id}:${unit.id}:${includeAtoms ? element : residueIndex}`;
                  const sample: NonNullable<ReturnType<typeof samples.get>> = samples.get(key) ?? {
                    unitId: unit.id,
                    modelNumber: unit.model.modelNum,
                    labelAsymId: hierarchy.chains.label_asym_id.value(chainIndex),
                    authAsymId: hierarchy.chains.auth_asym_id.value(chainIndex),
                    chainInstanceId: chainInfo
                      ? chainInstanceIdForIdentity({
                          ...chainInfo,
                          chainId: chainInfo.effectiveChainId,
                        })
                      : null,
                    authSeqId: hierarchy.residues.auth_seq_id.value(residueIndex),
                    labelSeqId: hierarchy.residues.label_seq_id.value(residueIndex),
                    colors: [],
                    ...(includeAtoms
                      ? {
                          atomId: unit.model.atomicConformation.atomId.value(element),
                          atomName: hierarchy.atoms.label_atom_id.value(element),
                        }
                      : {}),
                  };
                  const color = theme.color(location, secondary);
                  if (!sample.colors.includes(color)) sample.colors.push(color);
                  samples.set(key, sample);
                });
              }
            }
          }
          return [...samples.values()].map((sample) => ({
            ...sample,
            colors: sample.colors.sort((a, b) => a - b),
          }));
        },
        { cacheKey }
      );
    },
    getActiveMolstarSelectedResiduesForTest: async (
      structureKey: string
    ): Promise<
      | {
          ok: true;
          residues: Array<{
            chain: string;
            position: number;
            labelSeqId: number | null;
            compId: string;
            selectedAtomCount: number;
            totalResidueAtomCount: number;
            baseChain?: string;
            labelAsymId?: string;
            authAsymId?: string;
            entityId?: string;
            operator?: string;
          }>;
          elementCount: number | null;
          statsLabel: string | null;
        }
      | { ok: false; code?: string; message: string; details?: unknown }
    > => {
      const [{ withActivePlugin }, { extractMolstarSelectionReadback }] = await Promise.all([
        import('./features/page/embeds/structure3d/viewerCache'),
        import('./features/page/embeds/structure3d/utils/molstarSelectionReadback'),
      ]);
      try {
        return await withActivePlugin(structureKey, ({ plugin }) => {
          const readback = extractMolstarSelectionReadback(plugin);
          return {
            ok: true as const,
            residues: readback.residues,
            elementCount: readback.elementCount,
            statsLabel: readback.statsLabel,
          };
        });
      } catch (error) {
        const record = error as { code?: unknown; message?: unknown; details?: unknown };
        return {
          ok: false,
          code: typeof record.code === 'string' ? record.code : undefined,
          message: toUserMessage(record, 'operation.failed'),
          details: record.details,
        };
      }
    },
    clearStructureSelectionForTest: async (structureId: string): Promise<void> => {
      const { useStructure3dStore } = await import('./features/page/embeds/structure3d/store');
      const structureStore = useStructure3dStore.getState();
      structureStore.clearSelection(
        resolveStructureInteractionKeyForTestBridge(structureId, structureStore.expandedStructures)
      );
    },
    getStructureResidueSessionsForTest: async () => {
      const { useStructureResidueSessionRegistry } =
        await import('./features/structure-drawer/state/structure-residue-session-registry');
      return useStructureResidueSessionRegistry.getState().sessions;
    },
    getStructureDrawerSelectedResidueDomForTest: (structureId?: string) => {
      const drawerRoot = document.querySelector('[data-testid="structure-drawer-content"]');
      const root = structureId
        ? (Array.from(
            (drawerRoot ?? document).querySelectorAll('[data-testid="structure-3d-panel"]')
          ).find(
            (node): node is HTMLElement =>
              node instanceof HTMLElement && node.getAttribute('data-structure-id') === structureId
          ) ??
          Array.from(document.querySelectorAll('[data-testid="structure-3d-panel"]')).find(
            (node): node is HTMLElement =>
              node instanceof HTMLElement && node.getAttribute('data-structure-id') === structureId
          ))
        : (drawerRoot ?? document);
      if (!root) return [];
      return Array.from(root.querySelectorAll('[data-testid^="residue-"]'))
        .filter((node): node is HTMLElement => node instanceof HTMLElement)
        .filter((node) => node.getAttribute('data-state') === 'selected')
        .map((node) => ({
          testId: node.getAttribute('data-testid'),
          chain: node.getAttribute('data-chain-id'),
          position: Number(node.getAttribute('data-position')),
          baseChain: node.getAttribute('data-base-chain') || undefined,
          labelAsymId: node.getAttribute('data-label-asym-id') || undefined,
          authAsymId: node.getAttribute('data-auth-asym-id') || undefined,
          entityId: node.getAttribute('data-entity-id') || undefined,
          operator: node.getAttribute('data-operator') || undefined,
          text: node.textContent,
        }));
    },
    getStructureAttrsForTest: async (structureId: string): Promise<Structure3dAttrs | null> => {
      const { useStructure3dStore } = await import('./features/page/embeds/structure3d/store');
      const structureStore = useStructure3dStore.getState();
      const structureKey = resolveStructureRegistrationKeyForTestBridge(
        structureId,
        structureStore.expandedStructures
      );
      return structureStore.expandedStructures[structureKey]?.data ?? null;
    },
    updateStructureAttrsForTest: async (
      structureId: string,
      attrs: Structure3dAttrs
    ): Promise<{ ok: boolean; reason?: string }> => {
      const { useStructure3dStore } = await import('./features/page/embeds/structure3d/store');
      const structureStore = useStructure3dStore.getState();
      const structureKey = resolveStructureRegistrationKeyForTestBridge(
        structureId,
        structureStore.expandedStructures
      );
      if (!structureStore.expandedStructures[structureKey]) {
        return { ok: false, reason: `No structure registered for ${structureId}` };
      }
      structureStore.updateStructureData(structureKey, attrs);
      return { ok: true };
    },
    setStructureSideChainVisibilityForTest: async (
      structureId: string,
      target: 'visibleBackbones' | 'selection',
      visible: boolean
    ): Promise<{ ok: boolean; reason?: string }> => {
      const [{ useStructure3dStore }, { attrsPatchFromStructureViewCommand }] = await Promise.all([
        import('./features/page/embeds/structure3d/store'),
        import('./features/page/embeds/structure3d/utils/structureViewCommands'),
      ]);
      const structureStore = useStructure3dStore.getState();
      const structureKey = resolveStructureRegistrationKeyForTestBridge(
        structureId,
        structureStore.expandedStructures
      );
      const entry = structureStore.expandedStructures[structureKey];
      if (!entry) return { ok: false, reason: `No structure registered for ${structureId}` };
      const patch = attrsPatchFromStructureViewCommand({
        attrs: entry.data,
        command: { type: 'set-side-chain-visibility', target, visible },
      });
      if (!patch) return { ok: false, reason: 'Could not update side-chain visibility' };
      structureStore.updateStructureData(structureKey, {
        ...entry.data,
        ...patch,
      });
      return { ok: true };
    },
    getStructureSideChainVisibilityForTest: async (
      structureId: string
    ): Promise<{ visibleBackbones: boolean; selection: boolean } | null> => {
      const [{ useStructure3dStore }, { structureViewStateFromAttrs }] = await Promise.all([
        import('./features/page/embeds/structure3d/store'),
        import('./features/page/embeds/structure3d/utils/viewRecipe'),
      ]);
      const structureStore = useStructure3dStore.getState();
      const structureKey = resolveStructureRegistrationKeyForTestBridge(
        structureId,
        structureStore.expandedStructures
      );
      const entry = structureStore.expandedStructures[structureKey];
      if (!entry) return null;
      const sideChains = structureViewStateFromAttrs(entry.data).residueVisualization?.sideChains;
      return {
        visibleBackbones: sideChains?.visibleBackbones ?? false,
        selection: sideChains?.selection ?? false,
      };
    },
    clearStructureBytesCacheForTest: async (): Promise<void> => {
      const { _clearAllForTesting } =
        await import('./features/page/embeds/structure3d/utils/structureDataCache');
      await _clearAllForTesting();
    },
    selectStructureResidue: async (
      structureId: string,
      residue: ResidueLocation,
      extend?: boolean
    ): Promise<void> => {
      const { useStructure3dStore } = await import('./features/page/embeds/structure3d/store');
      const structureStore = useStructure3dStore.getState();
      structureStore.selectResidue(
        resolveStructureInteractionKeyForTestBridge(structureId, structureStore.expandedStructures),
        residue,
        extend ? 'toggle' : 'replace'
      );
    },
    getStructurePluginSummary: async (structureKey?: string) => {
      const { getStructurePluginSummary } =
        await import('./features/page/embeds/structure3d/molstar/cache');
      return getStructurePluginSummary(structureKey);
    },
    getStructureSpinDiagnostics: async (structureKey?: string) => {
      const { getStructureSpinDiagnostics } =
        await import('./features/page/embeds/structure3d/molstar/cache');
      return getStructureSpinDiagnostics(structureKey);
    },
    requestStructureDrawDiagnostics: async (structureKey?: string) => {
      const { requestStructureDrawDiagnostics } =
        await import('./features/page/embeds/structure3d/molstar/cache');
      return requestStructureDrawDiagnostics(structureKey);
    },
    getStructureRepresentationDiagnostics: async (structureKey?: string) => {
      const { getStructureRepresentationDiagnostics } =
        await import('./features/page/embeds/structure3d/molstar/cache');
      return getStructureRepresentationDiagnostics(structureKey);
    },
    getStructureChainInventoryDiagnostics: async (structureKey?: string) => {
      const { getStructureChainInventoryDiagnostics } =
        await import('./features/page/embeds/structure3d/molstar/cache');
      return getStructureChainInventoryDiagnostics(structureKey);
    },
    getStructureViewerCacheLifecycleDiagnostics: async () => {
      const { getViewerCacheLifecycleDiagnostics } =
        await import('./features/page/embeds/structure3d/molstar/cache');
      return getViewerCacheLifecycleDiagnostics();
    },
    getAnnotationViewportDetailAuthLifecycleSnapshot,
    getAlignmentAutoLoadLifecycleSnapshot,
    getStructureRenderTransactionDiagnostics: async (keyIncludes?: string) => {
      const { getStructureRenderTransactionDiagnostics } =
        await import('./features/page/embeds/structure3d/utils/structureRenderTransactionDiagnostics');
      return getStructureRenderTransactionDiagnostics(keyIncludes);
    },
    setStructureHovered: async (
      structureId: string,
      residue: { chain: string; position: number; compId?: string } | null
    ): Promise<void> => {
      const { useStructure3dStore } = await import('./features/page/embeds/structure3d/store');
      useStructure3dStore.getState().setHovered(structureId, residue);
    },
    registerStructureHoverBridge: async (
      entityId: string,
      structureId: string
    ): Promise<{ ok: boolean; reason?: string }> => {
      const [
        { getWorkspaceResidueStore },
        { useStructure3dStore },
        {
          createDeferredStructureHoverSync,
          decideInboundDispatch,
          decideOutboundWrite,
          shouldClearInboundHover,
          shouldClearOnUnmount,
        },
      ] = await Promise.all([
        import('./features/structure-drawer/state/hovered-residue-registry'),
        import('./features/page/embeds/structure3d/store'),
        import('./features/page/embeds/structure3d/hooks/residue-hover-bridge'),
      ]);
      const store = getWorkspaceResidueStore(entityId);
      if (!store) return { ok: false, reason: `no workspace mounted for ${entityId}` };

      const key = structureHoverBridgeKey(entityId, structureId);
      structureHoverBridgeDisposers.get(key)?.();

      const outboundSync = createDeferredStructureHoverSync(store);
      let lastInboundHover: {
        structureId: string;
        residue: { chain: string; position: number; compId?: string };
      } | null = null;
      let lastLocal = useStructure3dStore.getState().interactionState[structureId]?.hovered ?? null;
      const unsubscribeStructure = useStructure3dStore.subscribe((state) => {
        const nextLocal = state.interactionState[structureId]?.hovered ?? null;
        if (sameStructureHoverForTestBridge(nextLocal, lastLocal)) return;
        lastLocal = nextLocal;
        outboundSync.schedule(decideOutboundWrite(nextLocal, structureId));
      });
      const unsubscribeResidue = store.subscribe(() => {
        const local = useStructure3dStore.getState().interactionState[structureId]?.hovered;
        const snapshot = store.getSnapshot();
        const dispatch = decideInboundDispatch(snapshot, structureId, local);
        if (dispatch) {
          lastInboundHover = { structureId, residue: dispatch };
          useStructure3dStore.getState().setHovered(structureId, dispatch);
          return;
        }
        if (shouldClearInboundHover(snapshot, structureId, local, lastInboundHover)) {
          lastInboundHover = null;
          useStructure3dStore.getState().setHovered(structureId, null);
        }
      });

      const dispose = () => {
        unsubscribeStructure();
        unsubscribeResidue();
        outboundSync.dispose();
        if (shouldClearOnUnmount(store.getSnapshot(), structureId)) {
          store.set(null);
        }
        structureHoverBridgeDisposers.delete(key);
      };
      structureHoverBridgeDisposers.set(key, dispose);
      return { ok: true };
    },
    clearStructureHoverBridges: (): void => {
      for (const dispose of [...structureHoverBridgeDisposers.values()]) {
        dispose();
      }
      structureHoverBridgeDisposers.clear();
    },
    registerStructureSelectionBridge: async (
      entityId: string,
      structureId: string,
      ownerId?: string
    ): Promise<{ ok: boolean; reason?: string }> => {
      const [
        { getWorkspaceResidueSelectionsStore },
        { useStructure3dStore },
        { useStructureLinkRegistry },
        {
          applyStructureSelectionIntentToResidueSelections,
          residueLocationsKey,
          residueSelectionsToStructureResidues,
          sameResidueLocations,
        },
      ] = await Promise.all([
        import('./features/structure-drawer/state/selected-codon-registry'),
        import('./features/page/embeds/structure3d/store'),
        import('./features/structure-drawer/state/use-structure-link-registry'),
        import('./features/page/embeds/structure3d/utils/residueSelectionBridge'),
      ]);
      const store = getWorkspaceResidueSelectionsStore(entityId);
      if (!store) return { ok: false, reason: `no workspace mounted for ${entityId}` };
      const link = useStructureLinkRegistry.getState().getLink(structureId, ownerId);
      if (!link) return { ok: false, reason: `no structure link registered for ${structureId}` };

      const key = structureHoverBridgeKey(entityId, structureId, ownerId);
      structureSelectionBridgeDisposers.get(key)?.();

      let lastInboundSelectionKey: string | null = null;
      const currentLink = () => {
        const activeLink = useStructureLinkRegistry.getState().getLink(structureId, ownerId);
        if (!activeLink || activeLink.sequenceDocumentId !== link.sequenceDocumentId) return null;
        return activeLink;
      };

      const syncInbound = () => {
        const activeLink = currentLink();
        if (!activeLink) return;
        const selections = store.getSnapshot();
        const nextSelected = residueSelectionsToStructureResidues({
          structureId,
          link: activeLink,
          selections,
        });
        const nextKey = residueLocationsKey(nextSelected);
        lastInboundSelectionKey = nextKey;
        const localSelected =
          useStructure3dStore.getState().interactionState[structureId]?.selected ?? [];
        if (sameResidueLocations(localSelected, nextSelected)) return;
        useStructure3dStore
          .getState()
          .setSelected(
            structureId,
            nextSelected,
            nextSelected.length > 0 ? nextSelected[nextSelected.length - 1] : null
          );
      };

      const syncOutbound = () => {
        const activeLink = currentLink();
        if (!activeLink) return;
        const state = useStructure3dStore.getState();
        const selectedResidues = state.interactionState[structureId]?.selected ?? [];
        if (lastInboundSelectionKey === residueLocationsKey(selectedResidues)) return;
        const cur = store.getSnapshot();
        const next = applyStructureSelectionIntentToResidueSelections({
          structureId,
          link: activeLink,
          currentSelections: cur,
          selectedResidues,
        });
        store.set(next);
      };

      const unsubscribeStructure = useStructure3dStore.subscribe(syncOutbound);
      const unsubscribeResidueSelections = store.subscribe(syncInbound);
      const dispose = () => {
        unsubscribeStructure();
        unsubscribeResidueSelections();
        structureSelectionBridgeDisposers.delete(key);
      };
      structureSelectionBridgeDisposers.set(key, dispose);
      syncInbound();
      return { ok: true };
    },
    clearStructureSelectionBridges: (): void => {
      for (const dispose of [...structureSelectionBridgeDisposers.values()]) {
        dispose();
      }
      structureSelectionBridgeDisposers.clear();
    },
    registerStructureLink: async (entry: {
      structureId: string;
      ownerId?: string;
      sequenceDocumentId: string;
      cdsLabel: string;
      cdsFeatureId?: string;
      translation: string;
      cdsStart: number;
      cdsEnd: number;
      strand: 1 | -1;
      residueTarget?: {
        chain: string;
        baseChain?: string;
        labelAsymId?: string;
        authAsymId?: string;
        entityId?: string;
        operator?: string;
        residueMappingKind?: 'identity';
        residues?: Array<{ residueIndex: number; position: number }>;
      };
      residueTargets?: Array<{
        chain: string;
        baseChain?: string;
        labelAsymId?: string;
        authAsymId?: string;
        entityId?: string;
        operator?: string;
        residueMappingKind?: 'identity';
        residues?: Array<{ residueIndex: number; position: number }>;
      }>;
      residueMolecule?: {
        moleculeId: string;
        moleculeKind: string;
        label?: string;
      };
    }): Promise<void> => {
      const { useStructureLinkRegistry } =
        await import('./features/structure-drawer/state/use-structure-link-registry');
      useStructureLinkRegistry.getState().registerLink(entry);
    },
    getStructureLinksForTest: async (): Promise<Record<string, unknown>> => {
      const { useStructureLinkRegistry } =
        await import('./features/structure-drawer/state/use-structure-link-registry');
      return useStructureLinkRegistry.getState().links;
    },
    clearStructureLinks: async (): Promise<void> => {
      const { useStructureLinkRegistry } =
        await import('./features/structure-drawer/state/use-structure-link-registry');
      useStructureLinkRegistry.setState({ links: {} });
    },
  };
}

const __harnessParam__ = new URLSearchParams(window.location.search).get('harness');
const isHarness = __harnessParam__ !== null;
const isMultiLaneHarness = __harnessParam__ === 'multilane';

function showHarnessStartupError(error: unknown): void {
  console.error('[Startup] fonts failed:', error);
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <StartupSurface stage="fonts" error={error} />
  );
}

if (new URLSearchParams(window.location.search).has('proteinExperimentWorker')) {
  void import('./features/ai/molecular-experiment-worker')
    .then(({ bootMolecularExperimentWorker }) => bootMolecularExperimentWorker())
    .catch((error) => console.error('[Protein experiment] Worker startup failed:', error));
} else if (__importPickerDesignMode__) {
  import('./design-lab/import-picker/ImportPickerComparisonPage').then(
    ({ ImportPickerComparisonPage }) => {
      ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
        <React.StrictMode>
          <ImportPickerComparisonPage />
        </React.StrictMode>
      );
    }
  );
} else if (isMultiLaneHarness) {
  Promise.all([prepareSequenceFonts(), import('./harness/MultiLaneHarnessPage')])
    .then(([, { MultiLaneHarnessPage }]) => {
      ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
        <React.StrictMode>
          <MultiLaneHarnessPage />
        </React.StrictMode>
      );
    })
    .catch(showHarnessStartupError);
} else if (__searchParams__.has('terminal-window') && 'electronAPI' in window) {
  Promise.all([
    initPlatform(),
    prepareSequenceFonts(),
    import('./features/terminal/TerminalWindow'),
  ])
    .then(([, , { TerminalWindow }]) => {
      ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
        <React.StrictMode>
          <TerminalWindow groupId={__searchParams__.get('terminal-window')!} />
        </React.StrictMode>
      );
    })
    .catch(showHarnessStartupError);
} else if (isHarness) {
  Promise.all([prepareSequenceFonts(), import('./harness/HarnessPage')])
    .then(([, { HarnessPage }]) => {
      ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
        <React.StrictMode>
          <HarnessPage />
        </React.StrictMode>
      );
    })
    .catch(showHarnessStartupError);
} else {
  const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);
  const macTeamIdCutoverEnabled = __DNAFORGE_MAC_TEAM_ID_CUTOVER__;
  const macTeamIdCutoverBlocked = shouldShowMacTeamIdCutoverBlocker({
    cutoverEnabled: macTeamIdCutoverEnabled,
    navigatorPlatform: window.navigator.platform,
  });

  if (macTeamIdCutoverBlocked) {
    root.render(
      <React.StrictMode>
        <MacTeamIdCutoverBlocker />
      </React.StrictMode>
    );
  } else {
    let stage: StartupStage = 'fonts';
    root.render(<StartupSurface stage={stage} />);
    void (async () => {
      await prepareSequenceFonts();
      stage = 'platform';
      root.render(<StartupSurface stage={stage} />);
      await initPlatform();
      const { loadId } = await platform().startup.getState();
      stage = 'listeners';
      root.render(<StartupSurface stage={stage} />);
      if (isBrowserOnly() && import.meta.env.DEV) {
        const { initializeTestSchema } = await import('./test/initializeTestSchema');
        await initializeTestSchema();
      }
      const { initDirtyReporter, initSaveAllHandler, saveAllUnsavedWork } =
        await import('./shared/dirty-reporter');
      const { startUnsavedSequenceRecovery } =
        await import('./features/sequence/unsaved-sequence-recovery');
      const { offerUnsavedNewDrafts } = await import('./shared/unsaved-draft-recovery');
      const { installLegacyUnsavedDiscard } = await import('./services/legacy-unsaved-discard');
      const { installBlankWindowFallback } = await import('./startup/blank-window-fallback');
      const { installRendererAgentBridge } =
        await import('./features/agent-bridge/install-renderer-agent-bridge');
      const { installMigrationRenderValidationProbe } =
        await import('./features/benchling-migration/install-render-validation');
      const { startDesignArtifactMirroring } =
        await import('./features/design/design-artifact-mirror');
      const { handleWorkspaceRendererMutationWithStores } =
        await import('./services/workspace-renderer-mutation');
      const { installNativeDocumentWorkspacePublisher, deferNativeDocumentWorkspaceStartup } =
        await import('./services/native-document-workspaces');
      const releaseNativeDocumentStartup = isBrowserOnly()
        ? () => {}
        : deferNativeDocumentWorkspaceStartup();
      startupDisposers.push(releaseNativeDocumentStartup);
      let nativeWorkspacesPublished = false;
      let newDraftsOffered = false;
      const { installReferenceVersionUsageTracking } =
        await import('./features/sequence/reference-version-usage');
      startupDisposers.push(observeEntityViews());
      startupDisposers.push(installReferenceVersionUsageTracking());
      startupDisposers.push(initDirtyReporter());
      startupDisposers.push(initSaveAllHandler());
      startupDisposers.push(startUnsavedSequenceRecovery());
      startupDisposers.push(installLegacyUnsavedDiscard());
      startupDisposers.push(
        installBlankWindowFallback(document.getElementById('root') as HTMLElement, {
          saveAll: saveAllUnsavedWork,
        })
      );
      rendererAgentBridgeDisposer = installRendererAgentBridge();
      startupDisposers.push(() => {
        rendererAgentBridgeDisposer?.();
        rendererAgentBridgeDisposer = null;
      });
      startupDisposers.push(installMigrationRenderValidationProbe());
      startupDisposers.push(startDesignArtifactMirroring());
      startupDisposers.push(
        platform().workspaceMutations.onLifecycle(handleWorkspaceRendererMutationWithStores)
      );
      stage = 'shell';
      const { useAISettingsStore } = await import('./features/ai/settings');
      void usePageStore.getState().initialize();
      void useAISettingsStore.getState().initialize();
      root.render(
        <React.StrictMode>
          <ErrorBoundary
            fallback={
              <StartupSurface
                stage="shell"
                error="A display error stopped the workspace from rendering."
              />
            }
          >
            <Providers>
              <CommandScopeProvider>
                <App
                  onShellReady={async () => {
                    const accepted = await platform().startup.acknowledge(loadId);
                    if (!accepted)
                      throw new Error('This application load was replaced. Reload to reconnect.');
                    if (!newDraftsOffered) {
                      newDraftsOffered = true;
                      void import('./features/canvas/store')
                        .then(({ useCanvasStore }) =>
                          offerUnsavedNewDrafts((draft) => {
                            useCanvasStore
                              .getState()
                              .openInFocusedPanel(
                                draft.tabType,
                                `${draft.tabType}-draft:${crypto.randomUUID()}`,
                                draft.label,
                                {
                                  artifactDocument: draft.artifactDocument,
                                  recoveredDraft: draft.fields,
                                }
                              );
                          })
                        )
                        .catch((error: unknown) =>
                          console.warn('[Startup] Could not offer recovered drafts:', error)
                        );
                    }
                    if (!isBrowserOnly() && !nativeWorkspacesPublished) {
                      nativeWorkspacesPublished = true;
                      startupDisposers.push(installNativeDocumentWorkspacePublisher(loadId));
                      releaseNativeDocumentStartup();
                    }
                  }}
                />
              </CommandScopeProvider>
            </Providers>
          </ErrorBoundary>
        </React.StrictMode>
      );
    })().catch((error: unknown) => {
      disposeRendererStartup();
      console.error(`[Startup] ${stage} failed:`, error);
      root.render(<StartupSurface stage={stage} error={error} />);
    });
  }
}

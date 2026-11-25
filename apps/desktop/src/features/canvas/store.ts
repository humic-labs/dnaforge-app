import { CHAT_FIRST_INPUT } from '../../lib/chat-first-input';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { isKnownTabType, TAB_TYPES } from './types';
import type {
  Tab,
  CanvasTabIdentity,
  TabUpdates,
  TabType,
  TabViewState,
  PanelState,
  LayoutNode,
  CanvasState,
  RecentlyClosedTab,
} from './types';
import { debugLog, debugWarn } from '../../utils/debug-log';
import {
  fileBackedTabPath,
  isMissingFileError,
  scanTabsForOversize,
  shouldRevalidateFileTabOnReopen,
  sameFileTabReadAuthority,
} from './oversize-scan';
import { pathIsAtOrUnder, rebasePath } from '../../shared/path-boundary';
import { looksLikeWorkspacePath } from '../../shared/resolve-entity-path';
import {
  sequenceDocumentKey,
  type SequenceDocumentRef,
} from '../../shared/managed-sequence-document';
import {
  isEphemeralArtifactDraft,
  isTabDirty,
  shouldRememberClosedTab,
} from './artifact-document-lifecycle';
import { recordSequenceTabCloseGesture } from '../../shared/tab-close-gesture';
import { cancelPendingPdfRead } from '../pdf/public/pending-read';
import { sequenceDisplayName } from '../../shared/sequence-presentation';
import { newCanvasNavigationOperation, observeCanvasLayout } from './navigation-observation';

const DEFAULT_PANEL_ID = 'main';

function normalizeSequenceTab<T extends Pick<Tab, 'type' | 'label'>>(tab: T): T {
  if (tab.type !== 'sequence') return tab;
  const label = sequenceDisplayName(tab.label);
  return label === tab.label ? tab : { ...tab, label };
}

function normalizeTabUpdates(tab: Tab, updates: Partial<Tab>): Partial<Tab> {
  const normalized = normalizeIndexedGenomeUpdate(tab, updates);
  if ((normalized.type ?? tab.type) !== 'sequence') return normalized;
  return { ...normalized, label: sequenceDisplayName(normalized.label ?? tab.label) };
}

function assertKnownTabType(tab: Pick<Tab, 'type'>): void {
  if (isKnownTabType(tab.type)) return;
  const described =
    tab.type === null || typeof tab.type !== 'object'
      ? JSON.stringify(tab.type)
      : `an object (${Object.keys(tab.type as object)
          .slice(0, 5)
          .join(', ')})`;
  throw new Error(
    `Unknown tab type: ${described}. Expected one of: ${TAB_TYPES.join(', ')}. ` +
      `openTab takes (panelId, { type, entityId, label }); openWithSmartPlacement ` +
      `takes (type, entityId, label) positionally.`
  );
}

function assertLogicalSequenceTab(
  tab: Pick<Tab, 'type' | 'entityId' | 'sequenceDocument' | 'assemblyEditDesignId'>
): void {
  if (tab.type !== 'sequence') {
    if (tab.sequenceDocument || tab.assemblyEditDesignId)
      throw new Error('Only sequence tabs accept a sequence document or assembly edit session.');
    return;
  }
  if (looksLikeWorkspacePath(tab.entityId)) {
    throw new Error(
      `Sequence tabs require a logical document ID; a filesystem path was supplied: ${tab.entityId}`
    );
  }
  if (!tab.sequenceDocument) {
    throw new Error('Sequence tabs require a stable document reference.');
  }
  if (sequenceDocumentKey(tab.sequenceDocument) !== tab.entityId) {
    throw new Error('Sequence tab identity does not match its document reference.');
  }
}

function assertPresentationUpdates(updates: TabUpdates): void {
  for (const key of ['id', 'type', 'entityId', 'sequenceDocument', 'assemblyEditDesignId']) {
    if (Object.hasOwn(updates, key))
      throw new Error(`Use a canvas identity or assembly-edit command to change ${key}.`);
  }
}

function retargetTabDocument(tab: Tab, identity: CanvasTabIdentity, updates: TabUpdates): Tab {
  assertPresentationUpdates(updates);
  const entityId =
    identity.type === 'sequence'
      ? sequenceDocumentKey(identity.sequenceDocument)
      : identity.entityId;
  const next: Tab = {
    ...tab,
    ...(tab.type !== identity.type
      ? {
          viewState: undefined,
          pendingViewState: undefined,
          loadStatus: undefined,
          initialStructureAttrs: undefined,
          molecularViewReferenceId: undefined,
          structureInspection: undefined,
          predictionResult: undefined,
          proteinRunPreview: undefined,
          artifactDocument: undefined,
          recoveredDraft: undefined,
          tableDocument: undefined,
        }
      : {}),
    ...(identity.type !== 'sequence'
      ? {
          indexedGenome: undefined,
          trackView: undefined,
          openingTrackViewPath: undefined,
          initialAnnotationMapperPolicy: undefined,
          legacyMigrationRead: undefined,
          legacyFasta: undefined,
          quickLookSource: undefined,
        }
      : {}),
    type: identity.type,
    entityId,
    structureRenderError:
      tab.type === identity.type && tab.entityId === entityId
        ? tab.structureRenderError
        : undefined,
    sequenceDocument: identity.type === 'sequence' ? identity.sequenceDocument : undefined,
    assemblyEditDesignId:
      tab.type === identity.type && tab.entityId === entityId
        ? tab.assemblyEditDesignId
        : undefined,
    ...updates,
  };
  assertKnownTabType(next);
  assertLogicalSequenceTab(next);
  return normalizeSequenceTab({ ...next, ...normalizeIndexedGenomeUpdate(tab, updates) });
}

const MAX_RECENTLY_CLOSED = 20;

function pushRecentlyClosed(
  existing: RecentlyClosedTab[] | undefined,
  entries: RecentlyClosedTab[]
): RecentlyClosedTab[] {
  const base = existing ?? [];
  const recoverableEntries = entries
    .filter((entry) => shouldRememberClosedTab(entry.tab))
    .map(({ tab: { structureRenderError: _renderError, ...tab }, ...entry }) => ({
      ...entry,
      tab,
    }));
  if (recoverableEntries.length === 0) return base;
  const next = [...base, ...recoverableEntries];
  return next.length > MAX_RECENTLY_CLOSED ? next.slice(next.length - MAX_RECENTLY_CLOSED) : next;
}

function recordRemovedTabs(tabs: readonly Tab[]): void {
  for (const tab of tabs) {
    if (tab.type === 'sequence') recordSequenceTabCloseGesture(tab.id);
    if (tab.type === 'pdf') cancelPendingPdfRead(tab.id);
  }
}
const LEGACY_CHAT_CONVERSATION_IDS = new Set(['agent-trace-cli-conversation']);

export function isLegacyChatConversationId(conversationId: string): boolean {
  return LEGACY_CHAT_CONVERSATION_IDS.has(conversationId);
}

function promoteOpenTab(
  getState: () => {
    findTab: (type: TabType, entityId: string) => { panelId: string; tabId: string } | null;
    closeTab: (panelId: string, tabId: string) => void;
    retargetTab: CanvasActions['retargetTab'];
    setActiveTab: (panelId: string, tabId: string) => void;
    panels: Record<string, PanelState>;
  },
  input: {
    fromType: TabType;
    fromEntityId: string;
    toType: TabType;
    toEntityId: string;
    label: string;
    sequenceDocument?: SequenceDocumentRef;
  }
): string | null {
  const source = getState().findTab(input.fromType, input.fromEntityId);
  if (!source) return null;

  const duplicates: Array<{ panelId: string; tabId: string }> = [];
  for (const [panelId, panel] of Object.entries(getState().panels)) {
    for (const tab of panel.tabs) {
      if (
        tab.id !== source.tabId &&
        tab.type === input.toType &&
        tab.entityId === input.toEntityId
      ) {
        duplicates.push({ panelId, tabId: tab.id });
      }
    }
  }
  for (const duplicate of duplicates) {
    getState().closeTab(duplicate.panelId, duplicate.tabId);
  }

  if (input.toType === 'sequence' && !input.sequenceDocument)
    throw new Error('Sequence promotion requires a document reference.');
  getState().retargetTab(
    source.panelId,
    source.tabId,
    input.toType === 'sequence'
      ? { type: 'sequence', sequenceDocument: input.sequenceDocument! }
      : { type: input.toType, entityId: input.toEntityId },
    { label: input.label, viewState: {} }
  );
  getState().setActiveTab(source.panelId, source.tabId);
  return source.tabId;
}

function generateId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).substring(2, 9);
}

function createDefaultState(): CanvasState {
  return {
    panels: {
      [DEFAULT_PANEL_ID]: {
        id: DEFAULT_PANEL_ID,
        tabs: [],
        activeTabId: null,
      },
    },
    layout: { type: 'panel', panelId: DEFAULT_PANEL_ID },
    focusedPanelId: DEFAULT_PANEL_ID,

    oversizeScanComplete: true,

    recentlyClosed: [],
  };
}

function normalizeIndexedGenomeUpdate(tab: Tab, updates: Partial<Tab>): Partial<Tab> {
  const incoming = updates.indexedGenome;
  if (!incoming || incoming.ucscTracks === undefined) return updates;
  return {
    ...updates,
    indexedGenome: {
      ...incoming,
      dataTracks: incoming.dataTracks ?? tab.indexedGenome?.dataTracks ?? incoming.ucscTracks,
      ucscTracks: undefined,
    },
  };
}

type LegacyAssemblyPanelTab = Omit<Tab, 'type'> & { type: 'assembly-panel' };
type LegacyReferenceLibraryTab = Omit<Tab, 'type'> & { type: 'reference-library' };
type PersistedTab = Tab | LegacyAssemblyPanelTab | LegacyReferenceLibraryTab;
type PersistedPanelState = Omit<PanelState, 'tabs'> & { tabs: PersistedTab[] };
type PersistedCanvasState = Omit<CanvasState, 'panels'> & {
  panels: Record<string, PersistedPanelState>;
};

function isLegacyAssemblyPanelTab(tab: PersistedTab): tab is LegacyAssemblyPanelTab {
  return tab.type === 'assembly-panel';
}

function isLegacyReferenceLibraryTab(tab: PersistedTab): tab is LegacyReferenceLibraryTab {
  return tab.type === 'reference-library';
}

function removeLegacyReferenceLibraryTabs(state: CanvasState): CanvasState {
  const panels = Object.fromEntries(
    Object.entries(state.panels).map(([panelId, panel]) => {
      const tabs = (panel.tabs as PersistedTab[]).filter(
        (tab): tab is Tab => !isLegacyReferenceLibraryTab(tab)
      );
      return [
        panelId,
        {
          ...panel,
          tabs,
          activeTabId:
            panel.activeTabId && tabs.some((tab) => tab.id === panel.activeTabId)
              ? panel.activeTabId
              : (tabs[0]?.id ?? null),
        },
      ];
    })
  );
  return repairLayoutForPanels({ ...state, panels });
}

function createDesignTabFromAssemblyTab(tab: LegacyAssemblyPanelTab): Tab {
  return {
    id: `${tab.id}-design`,
    type: 'design',
    entityId: tab.entityId,
    label: tab.label.replace(/^Assembly:\s*/i, '') || 'Design',
    viewState: tab.viewState,
  };
}

function repairLegacyChatConversationTabs(state: CanvasState): CanvasState {
  let changed = false;
  const panels: Record<string, PanelState> = {};

  for (const [panelId, panel] of Object.entries(state.panels)) {
    let panelChanged = false;
    const tabs = panel.tabs.map((tab) => {
      if (tab.type !== 'chat' || !isLegacyChatConversationId(tab.entityId)) {
        return tab;
      }
      changed = true;
      panelChanged = true;
      return {
        ...tab,
        entityId: generateId(),
        label: tab.label || 'New Chat',
      };
    });
    panels[panelId] = panelChanged ? { ...panel, tabs } : panel;
  }

  return changed ? { ...state, panels } : state;
}

function repairLayoutForPanels(state: CanvasState): CanvasState {
  let repaired = state;
  let panelIds = Object.keys(repaired.panels);

  for (const panelId of panelIds) {
    const panel = repaired.panels[panelId];
    if (panel && panel.tabs.length === 0 && panelIds.length > 1) {
      const closePanelState = computeClosePanelState(repaired, panelId);
      if (closePanelState) {
        repaired = { ...repaired, ...closePanelState };
        panelIds = Object.keys(repaired.panels);
      }
    }
  }

  panelIds = Object.keys(repaired.panels);
  if (panelIds.length === 0) {
    return createDefaultState();
  }

  const focusedPanelId =
    repaired.focusedPanelId && panelIds.includes(repaired.focusedPanelId)
      ? repaired.focusedPanelId
      : panelIds[0];

  return {
    ...repaired,
    focusedPanelId,
  };
}

type LegacyDraftTab = Tab & {
  primerDraft?: {
    workspaceRoot: string;
    destinationPath: string;
    orderType?: import('../primers/public/oligo-order-type').OligoOrderType;
    artifactPath?: string;
  };
  proteinDraft?: { workspaceRoot: string; destinationPath: string };
};

function repairArtifactDocumentTabs(state: CanvasState): CanvasState {
  const panels = Object.fromEntries(
    Object.entries(state.panels).map(([panelId, panel]) => {
      const tabs = panel.tabs.flatMap((candidate): Tab[] => {
        const tab = candidate as LegacyDraftTab;
        if (isEphemeralArtifactDraft(tab) || tab.proteinDraft || tab.openingTrackViewPath)
          return [];
        if (!tab.primerDraft) return [tab];
        const { primerDraft, proteinDraft: _proteinDraft, ...current } = tab;
        if (!primerDraft.artifactPath) return [];
        return [
          {
            ...current,
            artifactDocument: {
              kind: 'primer',
              persistence: 'persisted',
              workspaceRoot: primerDraft.workspaceRoot,
              destinationPath: primerDraft.destinationPath,
              artifactPath: primerDraft.artifactPath,
              ...(primerDraft.orderType ? { orderType: primerDraft.orderType } : {}),
            },
          },
        ];
      });
      return [
        panelId,
        {
          ...panel,
          tabs,
          activeTabId:
            panel.activeTabId && tabs.some((tab) => tab.id === panel.activeTabId)
              ? panel.activeTabId
              : (tabs[0]?.id ?? null),
        },
      ];
    })
  );
  return repairLayoutForPanels({ ...state, panels });
}

export function partializeCanvasState(
  state: CanvasState & CanvasActions
): Pick<CanvasState, 'panels' | 'layout' | 'focusedPanelId'> {
  const durable = repairArtifactDocumentTabs(removeLegacyReferenceLibraryTabs(state));

  const panels = Object.fromEntries(
    Object.entries(durable.panels).map(([id, panel]) => [
      id,
      {
        ...panel,
        tabs: panel.tabs.map(({ assemblyEditDesignId: _editMode, ...entry }) => {
          const { structureRenderError: _renderError, ...tab } = entry;
          if (tab.type !== 'structure') return tab;
          const attrs = tab.initialStructureAttrs;
          if (attrs?.molecularDocumentPath)
            return {
              ...tab,
              initialStructureAttrs: {
                source: 'file' as const,
                sourceId: '',
                label: attrs.label,
                molecularDocumentId: attrs.molecularDocumentId,
                molecularDocumentPath: attrs.molecularDocumentPath,
                molecularDocumentRevision: attrs.molecularDocumentRevision,
                molecularDocumentSavedReferenceId: attrs.molecularDocumentSavedReferenceId,
              },
            };
          if (!tab.entityId.startsWith('saved-view:')) return tab;
          if (tab.molecularViewReferenceId && attrs) {
            const { sourceId: _coordinates, ...workingAttrs } = attrs;
            return { ...tab, initialStructureAttrs: workingAttrs };
          }
          const { initialStructureAttrs: _savedViewPayload, ...lightweightTab } = tab;
          return lightweightTab;
        }),
      },
    ])
  );
  return {
    panels,
    layout: durable.layout,
    focusedPanelId: durable.focusedPanelId,
  };
}

function withRecentlyClosedDefault(state: CanvasState): CanvasState {
  return state.recentlyClosed ? state : { ...state, recentlyClosed: [] };
}

function dropUnrenderableTabs(state: CanvasState): CanvasState {
  const panels: Record<string, PanelState> = {};
  let dropped = 0;
  for (const [panelId, panel] of Object.entries(state.panels)) {
    const tabs = (panel.tabs ?? []).filter((tab) => {
      if (isKnownTabType(tab?.type)) return true;
      dropped += 1;
      return false;
    });
    panels[panelId] = {
      ...panel,
      tabs,
      activeTabId:
        panel.activeTabId && tabs.some((tab) => tab.id === panel.activeTabId)
          ? panel.activeTabId
          : (tabs[0]?.id ?? null),
    };
  }
  if (dropped > 0) debugWarn(`[Canvas] Dropped ${dropped} persisted tab(s) with an unknown type`);
  return dropped > 0 ? { ...state, panels } : state;
}

function repairLegacySequenceTabs(state: CanvasState): CanvasState {
  const panels: Record<string, PanelState> = {};
  for (const [panelId, panel] of Object.entries(state.panels)) {
    const tabs = panel.tabs.flatMap((tab): Tab[] => {
      if (tab.type !== 'sequence') return [tab];
      if (looksLikeWorkspacePath(tab.entityId)) return [];
      if (tab.sequenceDocument) {
        return sequenceDocumentKey(tab.sequenceDocument) === tab.entityId
          ? [normalizeSequenceTab(tab)]
          : [];
      }
      if (tab.entityId.startsWith('assembly:')) {
        return [
          {
            ...normalizeSequenceTab(tab),
            sequenceDocument: {
              kind: 'indexed-sequence',
              documentId: tab.entityId,
            },
          },
        ];
      }
      return [];
    });
    panels[panelId] = {
      ...panel,
      tabs,
      activeTabId:
        panel.activeTabId && tabs.some((tab) => tab.id === panel.activeTabId)
          ? panel.activeTabId
          : (tabs[0]?.id ?? null),
    };
  }
  return repairLayoutForPanels({ ...state, panels });
}

export function migratePersistedCanvasState(persistedState: unknown, version: number): CanvasState {
  if (version < 1) {
    return createDefaultState();
  }

  const state = persistedState as Record<string, unknown>;
  if (
    !state ||
    typeof state !== 'object' ||
    !state.panels ||
    typeof state.panels !== 'object' ||
    !state.layout ||
    typeof state.layout !== 'object'
  ) {
    debugWarn('[Canvas] Invalid persisted state structure, resetting');
    return createDefaultState();
  }

  if (version >= 2) {
    return withRecentlyClosedDefault(
      repairArtifactDocumentTabs(
        removeLegacyReferenceLibraryTabs(
          repairLegacyChatConversationTabs(
            repairLegacySequenceTabs(
              dropUnrenderableTabs(repairLayoutForPanels(persistedState as CanvasState))
            )
          )
        )
      )
    );
  }

  const legacyState = persistedState as PersistedCanvasState;
  const panels: Record<string, PanelState> = {};

  for (const [panelId, panel] of Object.entries(legacyState.panels)) {
    const removedAssemblyTabs = panel.tabs.filter(isLegacyAssemblyPanelTab);
    let tabs = panel.tabs
      .filter(
        (tab): tab is Tab => !isLegacyAssemblyPanelTab(tab) && !isLegacyReferenceLibraryTab(tab)
      )
      .map(normalizeSequenceTab);

    if (tabs.length === 0 && removedAssemblyTabs.length > 0) {
      tabs = removedAssemblyTabs.map(createDesignTabFromAssemblyTab);
    }

    const activeTabId =
      panel.activeTabId && tabs.some((tab) => tab.id === panel.activeTabId)
        ? panel.activeTabId
        : (tabs[0]?.id ?? null);

    panels[panelId] = {
      ...panel,
      tabs,
      activeTabId,
    };
  }

  return withRecentlyClosedDefault(
    repairLegacyChatConversationTabs(
      repairLayoutForPanels({
        ...legacyState,
        panels,
      })
    )
  );
}

function collectPanelIds(
  node: LayoutNode,
  depth = 0,
  visited = new WeakSet<LayoutNode>()
): string[] {
  const MAX_DEPTH = 100;
  if (depth > MAX_DEPTH) {
    console.error('[Canvas] Layout tree depth exceeded', MAX_DEPTH);
    return [];
  }
  if (visited.has(node)) {
    console.error('[Canvas] Circular reference detected in layout tree');
    return [];
  }
  visited.add(node);

  if (node.type === 'panel') return [node.panelId];
  if (node.type === 'split') {
    return node.children.flatMap((child) => collectPanelIds(child, depth + 1, visited));
  }
  return [];
}

function removeFromLayout(
  node: LayoutNode,
  panelId: string
): { node: LayoutNode | null; removedSize: number } {
  if (node.type === 'panel') {
    if (node.panelId === panelId) {
      return { node: null, removedSize: 0 };
    }
    return { node, removedSize: 0 };
  }
  if (node.type === 'split') {
    const results = node.children.map((child, i) => ({
      ...removeFromLayout(child, panelId),
      originalSize: node.sizes[i],
    }));

    const newChildren: LayoutNode[] = [];
    const newSizes: number[] = [];
    let redistributeSize = 0;

    for (const result of results) {
      if (result.node === null) {
        redistributeSize += result.originalSize;
      } else {
        newChildren.push(result.node);
        newSizes.push(result.originalSize);
      }
    }

    if (newChildren.length === 0) return { node: null, removedSize: 0 };

    if (newChildren.length === 1) {
      return { node: newChildren[0], removedSize: 0 };
    }

    if (redistributeSize > 0) {
      const totalRemaining = newSizes.reduce((a, b) => a + b, 0);
      for (let i = 0; i < newSizes.length; i++) {
        newSizes[i] += (newSizes[i] / totalRemaining) * redistributeSize;
      }
    }

    return { node: { ...node, children: newChildren, sizes: newSizes }, removedSize: 0 };
  }
  return { node, removedSize: 0 };
}

function computeClosePanelState(state: CanvasState, panelId: string): Partial<CanvasState> | null {
  const panelIds = Object.keys(state.panels);
  if (panelIds.length <= 1) return null;

  const { [panelId]: _, ...remainingPanels } = state.panels;
  const { node: newLayout } = removeFromLayout(state.layout, panelId);
  const remainingPanelIds = Object.keys(remainingPanels);

  let newFocusedPanelId: string;
  if (state.focusedPanelId === panelId || state.focusedPanelId === null) {
    newFocusedPanelId = remainingPanelIds[0];
  } else if (remainingPanelIds.includes(state.focusedPanelId)) {
    newFocusedPanelId = state.focusedPanelId;
  } else {
    newFocusedPanelId = remainingPanelIds[0];
  }

  return {
    panels: remainingPanels,
    layout: newLayout || createDefaultState().layout,
    focusedPanelId: newFocusedPanelId,
  };
}

export interface CanvasActions {
  openTab: (panelId: string, tab: Omit<Tab, 'id'>) => string;
  closeTab: (panelId: string, tabId: string) => void;
  setActiveTab: (panelId: string, tabId: string) => void;
  updateTab: (panelId: string, tabId: string, updates: TabUpdates) => void;
  updateTabByEntityId: (entityId: string, updates: TabUpdates) => void;
  retargetTab: (
    panelId: string,
    tabId: string,
    identity: CanvasTabIdentity,
    updates?: TabUpdates
  ) => void;
  retargetTabsByEntityId: (
    entityId: string,
    identity: CanvasTabIdentity,
    updates?: TabUpdates
  ) => void;
  setSequenceAssemblyEdit: (panelId: string, tabId: string, designId: string | null) => void;

  retargetTabsUnderPath: (oldPath: string, newPath: string) => void;
  setTabViewState: (panelId: string, tabId: string, viewState: Partial<TabViewState>) => void;
  clearPendingViewState: (panelId: string, tabId: string) => void;
  applyOversizeScan: (panelTabsMap: Record<string, Tab[]>) => void;
  moveTab: (fromPanelId: string, toPanelId: string, tabId: string) => void;
  moveTabAtIndex: (
    fromPanelId: string,
    toPanelId: string,
    tabId: string,
    insertIndex: number | null
  ) => void;
  reorderTab: (panelId: string, tabId: string, newIndex: number) => void;

  focusPanel: (panelId: string) => void;
  splitPanel: (panelId: string, direction: 'horizontal' | 'vertical') => string;

  arrangeTwoPanels: (leftPanelId: string, rightPanelId: string) => void;
  closePanel: (panelId: string) => void;
  joinAllPanels: () => void;
  mergePanels: (sourcePanelId: string, targetPanelId: string) => void;

  closeOtherTabs: (panelId: string, keepTabId: string) => void;
  closeTabsToRight: (panelId: string, tabId: string) => void;
  closeSavedTabs: (panelId: string) => void;
  closeAllTabs: (panelId: string) => void;

  splitAndMoveTab: (
    targetPanelId: string,
    direction: 'up' | 'down' | 'left' | 'right',
    fromPanelId: string,
    tabId: string
  ) => void;

  openInFocusedPanel: (
    type: TabType,
    entityId: string,
    label: string,
    options?: Omit<Tab, 'id' | 'type' | 'entityId' | 'label'>
  ) => string;
  openWithSmartPlacement: (
    type: TabType,
    entityId: string,
    label: string,
    initialStructureAttrs?: Tab['initialStructureAttrs'],
    options?: Omit<Tab, 'id' | 'type' | 'entityId' | 'label'>
  ) => string;

  agentContentPlacement: (workingPanelIdOverride?: string) => {
    targetPanelId: string;
    workingPanelId: string;
    createdPanelId?: string;
  };

  openAgentContentTab: (
    type: TabType,
    entityId: string,
    label: string,
    initialStructureAttrs?: Tab['initialStructureAttrs']
  ) => string;
  closeActiveTab: () => void;

  reopenLastClosedTab: () => void;

  openInOppositePanel: (
    sourcePanelId: string,
    type: TabType,
    entityId: string,
    label: string,
    initialStructureAttrs?: Tab['initialStructureAttrs']
  ) => string | null;
  openInOppositePanelDetailed: (
    sourcePanelId: string,
    type: TabType,
    entityId: string,
    label: string,
    initialStructureAttrs?: Tab['initialStructureAttrs']
  ) => {
    tabId: string;
    targetPanelId: string;
    createdTab: boolean;
    createdPanelId?: string;
  } | null;
  findTab: (type: TabType, entityId: string) => { panelId: string; tabId: string } | null;
  closeTabByTypeAndEntity: (type: TabType, entityId: string) => void;

  promoteTabToSequence: (input: {
    fromType: TabType;
    fromEntityId: string;
    sequenceEntityId: string;
    sequenceDocument: SequenceDocumentRef;
    label: string;
  }) => string | null;

  promoteTabToDesign: (input: {
    fromType: TabType;
    fromEntityId: string;
    designEntityId: string;
    label: string;
  }) => string | null;

  openChatTab: (conversationId?: string) => {
    tabId: string;
    conversationId: string;
    isNew: boolean;
  };

  retargetChatTab: (conversationId: string) => {
    tabId: string;
    conversationId: string;
    isNew: boolean;
  };

  retargetChatTabOpposite: (
    sourcePanelId: string | undefined,
    conversationId: string
  ) => {
    tabId: string;
    panelId: string;
    conversationId: string;
    isNew: boolean;
  };

  reset: () => void;
}

export const useCanvasStore = create<CanvasState & CanvasActions>()(
  persist(
    (set, get) => ({
      ...createDefaultState(),

      openTab: (panelId, tabData) => {
        assertKnownTabType(tabData);
        assertLogicalSequenceTab(tabData);
        tabData = normalizeSequenceTab(tabData);
        const state = get();
        const panel = state.panels[panelId];
        if (!panel) return '';

        const existingTab = panel.tabs.find(
          (t) => t.type === tabData.type && t.entityId === tabData.entityId
        );

        if (existingTab) {
          set((state) => {
            const panel = state.panels[panelId];
            if (!panel) return state;
            const shouldRefreshInitialStructureAttrs =
              tabData.initialStructureAttrs !== undefined &&
              tabData.initialStructureAttrs !== existingTab.initialStructureAttrs;
            const shouldRefreshSourceMetadata =
              (tabData.entityKind !== undefined && tabData.entityKind !== existingTab.entityKind) ||
              (tabData.sourceFileName !== undefined &&
                tabData.sourceFileName !== existingTab.sourceFileName) ||
              (tabData.readOnly !== undefined && tabData.readOnly !== existingTab.readOnly);
            return {
              panels: {
                ...state.panels,
                [panelId]: {
                  ...panel,
                  tabs:
                    shouldRefreshInitialStructureAttrs || shouldRefreshSourceMetadata
                      ? panel.tabs.map((tab) =>
                          tab.id === existingTab.id
                            ? {
                                ...tab,
                                ...(shouldRefreshInitialStructureAttrs
                                  ? { initialStructureAttrs: tabData.initialStructureAttrs }
                                  : {}),
                                ...(tabData.entityKind !== undefined
                                  ? { entityKind: tabData.entityKind }
                                  : {}),
                                ...(tabData.sourceFileName !== undefined
                                  ? { sourceFileName: tabData.sourceFileName }
                                  : {}),
                                ...(tabData.readOnly !== undefined
                                  ? { readOnly: tabData.readOnly }
                                  : {}),
                              }
                            : tab
                        )
                      : panel.tabs,
                  activeTabId: existingTab.id,
                },
              },
            };
          });
          return existingTab.id;
        }

        const id = generateId();
        const tab: Tab = { ...tabData, id };

        set((state) => {
          const panel = state.panels[panelId];
          if (!panel) return state;

          return {
            panels: {
              ...state.panels,
              [panelId]: {
                ...panel,
                tabs: [...panel.tabs, tab],
                activeTabId: id,
              },
            },
          };
        });

        return id;
      },

      closeTab: (panelId, tabId) => {
        debugLog('[CanvasStore] closeTab called:', {
          panelId,
          tabId,
          timestamp: new Date().toISOString(),
        });
        set((state) => {
          const panel = state.panels[panelId];
          if (!panel) return state;

          const tabIndex = panel.tabs.findIndex((t) => t.id === tabId);
          if (tabIndex === -1) return state;

          const closingTab = panel.tabs[tabIndex];

          const newTabs = panel.tabs.filter((t) => t.id !== tabId);

          let newActiveTabId: string | null = null;
          if (newTabs.length > 0) {
            if (panel.activeTabId === tabId) {
              const newIndex = Math.min(tabIndex, newTabs.length - 1);
              newActiveTabId = newTabs[newIndex].id;
            } else {
              newActiveTabId = panel.activeTabId;
            }
          }

          const recentlyClosed = pushRecentlyClosed(state.recentlyClosed, [
            { tab: closingTab, panelId, index: tabIndex },
          ]);

          const panelCount = Object.keys(state.panels).length;
          const shouldClosePanel = newTabs.length === 0 && panelCount > 1;

          if (shouldClosePanel) {
            debugLog('[CanvasStore] shouldClosePanel=true, computing new layout');
            const closePanelState = computeClosePanelState(state, panelId);
            if (closePanelState) {
              debugLog('[CanvasStore] New layout after panel close:', closePanelState.layout);
              recordRemovedTabs([closingTab]);
              return { ...state, ...closePanelState, recentlyClosed };
            }
          }

          recordRemovedTabs([closingTab]);
          return {
            ...state,
            panels: {
              ...state.panels,
              [panelId]: {
                ...panel,
                tabs: newTabs,
                activeTabId: newActiveTabId,
              },
            },
            recentlyClosed,
          };
        });
      },

      setActiveTab: (panelId, tabId) => {
        set((state) => {
          const panel = state.panels[panelId];
          if (!panel || !panel.tabs.some((tab) => tab.id === tabId)) return state;
          if (panel.activeTabId === tabId && state.focusedPanelId === panelId) return state;

          return {
            panels: {
              ...state.panels,
              [panelId]: { ...panel, activeTabId: tabId },
            },
            focusedPanelId: panelId,
          };
        });
      },

      updateTab: (panelId, tabId, updates) => {
        assertPresentationUpdates(updates);
        debugLog('[CanvasStore] updateTab called:', {
          panelId,
          tabId,
          updates,
          timestamp: new Date().toISOString(),
        });
        set((state) => {
          const panel = state.panels[panelId];
          if (!panel) return state;
          const tab = panel.tabs.find((t) => t.id === tabId);
          if (!tab) return state;
          const normalizedUpdates = normalizeTabUpdates(tab, updates);
          assertLogicalSequenceTab({ ...tab, ...normalizedUpdates });

          let changed = false;
          for (const key of Object.keys(normalizedUpdates) as (keyof typeof normalizedUpdates)[]) {
            if (tab[key] !== normalizedUpdates[key]) {
              changed = true;
              break;
            }
          }
          if (!changed) return state;

          return {
            panels: {
              ...state.panels,
              [panelId]: {
                ...panel,
                tabs: panel.tabs.map((t) => (t.id === tabId ? { ...t, ...normalizedUpdates } : t)),
              },
            },
          };
        });
      },

      updateTabByEntityId: (entityId, updates) => {
        assertPresentationUpdates(updates);
        set((state) => {
          let changed = false;
          const panels = { ...state.panels };
          for (const [panelId, panel] of Object.entries(state.panels)) {
            const tabs = panel.tabs.map((tab) => {
              if (tab.entityId !== entityId) return tab;
              const normalized = normalizeTabUpdates(tab, updates);
              assertLogicalSequenceTab({ ...tab, ...normalized });
              if (
                Object.keys(normalized).every((key) => {
                  const field = key as keyof Tab;
                  return tab[field] === normalized[field];
                })
              )
                return tab;
              changed = true;
              return { ...tab, ...normalized };
            });
            if (tabs.some((tab, index) => tab !== panel.tabs[index])) {
              panels[panelId] = {
                ...panel,
                tabs,
              };
            }
          }
          return changed ? { panels } : state;
        });
      },

      retargetTab: (panelId, tabId, identity, updates = {}) => {
        set((state) => {
          const panel = state.panels[panelId];
          if (!panel) return state;
          const tab = panel.tabs.find((candidate) => candidate.id === tabId);
          if (!tab) return state;
          const next = retargetTabDocument(tab, identity, updates);
          return {
            panels: {
              ...state.panels,
              [panelId]: {
                ...panel,
                tabs: panel.tabs.map((candidate) => (candidate.id === tabId ? next : candidate)),
              },
            },
          };
        });
      },

      retargetTabsByEntityId: (entityId, identity, updates = {}) => {
        set((state) => {
          const panels = { ...state.panels };
          let changed = false;
          for (const [panelId, panel] of Object.entries(state.panels)) {
            if (!panel.tabs.some((tab) => tab.entityId === entityId)) continue;
            panels[panelId] = {
              ...panel,
              tabs: panel.tabs.map((tab) =>
                tab.entityId === entityId ? retargetTabDocument(tab, identity, updates) : tab
              ),
            };
            changed = true;
          }
          return changed ? { panels } : state;
        });
      },

      setSequenceAssemblyEdit: (panelId, tabId, designId) => {
        set((state) => {
          const panel = state.panels[panelId];
          const tab = panel?.tabs.find((candidate) => candidate.id === tabId);
          if (!tab) return state;
          if (tab.type !== 'sequence') throw new Error('Assembly editing requires a sequence tab.');
          if (tab.assemblyEditDesignId === (designId ?? undefined)) return state;
          return {
            panels: {
              ...state.panels,
              [panelId]: {
                ...panel,
                tabs: panel.tabs.map((candidate) =>
                  candidate.id === tabId
                    ? { ...candidate, assemblyEditDesignId: designId ?? undefined }
                    : candidate
                ),
              },
            },
          };
        });
      },

      retargetTabsUnderPath: (oldPath, newPath) => {
        set((state) => {
          let changed = false;
          const nextPanels: typeof state.panels = {};
          for (const [panelId, panel] of Object.entries(state.panels)) {
            nextPanels[panelId] = {
              ...panel,
              tabs: panel.tabs.map((t) => {
                if (t.type === 'sequence') return t;
                const retargetPath = (path: string): string =>
                  pathIsAtOrUnder(path, oldPath) ? rebasePath(path, oldPath, newPath) : path;
                const nextId = retargetPath(t.entityId);
                const context = t.artifactDocument;
                const artifactPath = context?.artifactPath
                  ? retargetPath(context.artifactPath)
                  : undefined;
                const workspaceRoot = context ? retargetPath(context.workspaceRoot) : undefined;
                const destinationPath = context
                  ? artifactPath && artifactPath !== context.artifactPath
                    ? artifactPath.slice(0, artifactPath.lastIndexOf('/'))
                    : retargetPath(context.destinationPath)
                  : undefined;
                const contextChanged =
                  context &&
                  (artifactPath !== context.artifactPath ||
                    workspaceRoot !== context.workspaceRoot ||
                    destinationPath !== context.destinationPath);
                if (nextId === t.entityId && !contextChanged) return t;
                changed = true;

                const oldBase = t.entityId.split('/').pop() ?? t.entityId;
                const nextBase = nextId.split('/').pop() ?? nextId;
                const nextLabel = t.label === oldBase ? nextBase : t.label;
                return {
                  ...t,
                  entityId: nextId,
                  label: nextLabel,
                  ...(contextChanged
                    ? {
                        artifactDocument: {
                          ...context,
                          workspaceRoot: workspaceRoot!,
                          destinationPath: destinationPath!,
                          ...(artifactPath ? { artifactPath } : {}),
                        },
                      }
                    : {}),
                };
              }),
            };
          }
          return changed ? { panels: nextPanels } : state;
        });
      },

      setTabViewState: (panelId, tabId, viewState) => {
        set((state) => {
          const panel = state.panels[panelId];
          if (!panel) return state;
          const tab = panel.tabs.find((candidate) => candidate.id === tabId);
          if (
            !tab ||
            Object.entries(viewState).every(
              ([key, value]) =>
                tab.viewState != null &&
                Object.prototype.hasOwnProperty.call(tab.viewState, key) &&
                Object.is(tab.viewState?.[key], value)
            )
          ) {
            return state;
          }

          return {
            panels: {
              ...state.panels,
              [panelId]: {
                ...panel,
                tabs: panel.tabs.map((t) =>
                  t.id === tabId ? { ...t, viewState: { ...t.viewState, ...viewState } } : t
                ),
              },
            },
          };
        });
      },

      clearPendingViewState: (panelId, tabId) => {
        set((state) => {
          const panel = state.panels[panelId];
          if (!panel) return state;
          return {
            panels: {
              ...state.panels,
              [panelId]: {
                ...panel,
                tabs: panel.tabs.map((t) =>
                  t.id === tabId ? { ...t, pendingViewState: undefined } : t
                ),
              },
            },
          };
        });
      },

      applyOversizeScan: (panelTabsMap) => {
        set((state) => {
          const nextPanels: typeof state.panels = { ...state.panels };
          for (const [panelId, scannedTabs] of Object.entries(panelTabsMap)) {
            const existing = nextPanels[panelId];
            if (!existing) continue;
            const scanById = new Map(scannedTabs.map((t) => [t.id, t]));
            nextPanels[panelId] = {
              ...existing,
              tabs: existing.tabs.map((t) => {
                const scanned = scanById.get(t.id);
                if (!scanned) return t;
                if (!sameFileTabReadAuthority(t, scanned)) return t;
                return {
                  ...t,
                  loadStatus: scanned.loadStatus,
                  fileSizeBytes: scanned.fileSizeBytes,
                };
              }),
            };
          }
          return { panels: nextPanels, oversizeScanComplete: true };
        });
      },

      moveTab: (fromPanelId, toPanelId, tabId) => {
        const operation = newCanvasNavigationOperation();
        if (fromPanelId === toPanelId) {
          observeCanvasLayout(operation, 'move', 'noop');
          return;
        }
        const before = get();
        if (
          !before.panels[fromPanelId]?.tabs.some((tab) => tab.id === tabId) ||
          !before.panels[toPanelId]
        ) {
          observeCanvasLayout(operation, 'move', 'refused');
          return;
        }
        observeCanvasLayout(operation, 'move', 'accepted');

        set((state) => {
          const fromPanel = state.panels[fromPanelId];
          const toPanel = state.panels[toPanelId];
          if (!fromPanel || !toPanel) return state;

          const tab = fromPanel.tabs.find((t) => t.id === tabId);
          if (!tab) return state;

          const newFromTabs = fromPanel.tabs.filter((t) => t.id !== tabId);
          let newFromActiveTabId = fromPanel.activeTabId;
          if (fromPanel.activeTabId === tabId) {
            newFromActiveTabId = newFromTabs.length > 0 ? newFromTabs[0].id : null;
          }

          const newToTabs = [...toPanel.tabs, tab];

          const panelCount = Object.keys(state.panels).length;
          const shouldCloseSourcePanel = newFromTabs.length === 0 && panelCount > 1;

          if (shouldCloseSourcePanel) {
            const closePanelState = computeClosePanelState(
              {
                ...state,
                panels: {
                  ...state.panels,
                  [fromPanelId]: {
                    ...fromPanel,
                    tabs: newFromTabs,
                    activeTabId: newFromActiveTabId,
                  },
                  [toPanelId]: { ...toPanel, tabs: newToTabs, activeTabId: tabId },
                },
              },
              fromPanelId
            );
            if (closePanelState) {
              return { ...state, ...closePanelState, focusedPanelId: toPanelId };
            }
          }

          return {
            ...state,
            panels: {
              ...state.panels,
              [fromPanelId]: { ...fromPanel, tabs: newFromTabs, activeTabId: newFromActiveTabId },
              [toPanelId]: { ...toPanel, tabs: newToTabs, activeTabId: tabId },
            },
            focusedPanelId: toPanelId,
          };
        });
        const after = get();
        observeCanvasLayout(
          operation,
          'move',
          after.panels[toPanelId]?.activeTabId === tabId &&
            after.focusedPanelId === toPanelId &&
            !after.panels[fromPanelId]?.tabs.some((tab) => tab.id === tabId)
            ? 'committed'
            : 'refused'
        );
      },

      moveTabAtIndex: (fromPanelId, toPanelId, tabId, insertIndex) => {
        if (fromPanelId === toPanelId) {
          if (insertIndex !== null) {
            get().reorderTab(fromPanelId, tabId, insertIndex);
          }
          return;
        }

        const operation = newCanvasNavigationOperation();
        const before = get();
        if (
          !before.panels[fromPanelId]?.tabs.some((tab) => tab.id === tabId) ||
          !before.panels[toPanelId]
        ) {
          observeCanvasLayout(operation, 'move', 'refused');
          return;
        }
        observeCanvasLayout(operation, 'move', 'accepted');

        set((state) => {
          const fromPanel = state.panels[fromPanelId];
          const toPanel = state.panels[toPanelId];
          if (!fromPanel || !toPanel) return state;

          const tab = fromPanel.tabs.find((t) => t.id === tabId);
          if (!tab) return state;

          const newFromTabs = fromPanel.tabs.filter((t) => t.id !== tabId);
          let newFromActiveTabId = fromPanel.activeTabId;
          if (fromPanel.activeTabId === tabId) {
            newFromActiveTabId = newFromTabs.length > 0 ? newFromTabs[0].id : null;
          }

          let newToTabs: Tab[];
          if (insertIndex !== null && insertIndex >= 0 && insertIndex <= toPanel.tabs.length) {
            newToTabs = [...toPanel.tabs];
            newToTabs.splice(insertIndex, 0, tab);
          } else {
            newToTabs = [...toPanel.tabs, tab];
          }

          const panelCount = Object.keys(state.panels).length;
          const shouldCloseSourcePanel = newFromTabs.length === 0 && panelCount > 1;

          if (shouldCloseSourcePanel) {
            const closePanelState = computeClosePanelState(
              {
                ...state,
                panels: {
                  ...state.panels,
                  [fromPanelId]: {
                    ...fromPanel,
                    tabs: newFromTabs,
                    activeTabId: newFromActiveTabId,
                  },
                  [toPanelId]: { ...toPanel, tabs: newToTabs, activeTabId: tabId },
                },
              },
              fromPanelId
            );
            if (closePanelState) {
              return { ...state, ...closePanelState, focusedPanelId: toPanelId };
            }
          }

          return {
            ...state,
            panels: {
              ...state.panels,
              [fromPanelId]: { ...fromPanel, tabs: newFromTabs, activeTabId: newFromActiveTabId },
              [toPanelId]: { ...toPanel, tabs: newToTabs, activeTabId: tabId },
            },
            focusedPanelId: toPanelId,
          };
        });
        const after = get();
        observeCanvasLayout(
          operation,
          'move',
          after.panels[toPanelId]?.activeTabId === tabId &&
            after.focusedPanelId === toPanelId &&
            !after.panels[fromPanelId]?.tabs.some((tab) => tab.id === tabId)
            ? 'committed'
            : 'refused'
        );
      },

      reorderTab: (panelId, tabId, newIndex) => {
        const operation = newCanvasNavigationOperation();
        const before = get();
        if (!before.panels[panelId]?.tabs.some((tab) => tab.id === tabId)) {
          observeCanvasLayout(operation, 'reorder', 'refused');
          return;
        }
        if (before.panels[panelId].tabs.findIndex((tab) => tab.id === tabId) === newIndex) {
          observeCanvasLayout(operation, 'reorder', 'noop');
          return;
        }
        observeCanvasLayout(operation, 'reorder', 'accepted');
        set((state) => {
          const panel = state.panels[panelId];
          if (!panel) return state;

          const currentIndex = panel.tabs.findIndex((t) => t.id === tabId);
          if (currentIndex === -1 || currentIndex === newIndex) return state;

          const newTabs = [...panel.tabs];
          const [tab] = newTabs.splice(currentIndex, 1);
          newTabs.splice(newIndex, 0, tab);

          return {
            panels: {
              ...state.panels,
              [panelId]: {
                ...panel,
                tabs: newTabs,
              },
            },
          };
        });
        const nextTabs = get().panels[panelId]?.tabs;
        observeCanvasLayout(
          operation,
          'reorder',
          !nextTabs
            ? 'refused'
            : before.panels[panelId].tabs.every((tab, index) => nextTabs[index]?.id === tab.id)
              ? 'noop'
              : 'committed'
        );
      },

      closeOtherTabs: (panelId, keepTabId) => {
        set((state) => {
          const panel = state.panels[panelId];
          if (!panel) return state;

          const newTabs = panel.tabs.filter((t) => t.id === keepTabId);
          const removedEntries = panel.tabs
            .map((tab, index) => ({ tab, panelId, index }))
            .filter((entry) => entry.tab.id !== keepTabId);
          const removedTabs = removedEntries.map((entry) => entry.tab);

          const recentlyClosed = pushRecentlyClosed(state.recentlyClosed, removedEntries);
          recordRemovedTabs(removedTabs);
          return {
            panels: {
              ...state.panels,
              [panelId]: {
                ...panel,
                tabs: newTabs,
                activeTabId: keepTabId,
              },
            },
            recentlyClosed,
          };
        });
      },

      closeTabsToRight: (panelId, tabId) => {
        set((state) => {
          const panel = state.panels[panelId];
          if (!panel) return state;

          const tabIndex = panel.tabs.findIndex((t) => t.id === tabId);
          if (tabIndex === -1) return state;

          const newTabs = panel.tabs.slice(0, tabIndex + 1);
          const removedTabs = panel.tabs.slice(tabIndex + 1);
          const newActiveTabId =
            panel.activeTabId && newTabs.some((t) => t.id === panel.activeTabId)
              ? panel.activeTabId
              : tabId;

          const recentlyClosed = pushRecentlyClosed(
            state.recentlyClosed,
            removedTabs.map((tab, i) => ({ tab, panelId, index: tabIndex + 1 + i }))
          );

          recordRemovedTabs(removedTabs);
          return {
            panels: {
              ...state.panels,
              [panelId]: {
                ...panel,
                tabs: newTabs,
                activeTabId: newActiveTabId,
              },
            },
            recentlyClosed,
          };
        });
      },

      closeSavedTabs: (panelId) => {
        set((state) => {
          const panel = state.panels[panelId];
          if (!panel) return state;

          const newTabs = panel.tabs.filter(isTabDirty);
          const removedEntries = panel.tabs
            .map((tab, index) => ({ tab, panelId, index }))
            .filter((entry) => !isTabDirty(entry.tab));
          const removedTabs = removedEntries.map((entry) => entry.tab);
          let newActiveTabId: string | null = null;

          if (newTabs.length > 0) {
            if (panel.activeTabId && newTabs.some((t) => t.id === panel.activeTabId)) {
              newActiveTabId = panel.activeTabId;
            } else {
              newActiveTabId = newTabs[0].id;
            }
          }

          const recentlyClosed = pushRecentlyClosed(state.recentlyClosed, removedEntries);

          const panelCount = Object.keys(state.panels).length;
          const shouldClosePanel = newTabs.length === 0 && panelCount > 1;

          if (shouldClosePanel) {
            debugLog('[CanvasStore] shouldClosePanel=true, computing new layout');
            const closePanelState = computeClosePanelState(state, panelId);
            if (closePanelState) {
              debugLog('[CanvasStore] New layout after panel close:', closePanelState.layout);
              recordRemovedTabs(removedTabs);
              return { ...state, ...closePanelState, recentlyClosed };
            }
          }

          recordRemovedTabs(removedTabs);
          return {
            ...state,
            panels: {
              ...state.panels,
              [panelId]: { ...panel, tabs: newTabs, activeTabId: newActiveTabId },
            },
            recentlyClosed,
          };
        });
      },

      closeAllTabs: (panelId) => {
        set((state) => {
          const panel = state.panels[panelId];
          if (!panel) return state;

          const recentlyClosed = pushRecentlyClosed(
            state.recentlyClosed,
            panel.tabs.map((tab, index) => ({ tab, panelId, index }))
          );

          const panelCount = Object.keys(state.panels).length;
          if (panelCount > 1) {
            const closePanelState = computeClosePanelState(state, panelId);
            if (closePanelState) {
              recordRemovedTabs(panel.tabs);
              return { ...state, ...closePanelState, recentlyClosed };
            }
          }

          recordRemovedTabs(panel.tabs);
          return {
            ...state,
            panels: {
              ...state.panels,
              [panelId]: { ...panel, tabs: [], activeTabId: null },
            },
            recentlyClosed,
          };
        });
      },

      splitAndMoveTab: (targetPanelId, direction, fromPanelId, tabId) => {
        debugLog('[Store] splitAndMoveTab called:', {
          targetPanelId,
          direction,
          fromPanelId,
          tabId,
        });
        const state = get();
        const fromPanel = state.panels[fromPanelId];
        if (!fromPanel) {
          debugLog('[Store] splitAndMoveTab REJECTED - no fromPanel');
          return;
        }

        const tab = fromPanel.tabs.find((t) => t.id === tabId);
        if (!tab) {
          debugLog('[Store] splitAndMoveTab REJECTED - no tab found');
          return;
        }

        if (fromPanelId === targetPanelId && fromPanel.tabs.length === 1) {
          debugLog('[Store] splitAndMoveTab REJECTED - only one tab in same panel');
          return;
        }

        const splitDirection: 'horizontal' | 'vertical' =
          direction === 'up' || direction === 'down' ? 'horizontal' : 'vertical';

        const newPanelId = get().splitPanel(targetPanelId, splitDirection);

        if (direction === 'up' || direction === 'left') {
          set((state) => {
            function swapLastSplit(node: LayoutNode): LayoutNode {
              if (node.type === 'split') {
                const hasNewPanel = node.children.some(
                  (c) => c.type === 'panel' && c.panelId === newPanelId
                );
                if (hasNewPanel) {
                  return {
                    ...node,
                    children: [...node.children].reverse(),
                  };
                }
                return {
                  ...node,
                  children: node.children.map(swapLastSplit),
                };
              }
              return node;
            }
            return { layout: swapLastSplit(state.layout) };
          });
        }

        get().moveTab(fromPanelId, newPanelId, tabId);
      },

      focusPanel: (panelId) => {
        set({ focusedPanelId: panelId });
      },

      arrangeTwoPanels: (leftPanelId, rightPanelId) => {
        const state = get();
        if (
          leftPanelId === rightPanelId ||
          !state.panels[leftPanelId] ||
          !state.panels[rightPanelId] ||
          collectPanelIds(state.layout).length !== 2
        )
          return;
        set({
          layout: {
            type: 'split',
            direction: 'vertical',
            children: [
              { type: 'panel', panelId: leftPanelId },
              { type: 'panel', panelId: rightPanelId },
            ],
            sizes: [50, 50],
          },
        });
      },

      splitPanel: (panelId, direction) => {
        const operation = newCanvasNavigationOperation();
        const before = get();
        if (!before.panels[panelId] || !collectPanelIds(before.layout).includes(panelId)) {
          observeCanvasLayout(operation, 'split', 'refused');
          return '';
        }
        observeCanvasLayout(operation, 'split', 'accepted');
        const newPanelId = generateId();

        set((state) => {
          const newPanel: PanelState = {
            id: newPanelId,
            tabs: [],
            activeTabId: null,
          };

          function updateLayout(node: LayoutNode): LayoutNode {
            if (node.type === 'panel' && node.panelId === panelId) {
              return {
                type: 'split',
                direction,
                children: [
                  { type: 'panel', panelId },
                  { type: 'panel', panelId: newPanelId },
                ],
                sizes:
                  CHAT_FIRST_INPUT &&
                  direction === 'vertical' &&
                  state.panels[panelId]?.tabs.some((tab) => tab.type === 'chat')
                    ? [39, 61]
                    : [50, 50],
              };
            }
            if (node.type === 'split') {
              return {
                ...node,
                children: node.children.map(updateLayout),
              };
            }
            return node;
          }

          return {
            panels: { ...state.panels, [newPanelId]: newPanel },
            layout: updateLayout(state.layout),
            focusedPanelId: newPanelId,
          };
        });

        const after = get();
        observeCanvasLayout(
          operation,
          'split',
          after.panels[newPanelId] &&
            collectPanelIds(after.layout).includes(newPanelId) &&
            after.focusedPanelId === newPanelId
            ? 'committed'
            : 'refused'
        );
        return newPanelId;
      },

      closePanel: (panelId) => {
        set((state) => {
          const panel = state.panels[panelId];
          if (!panel) return state;
          const closePanelState = computeClosePanelState(state, panelId);
          if (!closePanelState) return state;
          recordRemovedTabs(panel.tabs);
          return { ...state, ...closePanelState };
        });
      },

      joinAllPanels: () => {
        const state = get();
        const panelIds = Object.keys(state.panels);

        if (panelIds.length <= 1) return;

        const orderedPanelIds = collectPanelIds(state.layout);
        const allTabs: Tab[] = [];
        let activeTabId: string | null = null;

        for (const panelId of orderedPanelIds) {
          const panel = state.panels[panelId];
          if (panel) {
            allTabs.push(...panel.tabs);
            if (panelId === state.focusedPanelId && panel.activeTabId) {
              activeTabId = panel.activeTabId;
            }
          }
        }

        if (!activeTabId && allTabs.length > 0) {
          activeTabId = allTabs[0].id;
        }

        const mainPanelId = DEFAULT_PANEL_ID;
        set({
          panels: {
            [mainPanelId]: {
              id: mainPanelId,
              tabs: allTabs,
              activeTabId,
            },
          },
          layout: { type: 'panel', panelId: mainPanelId },
          focusedPanelId: mainPanelId,
        });
      },

      mergePanels: (sourcePanelId, targetPanelId) => {
        const operation = newCanvasNavigationOperation();
        if (sourcePanelId === targetPanelId) {
          observeCanvasLayout(operation, 'merge', 'noop');
          return;
        }
        const before = get();
        if (!before.panels[sourcePanelId] || !before.panels[targetPanelId]) {
          observeCanvasLayout(operation, 'merge', 'refused');
          return;
        }
        observeCanvasLayout(operation, 'merge', 'accepted');

        set((state) => {
          const sourcePanel = state.panels[sourcePanelId];
          const targetPanel = state.panels[targetPanelId];
          if (!sourcePanel || !targetPanel) return state;

          const mergedTabs = [...targetPanel.tabs, ...sourcePanel.tabs];
          const activeTabId = targetPanel.activeTabId || sourcePanel.activeTabId;

          const updatedState = {
            ...state,
            panels: {
              ...state.panels,
              [targetPanelId]: {
                ...targetPanel,
                tabs: mergedTabs,
                activeTabId,
              },
            },
            focusedPanelId: targetPanelId,
          };

          const closePanelState = computeClosePanelState(updatedState, sourcePanelId);
          if (closePanelState) {
            return { ...updatedState, ...closePanelState, focusedPanelId: targetPanelId };
          }

          return updatedState;
        });
        const after = get();
        observeCanvasLayout(
          operation,
          'merge',
          !after.panels[sourcePanelId] &&
            before.panels[sourcePanelId].tabs.every((tab) =>
              after.panels[targetPanelId]?.tabs.some((candidate) => candidate.id === tab.id)
            ) &&
            after.focusedPanelId === targetPanelId
            ? 'committed'
            : 'refused'
        );
      },

      openInFocusedPanel: (type, entityId, label, options) => {
        const { focusedPanelId, panels, openTab } = get();
        let panelId = focusedPanelId || DEFAULT_PANEL_ID;
        if (!panels[panelId]) {
          const availablePanelIds = Object.keys(panels);
          if (availablePanelIds.length === 0) {
            return '';
          }
          panelId = availablePanelIds[0];
        }
        const panel = panels[panelId];
        if (CHAT_FIRST_INPUT && type !== 'chat' && panel.tabs.some((tab) => tab.type === 'chat')) {
          panelId = get().agentContentPlacement(panelId).targetPanelId;
        }
        return openTab(panelId, { type, entityId, label, ...options });
      },

      openWithSmartPlacement: (type, entityId, label, initialStructureAttrs, options) => {
        const { layout, openTab, focusPanel, splitPanel, findTab, updateTab } = get();
        const panelIds = collectPanelIds(layout);

        const existingTab = findTab(type, entityId);
        if (existingTab) {
          if (initialStructureAttrs !== undefined || options !== undefined) {
            const { sequenceDocument, assemblyEditDesignId, ...presentation } = options ?? {};
            const updates = {
              ...(initialStructureAttrs !== undefined ? { initialStructureAttrs } : {}),
              ...presentation,
            };
            if (sequenceDocument) {
              if (type !== 'sequence')
                throw new Error('Only sequence tabs accept a document reference.');
              get().retargetTab(
                existingTab.panelId,
                existingTab.tabId,
                { type: 'sequence', sequenceDocument },
                updates
              );
            } else {
              updateTab(existingTab.panelId, existingTab.tabId, updates);
            }
            if (options && Object.hasOwn(options, 'assemblyEditDesignId'))
              get().setSequenceAssemblyEdit(
                existingTab.panelId,
                existingTab.tabId,
                assemblyEditDesignId ?? null
              );
          }
          focusPanel(existingTab.panelId);
          get().setActiveTab(existingTab.panelId, existingTab.tabId);
          return existingTab.tabId;
        }

        const rightPaneTypes: TabType[] = ['structure', 'sequence', 'file', 'table', 'protein'];

        if (panelIds.length === 1) {
          if (rightPaneTypes.includes(type)) {
            const newPanelId = splitPanel(panelIds[0], 'vertical');
            return openTab(newPanelId, {
              type,
              entityId,
              label,
              initialStructureAttrs,
              ...options,
            });
          }

          return openTab(panelIds[0], {
            type,
            entityId,
            label,
            initialStructureAttrs,
            ...options,
          });
        }

        let targetPanelId: string;
        if (type === 'chat') {
          targetPanelId = panelIds[0];
        } else {
          targetPanelId = panelIds[panelIds.length - 1];
        }

        focusPanel(targetPanelId);
        return openTab(targetPanelId, {
          type,
          entityId,
          label,
          initialStructureAttrs,
          ...options,
        });
      },

      agentContentPlacement: (workingPanelIdOverride) => {
        const { layout, panels, focusedPanelId, splitPanel } = get();
        const panelIds = collectPanelIds(layout);
        const fallback = focusedPanelId ?? panelIds[0] ?? DEFAULT_PANEL_ID;
        if (panelIds.length === 0) {
          return { targetPanelId: fallback, workingPanelId: fallback };
        }

        const initiatingPanelId =
          workingPanelIdOverride && panelIds.includes(workingPanelIdOverride)
            ? workingPanelIdOverride
            : undefined;
        const chatPanelId = panelIds.find((pid) =>
          panels[pid]?.tabs.some((tab) => tab.type === 'chat')
        );
        const workingPanelId =
          initiatingPanelId ??
          chatPanelId ??
          (focusedPanelId && panelIds.includes(focusedPanelId) ? focusedPanelId : panelIds[0]);
        if (!initiatingPanelId && !chatPanelId) {
          return { targetPanelId: workingPanelId, workingPanelId };
        }
        const index = panelIds.indexOf(workingPanelId);

        const adjacentPanelId = panelIds[index + 1] ?? panelIds[index - 1];

        const createdPanelId = adjacentPanelId ? undefined : splitPanel(workingPanelId, 'vertical');
        const targetPanelId = adjacentPanelId ?? (createdPanelId as string);
        return { targetPanelId, workingPanelId, createdPanelId };
      },

      openAgentContentTab: (type, entityId, label, initialStructureAttrs) => {
        const { findTab, setActiveTab, focusPanel, openTab, updateTab, agentContentPlacement } =
          get();

        const existing = findTab(type, entityId);
        if (existing) {
          if (initialStructureAttrs !== undefined) {
            updateTab(existing.panelId, existing.tabId, { initialStructureAttrs });
          }
          setActiveTab(existing.panelId, existing.tabId);
          const working = collectPanelIds(get().layout).find((pid) =>
            get().panels[pid]?.tabs.some((t) => t.type === 'chat')
          );
          if (working) focusPanel(working);
          return existing.tabId;
        }
        const { targetPanelId, workingPanelId } = agentContentPlacement();
        const tabId = openTab(targetPanelId, { type, entityId, label, initialStructureAttrs });

        focusPanel(workingPanelId);
        return tabId;
      },

      closeActiveTab: () => {
        const { focusedPanelId, panels, closeTab } = get();
        if (!focusedPanelId) return;

        const panel = panels[focusedPanelId];
        if (!panel?.activeTabId) return;

        closeTab(focusedPanelId, panel.activeTabId);
      },

      reopenLastClosedTab: () => {
        const operation = newCanvasNavigationOperation();

        const recentlyClosed = get().recentlyClosed ?? [];
        if (recentlyClosed.length === 0) {
          observeCanvasLayout(operation, 'reopen', 'noop');
          return;
        }

        const entry = recentlyClosed[recentlyClosed.length - 1];
        const remaining = recentlyClosed.slice(0, -1);
        observeCanvasLayout(operation, 'reopen', 'accepted');

        const existing = get().findTab(entry.tab.type, entry.tab.entityId);
        if (existing) {
          const alreadyPlaced =
            get().focusedPanelId === existing.panelId &&
            get().panels[existing.panelId]?.activeTabId === existing.tabId;
          set({ recentlyClosed: remaining });
          get().setActiveTab(existing.panelId, existing.tabId);
          observeCanvasLayout(
            operation,
            'reopen',
            get().panels[existing.panelId]?.activeTabId === existing.tabId &&
              get().focusedPanelId === existing.panelId
              ? alreadyPlaced
                ? 'noop'
                : 'committed'
              : 'refused'
          );
          return;
        }

        set((state) => {
          const targetPanelId =
            (state.panels[entry.panelId] && entry.panelId) ||
            (state.focusedPanelId && state.panels[state.focusedPanelId] && state.focusedPanelId) ||
            Object.keys(state.panels)[0];
          const targetPanel = targetPanelId ? state.panels[targetPanelId] : undefined;
          if (!targetPanel) {
            return { ...state, recentlyClosed: remaining };
          }

          const restored: Tab = {
            ...normalizeSequenceTab(entry.tab),
            ...(shouldRevalidateFileTabOnReopen(entry.tab)
              ? { loadStatus: 'pending' as const, fileSizeBytes: undefined }
              : {}),
            id: generateId(),
          };
          const insertIndex = Math.max(0, Math.min(entry.index, targetPanel.tabs.length));
          const newTabs = [...targetPanel.tabs];
          newTabs.splice(insertIndex, 0, restored);

          return {
            ...state,
            panels: {
              ...state.panels,
              [targetPanelId]: { ...targetPanel, tabs: newTabs, activeTabId: restored.id },
            },
            focusedPanelId: targetPanelId,
            recentlyClosed: remaining,
          };
        });
        const after = get();
        const placed = after.focusedPanelId ? after.panels[after.focusedPanelId] : undefined;
        observeCanvasLayout(
          operation,
          'reopen',
          placed?.tabs.some(
            (tab) =>
              tab.id === placed.activeTabId &&
              tab.type === entry.tab.type &&
              tab.entityId === entry.tab.entityId
          )
            ? 'committed'
            : 'refused'
        );
      },

      openInOppositePanelDetailed: (
        sourcePanelId,
        type,
        entityId,
        label,
        initialStructureAttrs
      ) => {
        const state = get();
        const panelIds = collectPanelIds(state.layout);

        if (!panelIds.includes(sourcePanelId)) {
          debugWarn(
            '[Canvas Store] Stale panel ID passed to openInOppositePanelDetailed:',
            sourcePanelId
          );
          return null;
        }

        const existing = get().findTab(type, entityId);
        if (existing) {
          if (initialStructureAttrs) {
            get().updateTab(existing.panelId, existing.tabId, { initialStructureAttrs });
          }
          get().setActiveTab(existing.panelId, existing.tabId);
          get().focusPanel(existing.panelId);
          return {
            tabId: existing.tabId,
            targetPanelId: existing.panelId,
            createdTab: false,
          };
        }

        const placement = get().agentContentPlacement(sourcePanelId);
        get().focusPanel(placement.targetPanelId);
        const tabId = get().openTab(placement.targetPanelId, {
          type,
          entityId,
          label,
          initialStructureAttrs,
        });
        if (!tabId) {
          if (placement.createdPanelId) get().closePanel(placement.createdPanelId);
          return null;
        }
        return {
          tabId,
          targetPanelId: placement.targetPanelId,
          createdTab: true,
          ...(placement.createdPanelId ? { createdPanelId: placement.createdPanelId } : {}),
        };
      },

      openInOppositePanel: (sourcePanelId, type, entityId, label, initialStructureAttrs) => {
        const placement = get().openInOppositePanelDetailed(
          sourcePanelId,
          type,
          entityId,
          label,
          initialStructureAttrs
        );
        return placement?.tabId ?? null;
      },

      findTab: (type, entityId) => {
        const { panels } = get();
        for (const [panelId, panel] of Object.entries(panels)) {
          const tab = panel.tabs.find((t) => t.type === type && t.entityId === entityId);
          if (tab) {
            return { panelId, tabId: tab.id };
          }
        }
        return null;
      },

      closeTabByTypeAndEntity: (type, entityId) => {
        const { closeTab, findTab } = get();
        const found = findTab(type, entityId);
        if (found) {
          closeTab(found.panelId, found.tabId);
        }
      },

      promoteTabToSequence: ({
        fromType,
        fromEntityId,
        sequenceEntityId,
        sequenceDocument,
        label,
      }) => {
        return promoteOpenTab(get, {
          fromType,
          fromEntityId,
          toType: 'sequence',
          toEntityId: sequenceEntityId,
          sequenceDocument,
          label,
        });
      },

      promoteTabToDesign: ({ fromType, fromEntityId, designEntityId, label }) => {
        return promoteOpenTab(get, {
          fromType,
          fromEntityId,
          toType: 'design',
          toEntityId: designEntityId,
          label,
        });
      },

      openChatTab: (conversationId?: string) => {
        const state = get();
        const convId = conversationId || generateId();

        if (conversationId) {
          const existing = state.findTab('chat', conversationId);
          if (existing) {
            state.focusPanel(existing.panelId);
            state.setActiveTab(existing.panelId, existing.tabId);
            return { tabId: existing.tabId, conversationId, isNew: false };
          }
        } else {
          let legacyChatTab: { panelId: string; tabId: string; label: string } | null = null;

          for (const [panelId, panel] of Object.entries(state.panels)) {
            const chatTab = panel.tabs.find((t) => t.type === 'chat');
            if (chatTab) {
              if (isLegacyChatConversationId(chatTab.entityId)) {
                legacyChatTab ??= { panelId, tabId: chatTab.id, label: chatTab.label };
                continue;
              }
              state.focusPanel(panelId);
              state.setActiveTab(panelId, chatTab.id);
              return { tabId: chatTab.id, conversationId: chatTab.entityId, isNew: false };
            }
          }

          if (legacyChatTab) {
            state.retargetTab(
              legacyChatTab.panelId,
              legacyChatTab.tabId,
              { type: 'chat', entityId: convId },
              {
                label: legacyChatTab.label || 'New Chat',
              }
            );
            state.focusPanel(legacyChatTab.panelId);
            state.setActiveTab(legacyChatTab.panelId, legacyChatTab.tabId);
            return { tabId: legacyChatTab.tabId, conversationId: convId, isNew: true };
          }
        }

        const panelIds = collectPanelIds(state.layout);
        const targetPanelId = panelIds[0] || DEFAULT_PANEL_ID;

        const tabId = state.openTab(targetPanelId, {
          type: 'chat',
          entityId: convId,
          label: 'New Chat',
        });

        state.focusPanel(targetPanelId);

        return { tabId, conversationId: convId, isNew: true };
      },

      retargetChatTab: (conversationId: string) => {
        const state = get();

        const existing = state.findTab('chat', conversationId);
        if (existing) {
          state.focusPanel(existing.panelId);
          state.setActiveTab(existing.panelId, existing.tabId);
          return { tabId: existing.tabId, conversationId, isNew: false };
        }

        const focusedId = state.focusedPanelId;
        const orderedPanelIds = [
          ...(focusedId && state.panels[focusedId] ? [focusedId] : []),
          ...Object.keys(state.panels).filter((id) => id !== focusedId),
        ];
        for (const panelId of orderedPanelIds) {
          const chatTab = state.panels[panelId]?.tabs.find((t) => t.type === 'chat');
          if (chatTab) {
            state.retargetTab(
              panelId,
              chatTab.id,
              { type: 'chat', entityId: conversationId },
              {
                label: chatTab.label || 'New Chat',
              }
            );
            state.focusPanel(panelId);
            state.setActiveTab(panelId, chatTab.id);
            return { tabId: chatTab.id, conversationId, isNew: false };
          }
        }

        return state.openChatTab(conversationId);
      },

      retargetChatTabOpposite: (sourcePanelId: string | undefined, conversationId: string) => {
        const beforePlacement = get();
        const orderedBefore = collectPanelIds(beforePlacement.layout);
        const resolvedSourcePanelId =
          (sourcePanelId && beforePlacement.panels[sourcePanelId] ? sourcePanelId : undefined) ??
          (beforePlacement.focusedPanelId && beforePlacement.panels[beforePlacement.focusedPanelId]
            ? beforePlacement.focusedPanelId
            : undefined) ??
          orderedBefore[0] ??
          DEFAULT_PANEL_ID;
        const { targetPanelId } = beforePlacement.agentContentPlacement(resolvedSourcePanelId);

        let state = get();
        const exact = state.findTab('chat', conversationId);
        const targetChat = state.panels[targetPanelId]?.tabs.find((tab) => tab.type === 'chat');
        const orderedPanelIds = collectPanelIds(state.layout);
        const anyChat = orderedPanelIds.flatMap((panelId) =>
          (state.panels[panelId]?.tabs ?? [])
            .filter((tab) => tab.type === 'chat')
            .map((tab) => ({ panelId, tabId: tab.id }))
        )[0];
        const reusable =
          exact ??
          (targetChat ? { panelId: targetPanelId, tabId: targetChat.id } : null) ??
          anyChat ??
          null;

        let tabId: string;
        let isNew = false;
        if (reusable) {
          const reusableTab = state.panels[reusable.panelId]?.tabs.find(
            (tab) => tab.id === reusable.tabId
          );
          if (reusableTab?.entityId !== conversationId) {
            state.retargetTab(
              reusable.panelId,
              reusable.tabId,
              { type: 'chat', entityId: conversationId },
              {
                label: reusableTab?.label || 'New Chat',
              }
            );
          }
          if (reusable.panelId !== targetPanelId) {
            state.moveTab(reusable.panelId, targetPanelId, reusable.tabId);
          }
          tabId = reusable.tabId;
        } else {
          tabId = state.openTab(targetPanelId, {
            type: 'chat',
            entityId: conversationId,
            label: 'New Chat',
          });
          isNew = true;
        }

        state = get();
        state.focusPanel(targetPanelId);
        state.setActiveTab(targetPanelId, tabId);
        return {
          tabId,
          panelId: targetPanelId,
          conversationId,
          isNew,
        };
      },

      reset: () => {
        recordRemovedTabs(
          Object.values(get().panels).flatMap((panel) =>
            panel.tabs.filter((tab) => tab.type === 'pdf')
          )
        );
        set(createDefaultState());
      },
    }),
    {
      name: 'waypoint-desktop-canvas',
      version: 8,
      partialize: partializeCanvasState,
      migrate: migratePersistedCanvasState,

      onRehydrateStorage: () => (rehydratedState) => {
        if (!rehydratedState) return;

        const targetPanels = Object.entries(rehydratedState.panels).filter(([, panel]) =>
          panel.tabs.some((tab) => fileBackedTabPath(tab) !== null)
        );
        if (targetPanels.length === 0) return;

        queueMicrotask(() => {
          useCanvasStore.setState({ oversizeScanComplete: false });
          void (async () => {
            try {
              const { initPlatform, platform } = await import('../../platform');
              const { getSetting } = await import('../../db');
              const { WORKSPACE_PATH_KEY } = await import('../../hooks/useWorkspace');
              const { resolveFilePathWithPersistedWorkspace } =
                await import('../../hooks/resolveFilePath');
              await initPlatform();

              const persistedWorkspaceRoot = await getSetting(WORKSPACE_PATH_KEY);
              const stat = (path: string): Promise<{ size: number } | null> =>
                platform()
                  .fs.stat(resolveFilePathWithPersistedWorkspace(path, persistedWorkspaceRoot))
                  .then((s) => ({ size: s.size }))
                  .catch((err) => {
                    if (isMissingFileError(err)) return null;
                    throw err;
                  });

              const scannedByPanel: Record<string, Tab[]> = {};
              const { resolveSequenceDocument } =
                await import('../sequence/public/sequence-document-repository');
              const resolveSequenceSource = async (
                ref: NonNullable<Tab['sequenceDocument']>
              ): Promise<string> => (await resolveSequenceDocument(ref)).sourcePath;
              await Promise.all(
                targetPanels.map(async ([panelId, panel]) => {
                  scannedByPanel[panelId] = await scanTabsForOversize(
                    panel.tabs,
                    stat,
                    resolveSequenceSource
                  );
                })
              );

              const { logOversizedDecision } =
                await import('../sequence/public/oversized-telemetry');
              const { extBucket, sizeBucket } = await import('../../shared/oversized-guard');
              for (const tabs of Object.values(scannedByPanel)) {
                for (const t of tabs) {
                  if (t.loadStatus === 'deferred-oversized') {
                    logOversizedDecision({
                      extBucket: extBucket(t.entityId),
                      sizeBucket: sizeBucket(t.fileSizeBytes ?? 0),
                      decision: 'deferred-on-rehydrate',
                    });
                  }
                }
              }

              useCanvasStore.getState().applyOversizeScan(scannedByPanel);
            } catch (err) {
              debugWarn('[Canvas] Oversize scan failed, unblocking content', err);
              useCanvasStore.setState({ oversizeScanComplete: true });
            }
          })();
        });
      },
    }
  )
);

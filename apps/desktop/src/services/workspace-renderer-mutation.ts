import { toUserMessage } from '@waypoint/user-messages';
import type {
  WorkspaceRendererMutationAppliedEvent,
  WorkspaceRendererMutationEvent,
  WorkspaceRendererMutationPreparingEvent,
} from '../shared/workspace-renderer-mutation';
import { normalizePathForBoundary, pathIsAtOrUnder } from '../shared/path-boundary';
import { stripWorkspaceScope } from '../shared/workspace-scoped-identity';
import { platform } from '../platform';
import {
  assertWorkspaceEditorsSettled,
  freezeWorkspaceEditorWrites,
  isWorkspaceEditorInputFrozen,
} from './workspace-editor-mutation-state';
import { useCanvasStore } from '../features/canvas';
import { usePageStore } from '../features/page/store';
import { parseWorkspaceArtifact } from '../db/workspace-artifacts';
import {
  hasPendingDesignArtifactMirror,
  resumeDesignArtifactMirrors,
  suspendDesignArtifactMirrors,
} from '../features/design/design-artifact-mirror';
import { useDesignStore } from '../features/design/store';
import {
  isBinarySequencePath,
  parseBinarySequenceFileAsAnnotated,
  parseTextSequenceFileAsAnnotated,
} from '../shared/parse-sequence-file';
import { resolveSequenceDocument } from '../features/sequence/sequence-document-repository';
import { useSequenceStore } from '../features/sequence/store';
import { useToastStore } from '../stores/toast-store';
import {
  beginWorkspaceSyncRendererGeneration,
  finishWorkspaceSyncRendererGeneration,
} from './workspace-sync-renderer-generation';
import { runWorkspaceReconcileOperation } from './workspace-operations';

interface ReplicaRefreshPanel {
  id: string;
  tabs: Array<{ id: string; entityId: string }>;
}

export interface WorkspaceRendererMutationRefreshDeps {
  assertCurrent?(): void;
  reloadPages(pageIds: readonly string[]): Promise<{ missingIds: string[] }>;
  sequenceDocumentIdForPath(path: string): string | null;
  isSequenceLoaded(documentId: string): boolean;
  reloadSequence(documentId: string, path: string): Promise<void>;
  clearSequence(documentId: string): void;
  getPanels(): ReplicaRefreshPanel[];
  closeTab(panelId: string, tabId: string): void;

  reconcileWorkspace(workspaceRoot: string, mutationToken: string): Promise<void>;
}

interface ActiveReplicaFreeze {
  controller: AbortController;
  deliveryId: string;
  workspaceRoot: string;
  affectedNotebookIds: ReadonlySet<string>;
  affectedDesignIds: ReadonlySet<string>;
  affectedEntityIds: ReadonlySet<string>;
  preparation: WorkspaceRendererMutationPreparingEvent;
  sequenceDocumentIdsByPath: Map<string, string>;
  release(): void;
}

const activeFreezes = new Map<string, ActiveReplicaFreeze>();
const BLOCKED_INPUT_EVENTS = [
  'beforeinput',
  'keydown',
  'paste',
  'cut',
  'drop',
  'compositionstart',
  'pointerdown',
  'mousedown',
  'click',
] as const;

function focusedTabEntityId(): string | null {
  const canvas = useCanvasStore.getState();
  const focusedPanel = canvas.focusedPanelId ? canvas.panels[canvas.focusedPanelId] : null;
  return focusedPanel?.tabs.find((tab) => tab.id === focusedPanel.activeTabId)?.entityId ?? null;
}

function eventTouchesReplicaSurface(event: Event): boolean {
  const target = event.target;
  const pageId =
    target instanceof Element
      ? target.closest<HTMLElement>('[data-page-id]')?.dataset.pageId
      : undefined;
  const activeEntityId = focusedTabEntityId();
  const markedEntityId =
    target instanceof Element
      ? target.closest<HTMLElement>('[data-workspace-mutation-entity-id]')?.dataset
          .workspaceMutationEntityId
      : undefined;
  if ([pageId, markedEntityId].some((id) => id && isWorkspaceEditorInputFrozen(id))) return true;
  const insideFocusedPanel =
    target instanceof Element && Boolean(target.closest('[data-panel-focused="true"]'));
  for (const freeze of activeFreezes.values()) {
    if (pageId && freeze.affectedNotebookIds.has(pageId)) return true;
    const markedId =
      target instanceof Element
        ? target.closest<HTMLElement>('[data-workspace-mutation-entity-id]')?.dataset
            .workspaceMutationEntityId
        : undefined;
    if (markedId && freeze.affectedEntityIds.has(markedId)) return true;
    if (!insideFocusedPanel) continue;
    if (
      activeEntityId &&
      (freeze.affectedEntityIds.has(activeEntityId) ||
        [...freeze.sequenceDocumentIdsByPath.values()].includes(activeEntityId))
    )
      return true;
    if (activeEntityId && freeze.affectedNotebookIds.has(activeEntityId)) return true;
    if (activeEntityId && freeze.affectedDesignIds.has(activeEntityId)) return true;
    if (activeEntityId && pathIsAtOrUnder(activeEntityId, freeze.workspaceRoot)) return true;
  }
  return false;
}

function blockReplicaInput(event: Event): void {
  if (!eventTouchesReplicaSurface(event)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}

function installReplicaInputFreeze(): () => void {
  if (activeFreezes.size === 0) {
    for (const eventName of BLOCKED_INPUT_EVENTS) {
      document.addEventListener(eventName, blockReplicaInput, true);
    }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (activeFreezes.size > 0) return;
    for (const eventName of BLOCKED_INPUT_EVENTS) {
      document.removeEventListener(eventName, blockReplicaInput, true);
    }
  };
}

function hasUnsavedRendererWork(
  event: {
    workspaceRoot: string;
    affectedNotebookIds: readonly string[];
    affectedDesignIds: readonly string[];
    affectedEntityIds: readonly string[];
  },
  sequenceDocumentIdsByPath?: ReadonlyMap<string, string>
): boolean {
  const dirtyPages = usePageStore.getState().dirtyIds;
  if (event.affectedNotebookIds.some((pageId) => dirtyPages.has(pageId))) return true;
  if (hasPendingDesignArtifactMirror(event.affectedDesignIds)) return true;
  const dirtyDocumentIds = new Set(
    Object.entries(useSequenceStore.getState().dirtyPaths)
      .filter(([, dirty]) => dirty)
      .map(([documentId]) => documentId)
  );
  if (dirtyDocumentIds.size === 0) return false;
  if (event.affectedEntityIds.some((documentId) => dirtyDocumentIds.has(documentId))) return true;
  if (
    sequenceDocumentIdsByPath &&
    [...sequenceDocumentIdsByPath].some(
      ([path, documentId]) =>
        dirtyDocumentIds.has(documentId) && pathIsAtOrUnder(path, event.workspaceRoot)
    )
  ) {
    return true;
  }
  return Object.values(useCanvasStore.getState().panels).some((panel) =>
    panel.tabs.some(
      (tab) =>
        tab.type === 'sequence' &&
        dirtyDocumentIds.has(tab.entityId) &&
        tab.sequenceDocument?.kind === 'managed-sequence' &&
        pathIsAtOrUnder(tab.sequenceDocument.packageRoot, event.workspaceRoot)
    )
  );
}

async function captureSequenceSourceBindings(freeze: ActiveReplicaFreeze): Promise<void> {
  const source = freeze.preparation.source;
  if (source.kind === 'document-command') {
    freeze.sequenceDocumentIdsByPath.set(source.sourcePath, source.documentId);
    return;
  }
  const sequenceTabs = Object.values(useCanvasStore.getState().panels).flatMap((panel) =>
    panel.tabs.filter(
      (tab) => tab.type === 'sequence' && tab.sequenceDocument?.kind !== 'indexed-sequence'
    )
  );
  await Promise.all(
    sequenceTabs.map(async (tab) => {
      if (!tab.sequenceDocument) return;
      try {
        const resolved = await resolveSequenceDocument(tab.sequenceDocument);
        if (pathIsAtOrUnder(resolved.sourcePath, freeze.workspaceRoot)) {
          freeze.sequenceDocumentIdsByPath.set(resolved.sourcePath, tab.entityId);
        }
      } catch (error) {
        if (useSequenceStore.getState().isDirty(tab.entityId)) {
          const detail = error instanceof Error ? ` ${error.message}` : '';
          throw new Error(
            `Remote replica apply refused because dirty sequence ${tab.entityId} has no resolvable source.${detail}`
          );
        }
      }
    })
  );
}

function blurAffectedNotebookEditor(event: WorkspaceRendererMutationPreparingEvent): void {
  const focused = document.activeElement;
  if (!(focused instanceof HTMLElement) || focused === document.body) return;
  const pageRoot = focused.closest<HTMLElement>('[data-page-id]');
  const pageId = pageRoot?.dataset.pageId;
  if (pageId && event.affectedNotebookIds.includes(pageId)) focused.blur();
}

export function prepareWorkspaceRendererMutation(
  event: WorkspaceRendererMutationPreparingEvent
): void {
  const source = event.source;
  if (
    source.kind === 'document-command' &&
    (!source.actionId ||
      !source.documentId ||
      !event.affectedEntityIds.includes(source.documentId) ||
      !pathIsAtOrUnder(source.sourcePath, event.workspaceRoot) ||
      normalizePathForBoundary(source.sourcePath) === normalizePathForBoundary(event.workspaceRoot))
  ) {
    throw new Error('The native document mutation has no matching workspace identity.');
  }
  const existing = activeFreezes.get(normalizePathForBoundary(event.workspaceRoot));
  if (existing) {
    if (existing.deliveryId === event.deliveryId) return;
    throw new Error(
      `Workspace ${normalizePathForBoundary(event.workspaceRoot)} already has a replica apply in progress.`
    );
  }

  const releaseInput = installReplicaInputFreeze();
  const releaseWrites = freezeWorkspaceEditorWrites(event);
  const release = () => {
    releaseWrites();
    releaseInput();
  };
  try {
    beginWorkspaceSyncRendererGeneration(event.workspaceRoot, event.deliveryId);
  } catch (error) {
    release();
    throw error;
  }
  activeFreezes.set(normalizePathForBoundary(event.workspaceRoot), {
    controller: new AbortController(),
    deliveryId: event.deliveryId,
    workspaceRoot: event.workspaceRoot,
    affectedNotebookIds: new Set(event.affectedNotebookIds),
    affectedDesignIds: new Set(event.affectedDesignIds),
    affectedEntityIds: new Set(event.affectedEntityIds),
    preparation: event,
    sequenceDocumentIdsByPath: new Map(),
    release,
  });

  blurAffectedNotebookEditor(event);
  try {
    assertWorkspaceEditorsSettled(event);
    if (hasUnsavedRendererWork(event))
      throw new Error('Project update refused because an editor has unsaved changes.');
  } catch (error) {
    activeFreezes.delete(normalizePathForBoundary(event.workspaceRoot));
    finishWorkspaceSyncRendererGeneration(event.workspaceRoot, event.deliveryId);
    release();
    throw error;
  }
  suspendDesignArtifactMirrors(event.affectedDesignIds);
}

export function abortWorkspaceRendererMutation(event: {
  deliveryId: string;
  workspaceRoot: string;
}): void {
  const active = activeFreezes.get(normalizePathForBoundary(event.workspaceRoot));
  if (!active || active.deliveryId !== event.deliveryId) return;
  activeFreezes.delete(normalizePathForBoundary(event.workspaceRoot));
  active.controller.abort();
  resumeDesignArtifactMirrors([...active.affectedDesignIds], { scheduleLatest: true });
  finishWorkspaceSyncRendererGeneration(active.workspaceRoot, event.deliveryId);
  active.release();
}

function finishWorkspaceRendererMutation(event: {
  deliveryId: string;
  workspaceRoot: string;
}): void {
  const active = activeFreezes.get(normalizePathForBoundary(event.workspaceRoot));
  if (!active || active.deliveryId !== event.deliveryId) return;
  activeFreezes.delete(normalizePathForBoundary(event.workspaceRoot));
  active.controller.abort();
  resumeDesignArtifactMirrors([...active.affectedDesignIds], { scheduleLatest: false });
  finishWorkspaceSyncRendererGeneration(active.workspaceRoot, event.deliveryId);
  active.release();
}

export async function refreshWorkspaceRendererMutation(
  event: WorkspaceRendererMutationAppliedEvent,
  deps: WorkspaceRendererMutationRefreshDeps
): Promise<void> {
  deps.assertCurrent?.();
  const deletedEntityIds = new Set([...event.deletedPaths, ...event.deletedEntityIds]);
  const pageResult = await deps.reloadPages(event.affectedNotebookIds);
  deps.assertCurrent?.();
  for (const pageId of pageResult.missingIds) deletedEntityIds.add(pageId);

  for (const path of event.changedPaths) {
    const documentId = deps.sequenceDocumentIdForPath(path);
    if (documentId && deps.isSequenceLoaded(documentId)) {
      await deps.reloadSequence(documentId, path);
      deps.assertCurrent?.();
    }
  }
  for (const path of event.deletedPaths) {
    const documentId = deps.sequenceDocumentIdForPath(path);
    if (!documentId) continue;
    deps.clearSequence(documentId);
    deletedEntityIds.add(documentId);
  }

  for (const path of event.changedPaths) {
    if (!path.toLowerCase().endsWith('.wpdesign.json')) continue;
    const artifact = parseWorkspaceArtifact(await platform().fs.readTextFile(path));
    deps.assertCurrent?.();
    if (
      artifact.kind !== 'assembly-design' ||
      !event.affectedDesignIds.includes(artifact.id) ||
      (artifact.design && stripWorkspaceScope(artifact.design.id) !== artifact.id)
    ) {
      throw new Error(
        `Replica design artifact identity does not match its refresh notice: ${path}`
      );
    }
    if (artifact.design)
      useDesignStore.getState().upsertDesignFromArtifact({ ...artifact.design, id: artifact.id });
    else {
      useDesignStore.getState().deleteDesign(artifact.id);
      deletedEntityIds.add(artifact.id);
    }
  }
  for (const designId of event.deletedDesignIds) {
    useDesignStore.getState().deleteDesign(designId);
    deletedEntityIds.add(designId);
  }

  const tabsToClose = deps
    .getPanels()
    .flatMap((panel) =>
      panel.tabs
        .filter((tab) => deletedEntityIds.has(tab.entityId))
        .map((tab) => ({ panelId: panel.id, tabId: tab.id }))
    );
  for (const tab of tabsToClose) deps.closeTab(tab.panelId, tab.tabId);

  await deps.reconcileWorkspace(event.workspaceRoot, event.mutationToken);
  deps.assertCurrent?.();
}

export async function handleWorkspaceRendererMutationWithStores(
  event: WorkspaceRendererMutationEvent
): Promise<void> {
  if (event.phase === 'preparing') {
    prepareWorkspaceRendererMutation(event);
    const active = activeFreezes.get(normalizePathForBoundary(event.workspaceRoot));
    if (!active || active.deliveryId !== event.deliveryId) {
      throw new Error('Replica preparation did not install its renderer freeze.');
    }
    try {
      await captureSequenceSourceBindings(active);
      if (activeFreezes.get(normalizePathForBoundary(event.workspaceRoot)) !== active)
        throw new Error('Project refresh was superseded.');
      assertWorkspaceEditorsSettled(event);
    } catch (error) {
      abortWorkspaceRendererMutation(event);
      throw error;
    }
    if (hasUnsavedRendererWork(event, active.sequenceDocumentIdsByPath)) {
      abortWorkspaceRendererMutation(event);
      throw new Error('Remote replica apply refused because an editor has unsaved changes.');
    }
    return;
  }
  if (event.phase === 'released') {
    if (event.disposition === 'unchanged') abortWorkspaceRendererMutation(event);
    else {
      const active = activeFreezes.get(normalizePathForBoundary(event.workspaceRoot));
      if (active?.deliveryId === event.deliveryId) {
        evictFailedMutationRefreshState(
          {
            ...active.preparation,
            phase: 'applied',
            mutationToken: '',
            changedPaths: [...active.sequenceDocumentIdsByPath.keys()],
            deletedPaths: [],
            deletedDesignIds: [],
            deletedEntityIds: [],
          },
          active.sequenceDocumentIdsByPath
        );
        finishWorkspaceRendererMutation(event);
      }
    }
    return;
  }

  const active = activeFreezes.get(normalizePathForBoundary(event.workspaceRoot));
  if (!active || active.deliveryId !== event.deliveryId) {
    throw new Error('Replica apply arrived without its matching renderer preparation freeze.');
  }
  const isCurrent = () =>
    activeFreezes.get(normalizePathForBoundary(event.workspaceRoot)) === active;
  const assertCurrent = () => {
    if (!isCurrent()) throw new Error('Project refresh was superseded.');
  };

  try {
    assertWorkspaceEditorsSettled(event);
    if (hasUnsavedRendererWork(event, active.sequenceDocumentIdsByPath)) {
      throw new Error('Replica apply cannot refresh over unsaved renderer state.');
    }
    assertCurrent();
    await refreshWorkspaceRendererMutation(event, {
      assertCurrent,
      reloadPages: (pageIds) =>
        usePageStore.getState().reloadPages(pageIds, { beforePublish: assertCurrent }),
      sequenceDocumentIdForPath: (path) => active.sequenceDocumentIdsByPath.get(path) ?? null,
      isSequenceLoaded: (documentId) => useSequenceStore.getState().hasSequence(documentId),
      reloadSequence: async (documentId, path) => {
        const parsed = isBinarySequencePath(path)
          ? parseBinarySequenceFileAsAnnotated(await platform().fs.readFile(path), path)
          : parseTextSequenceFileAsAnnotated(await platform().fs.readTextFile(path), path);
        assertCurrent();
        useSequenceStore.getState().setSequence(documentId, parsed.sequence);
        useSequenceStore.getState().markClean(documentId);
      },
      clearSequence: (documentId) => useSequenceStore.getState().clearSequence(documentId),
      getPanels: () => Object.values(useCanvasStore.getState().panels),
      closeTab: (panelId, tabId) => useCanvasStore.getState().closeTab(panelId, tabId),
      reconcileWorkspace: async (workspaceRoot, mutationToken) => {
        await runWorkspaceReconcileOperation({
          workspaceRoot,
          operationId: `replica-refresh:${event.deliveryId}`,
          mutationToken,
          assertCurrent,
          strict: true,
          catalogSource: 'head',
          healManagedHead: false,
          displayDelivery: 'required',
          filesChanged: { notifyGitStatus: true },
        });
      },
    });

    assertWorkspaceEditorsSettled(event);
    if (hasUnsavedRendererWork(event, active.sequenceDocumentIdsByPath)) {
      throw new Error('Renderer became dirty while the replica refresh was completing.');
    }
    for (const warning of event.warnings ?? []) {
      useToastStore
        .getState()
        .addToast(toUserMessage(warning), { definition: 'workspace-refresh-warning' });
    }
  } catch (error) {
    if (isCurrent()) evictFailedMutationRefreshState(event, active.sequenceDocumentIdsByPath);
    throw error;
  } finally {
    if (isCurrent()) finishWorkspaceRendererMutation(event);
  }
}

function evictFailedMutationRefreshState(
  event: WorkspaceRendererMutationAppliedEvent,
  sequenceDocumentIdsByPath: ReadonlyMap<string, string>
): void {
  usePageStore.getState().evictPages(event.affectedNotebookIds);
  const affectedPaths = new Set([...event.changedPaths, ...event.deletedPaths]);
  const affectedSequenceDocumentIds = new Set(
    [...affectedPaths]
      .map((path) => sequenceDocumentIdsByPath.get(path))
      .filter((documentId): documentId is string => Boolean(documentId))
  );
  for (const documentId of affectedSequenceDocumentIds) {
    useSequenceStore.getState().clearSequence(documentId);
  }
  for (const designId of event.affectedDesignIds) {
    useDesignStore.getState().deleteDesign(designId);
  }
  const affectedEntities = new Set<string>([
    ...event.affectedEntityIds,
    ...event.affectedNotebookIds,
    ...affectedPaths,
  ]);
  for (const documentId of affectedSequenceDocumentIds) affectedEntities.add(documentId);
  for (const designId of event.affectedDesignIds) affectedEntities.add(designId);
  for (const panel of Object.values(useCanvasStore.getState().panels)) {
    for (const tab of panel.tabs) {
      if (affectedEntities.has(tab.entityId)) {
        useCanvasStore.getState().closeTab(panel.id, tab.id);
      }
    }
  }
}

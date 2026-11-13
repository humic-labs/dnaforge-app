import { openDocument } from '../../document-opening/public/open-document';
import { useCanvasStore } from '../../canvas/public/store';
import type { Tab, TabViewState } from '../../canvas/public/types';
import type { DBEntityReference } from '../../../db/entity-references';
import { useStructure3dStore } from '../../page/public/embeds/structure3d/store';
import type { HighlightGroup, Structure3dAttrs } from '../../page/public/embeds/structure3d/types';
import { resolveReference } from './resolver';
import { molecularViewAttrs } from '../../page/public/embeds/structure3d/molecularView';
import { molViewSpecColorGroups } from '../../page/public/embeds/structure3d/molstar/molViewSpecLegend';
import { requestStructureReferenceTarget } from '../../page/public/embeds/structure3d/structureReferenceTarget';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { openSequenceDocument, openSequenceFile } from '../../document-opening/public/compat';
import { resolveSequenceDocumentById } from '../../sequence/public/sequence-document-repository';
import { getCurrentCatalogFileForEntity } from '../../../db/workspace-catalog';
import { platform } from '../../../platform';
import { useDesignStore } from '../../design/public/store';
import { resolveMolecularReferenceSnapshot } from './molecular';
import { resolveExactNativeCatalogDestination } from '../../../services/native-catalog-destination';
import { getCanonicalOligoEntity } from '../../primers/public/primer-references';
import {
  dispatchReferenceEvent,
  referenceIntent,
  type ReferenceIntent,
} from '../../page/public/reference-workflow';
import { openMolecularDocument } from '../../molecular-documents/public/open';

export interface ReferenceNavigationResult {
  tabType: string;
  entityId: string;
  label: string;
  panelId?: string;
  tabId?: string;
  registryEntityId?: string;
  created: boolean;
  movedFromPanelId?: string;
  viewState?: TabViewState;
  tab?: Pick<Tab, 'id' | 'type' | 'entityId' | 'label' | 'viewState' | 'pendingViewState'>;
}

export interface ReferenceNavigationOptions {
  sourceChatConversationId?: string | null;

  sourceNotebookPageId?: string;

  snapshotIndex?: number;

  target?: boolean;
}

function findTabSnapshot(panelId: string, tabId: string): ReferenceNavigationResult['tab'] {
  const panel = useCanvasStore.getState().panels[panelId];
  const tab = panel?.tabs.find((candidate) => candidate.id === tabId);
  if (!tab) return undefined;

  return {
    id: tab.id,
    type: tab.type,
    entityId: tab.entityId,
    label: tab.label,
    viewState: tab.viewState,
    pendingViewState: tab.pendingViewState,
  };
}

function structureAttrsForReference(
  tabType: string,
  entityId: string,
  viewState: TabViewState | undefined
): Structure3dAttrs | undefined {
  if (tabType !== 'structure') return undefined;

  const current = useStructure3dStore.getState().expandedStructures[entityId]?.data;
  const highlightGroups = viewState?.highlightGroups;
  if (!Array.isArray(highlightGroups)) return current;

  return {
    ...current,
    highlightGroups: highlightGroups as HighlightGroup[],
  };
}

export async function navigateToReference(
  ref: DBEntityReference,
  options?: ReferenceNavigationOptions
): Promise<ReferenceNavigationResult> {
  const { resolveReferenceNavigation } =
    await import('../../../services/entity-navigation-resolution');
  return presentResolvedReference(await resolveReferenceNavigation(ref), options);
}

export async function presentResolvedReference(
  ref: DBEntityReference,
  options?: ReferenceNavigationOptions
): Promise<ReferenceNavigationResult> {
  const resolved = await resolveMolecularReferenceSnapshot(ref, options);
  const {
    subject,
    target: destination,
    view: savedView,
    snapshotIndex: destinationIndex,
  } = resolved;
  const navigationReference = resolved.reference;
  if (
    (destination || (subject?.kind === 'document' && subject.document.viewId)) &&
    options?.snapshotIndex !== undefined &&
    options.snapshotIndex !== destinationIndex
  )
    throw Error('This reference has a pinned view step.');
  const documentResolution = resolved.document;
  const groupId = destination?.groupId ?? documentResolution?.documentReference.groupId;
  const decoded = documentResolution
    ? {
        tabType: 'structure' as const,
        entityId: `molecular-document:${documentResolution.catalogEntityId}${documentResolution.documentReference.revisionId !== documentResolution.saved.document.currentReferenceId ? `@${documentResolution.documentReference.revisionId}` : ''}`,
        label: documentResolution.snapshot.title,
        viewState: ref.deep_link_params
          ? (() => {
              const groups = JSON.parse(ref.deep_link_params!).highlightGroups;
              return Array.isArray(groups) ? { highlightGroups: groups } : undefined;
            })()
          : undefined,
        legacySequenceSourcePath: undefined,
      }
    : resolveReference(navigationReference);
  const { tabType, entityId, label, viewState, legacySequenceSourcePath } = decoded;
  const store = useCanvasStore.getState();
  const savedReferenceId = navigationReference.id;
  if (
    destination?.groupId &&
    !molViewSpecColorGroups(savedView!.scene, destinationIndex!).some(
      (group) => group.id === destination.groupId && group.selectable
    )
  )
    throw Error('The named selection is unavailable in the pinned view step.');
  let initialStructureAttrs = savedView
    ? molecularViewAttrs(
        entityId,
        savedView,
        destinationIndex ?? options?.snapshotIndex,
        savedReferenceId
      )
    : structureAttrsForReference(tabType, entityId, viewState);
  if (destination?.document && initialStructureAttrs) {
    const document = destination.document;
    initialStructureAttrs = {
      ...initialStructureAttrs,
      molecularDocumentId: document.id,
      molecularDocumentPath: document.path,
      molecularDocumentRevision: document.revision,
      molecularDocumentSavedReferenceId: document.savedReferenceId,
    };
  }
  if (
    subject?.kind === 'selection' &&
    subject.target &&
    initialStructureAttrs &&
    ref.deep_link_params
  ) {
    const groups = JSON.parse(ref.deep_link_params).highlightGroups;
    if (!Array.isArray(groups)) throw Error('The pinned molecular selection is unavailable.');
    initialStructureAttrs = { ...initialStructureAttrs, highlightGroups: groups };
  }
  let preserveTargetView = false;
  if (
    !documentResolution &&
    initialStructureAttrs &&
    useStructure3dStore.getState().expandedStructures[entityId]
  ) {
    const current = useStructure3dStore.getState().expandedStructures[entityId].data;
    preserveTargetView = Boolean(
      options?.target &&
      groupId &&
      savedView &&
      current.molViewSpec === initialStructureAttrs.molViewSpec &&
      (current.molViewSpecSnapshotIndex ?? 0) ===
        (initialStructureAttrs.molViewSpecSnapshotIndex ?? 0)
    );
    if (!preserveTargetView && (savedView || Array.isArray(viewState?.highlightGroups))) {
      useStructure3dStore.getState().clearSelection(entityId);
    }
    if (!preserveTargetView)
      useStructure3dStore.getState().updateStructureData(entityId, initialStructureAttrs);
  }
  const panelIds = Object.keys(store.panels);
  const sourceConversationId = options?.sourceChatConversationId;
  const exactChat =
    typeof sourceConversationId === 'string' ? store.findTab('chat', sourceConversationId) : null;
  const workingPanelId = options?.sourceNotebookPageId
    ? store.findTab('page', options.sourceNotebookPageId)?.panelId
    : sourceConversationId === null
      ? undefined
      : typeof sourceConversationId === 'string'
        ? exactChat?.panelId
        : panelIds.find((id) => store.panels[id].tabs.some((tab) => tab.type === 'chat'));
  const targetPanelId = workingPanelId
    ? store.agentContentPlacement(workingPanelId).targetPanelId
    : (store.focusedPanelId ?? panelIds[0]);
  if (!targetPanelId) {
    throw new Error('No canvas panel is available for reference navigation.');
  }
  const finishNavigation = (result: ReferenceNavigationResult) => {
    if (tabType === 'structure' && (savedView || groupId || options?.target)) {
      requestStructureReferenceTarget(entityId, {
        intent: groupId
          ? options?.target
            ? 'target'
            : 'select'
          : savedView
            ? 'open-view'
            : 'target',
        ...(savedView
          ? {
              scene: savedView.scene,
              snapshotIndex:
                destinationIndex ?? options?.snapshotIndex ?? savedView.initialSnapshotIndex ?? 0,
            }
          : {}),
        ...(groupId ? { groupId } : {}),
        ...(Array.isArray(viewState?.highlightGroups)
          ? { highlightGroups: viewState.highlightGroups as HighlightGroup[] }
          : {}),
      });
    }
    return result;
  };

  if (documentResolution) {
    const documentReference = documentResolution.documentReference;
    const opened = await openMolecularDocument(documentResolution.saved.path, {
      workspaceRoot: documentResolution.saved.workspaceRoot,
      revisionId: documentReference.revisionId,
      viewId: destination?.viewId ?? documentReference.viewId,
      snapshotIndex: destinationIndex ?? options?.snapshotIndex,
      reference: documentReference,
      placement: { kind: 'panel', panelId: targetPanelId },
    });
    if (opened.status !== 'presented')
      throw Error(
        'message' in opened ? opened.message : 'The molecular document could not be opened.'
      );
    const tab = findTabSnapshot(opened.panelId, opened.tabId);
    if (tab?.entityId !== entityId || tab.type !== 'structure')
      throw Error('The molecular reference opened without its verified document identity.');
    return finishNavigation({
      tabType,
      entityId,
      label,
      panelId: opened.panelId,
      tabId: opened.tabId,
      created: opened.disposition === 'created',
      tab,
    });
  }

  const primerData =
    navigationReference.entity_type === 'primer' && navigationReference.data
      ? (JSON.parse(navigationReference.data) as Record<string, unknown>)
      : null;
  if (
    typeof primerData?.registryEntityId === 'string' &&
    !primerData.primerId &&
    !primerData.documentId &&
    !primerData.targetDocumentId
  ) {
    const entity = await getCanonicalOligoEntity(primerData.registryEntityId);
    return new Promise<ReferenceNavigationResult>((resolve, reject) => {
      const tracked = referenceIntent({});
      const intent: ReferenceIntent = {
        get finished() {
          return tracked.finished;
        },
        finish(disposition) {
          if (tracked.finished) return;
          tracked.finish(disposition);
          if (disposition.kind === 'registry_record')
            resolve({
              tabType: 'lims',
              entityId: entity.id,
              registryEntityId: entity.id,
              label: entity.name,
              created: false,
            });
          else reject(new Error('The canonical oligo could not be presented.'));
        },
      };
      dispatchReferenceEvent(
        { entityType: 'registry-oligo', entityId: entity.id, label: entity.name },
        intent
      );
    });
  }
  if (primerData?.primerId && !primerData.documentId && !primerData.targetDocumentId) {
    const root = navigationReference.workspace_root_path;
    if (!root || typeof primerData.primerId !== 'string')
      throw new Error('The primer reference has no owning project.');
    const destination = await resolveExactNativeCatalogDestination({
      workspaceRoot: root,
      entityId: primerData.primerId,
    });
    if (!destination || destination.locator.kind !== 'workspace_path')
      throw new Error('The referenced primer artifact is unavailable.');
    const result = await openDocument({
      target: { kind: 'file', path: destination.locator.absolutePath, tabType: 'primer' },
      label,
      placement: { kind: 'panel', panelId: targetPanelId },
    });
    if (result.status !== 'presented' || result.content === 'missing' || result.content === 'error')
      throw new Error('The primer editor could not be opened.');
    return {
      tabType: 'primer',
      entityId: destination.locator.absolutePath,
      label,
      panelId: result.panelId,
      tabId: result.tabId,
      created: result.disposition === 'created',
      tab: findTabSnapshot(result.panelId, result.tabId),
    };
  }

  if (
    navigationReference.entity_type === 'protein' &&
    navigationReference.locator.startsWith('git://') &&
    navigationReference.data
  ) {
    const data = JSON.parse(navigationReference.data) as Record<string, unknown>;
    if (typeof data.documentId === 'string') {
      const root = navigationReference.workspace_root_path;
      if (!root) throw new Error('The canonical file reference has no owning project.');
      const destination = await resolveExactNativeCatalogDestination({
        entityId: data.documentId,
        workspaceRoot: root,
      });
      const target =
        destination?.locator.kind === 'workspace_path'
          ? {
              kind: 'file' as const,
              path: destination.locator.absolutePath,
              tabType: destination.locator.tabType,
            }
          : destination?.locator.kind === 'lims_entity' &&
              destination.locator.entityId === data.documentId
            ? { kind: 'record' as const, tabType: 'record' as const, entityId: data.documentId }
            : null;
      if (!target) throw new Error('The canonical file reference target is unavailable.');
      const result = await openDocument({
        target,
        label,
        placement: { kind: 'panel', panelId: targetPanelId },
        view: { pendingViewState: viewState },
      });
      if (
        result.status !== 'presented' ||
        result.content === 'missing' ||
        result.content === 'error'
      )
        throw new Error('The canonical file reference could not be opened.');
      if (viewState)
        useCanvasStore.getState().setTabViewState(result.panelId, result.tabId, viewState);
      return {
        tabType: result.tabType,
        entityId: data.documentId,
        label,
        panelId: result.panelId,
        tabId: result.tabId,
        created: result.disposition === 'created',
        ...(viewState ? { viewState } : {}),
        tab: findTabSnapshot(result.panelId, result.tabId),
      };
    }
  }

  if (tabType === 'sequence') {
    const strategy = { kind: 'panel' as const, panelId: targetPanelId };
    const previousTabIds = new Set(
      Object.values(useCanvasStore.getState().panels).flatMap((panel) =>
        panel.tabs.map((tab) => tab.id)
      )
    );
    const tabId = legacySequenceSourcePath
      ? await openSequenceFile({ filePath: legacySequenceSourcePath, label, strategy })
      : await (async () => {
          const mountedRoots = useWorkspaceStore.getState().folders.map((folder) => folder.path);
          const savedRoot =
            typeof primerData?.targetProjectId === 'string'
              ? await (
                  await import('../../../services/entity-navigation-resolution')
                ).resolveEntityProjectRoot(primerData.targetProjectId)
              : ref.workspace_root_path?.trim();
          const resolutionRoots = savedRoot ? [savedRoot] : mountedRoots;
          const resolved = await resolveSequenceDocumentById(entityId, resolutionRoots);
          return openSequenceDocument(resolved.ref, { label, strategy });
        })();
    if (!tabId) throw new Error(`Could not open sequence reference “${label}”.`);

    const opened = Object.values(useCanvasStore.getState().panels)
      .flatMap((panel) => panel.tabs.map((tab) => ({ panelId: panel.id, tab })))
      .find((candidate) => candidate.tab.id === tabId && candidate.tab.type === 'sequence');
    if (!opened) throw new Error(`Sequence reference “${label}” opened without a sequence tab.`);

    let panelId = opened.panelId;
    let movedFromPanelId: string | undefined;
    if (workingPanelId && panelId !== targetPanelId) {
      useCanvasStore.getState().moveTab(panelId, targetPanelId, tabId);
      movedFromPanelId = panelId;
      panelId = targetPanelId;
    }
    if (viewState) {
      useCanvasStore.getState().setTabViewState(panelId, tabId, viewState);
    }
    return {
      tabType,
      entityId: opened.tab.entityId,
      label,
      panelId,
      tabId,
      created: !previousTabIds.has(tabId),
      ...(movedFromPanelId ? { movedFromPanelId } : {}),
      ...(viewState ? { viewState } : {}),
      tab: findTabSnapshot(panelId, tabId),
    };
  }

  if (
    tabType === 'design' &&
    (ref.locator.startsWith('entity://assembly/') || ref.locator.startsWith('git://'))
  ) {
    const fileReference = ref.locator.startsWith('git://');
    const file = fileReference ? null : await getCurrentCatalogFileForEntity(entityId);
    const path = fileReference
      ? entityId
      : file?.file_kind === 'waypoint-design'
        ? file.path
        : null;
    if (!path || !(await platform().fs.exists(path))) {
      throw new Error(`Saved design “${label}” is unavailable.`);
    }
    const result = await openDocument({
      target: { kind: 'file', path, tabType: 'design' },
      label,
      placement: { kind: 'panel', panelId: targetPanelId },
    });
    const tab =
      result.status === 'presented' ? findTabSnapshot(result.panelId, result.tabId) : null;
    if (
      result.status !== 'presented' ||
      result.content !== 'ready' ||
      tab?.type !== 'design' ||
      (!fileReference && tab.entityId !== entityId) ||
      !useDesignStore.getState().designs[tab.entityId]
    ) {
      throw new Error(`Saved design “${label}” could not be opened.`);
    }
    return {
      tabType: 'design',
      entityId: tab.entityId,
      label,
      panelId: result.panelId,
      tabId: result.tabId,
      created: result.disposition === 'created',
      tab,
    };
  }

  if (tabType === 'file' && ref.locator.startsWith('git://')) {
    const result = await openDocument({
      target: { kind: 'file', path: entityId },
      label,
      placement: { kind: 'panel', panelId: targetPanelId },
    });
    if (result.status !== 'presented')
      throw new Error('message' in result ? result.message : result.reason);
    const tab = findTabSnapshot(result.panelId, result.tabId);
    if (!tab || result.content === 'missing' || result.content === 'error')
      throw new Error(`Saved file “${label}” could not be opened.`);
    return finishNavigation({
      tabType: tab.type,
      entityId: tab.entityId,
      label,
      panelId: result.panelId,
      tabId: result.tabId,
      created: result.disposition === 'created',
      tab,
    });
  }

  const existing = store.findTab(tabType, entityId);
  if (existing) {
    let panelId = existing.panelId;
    let movedFromPanelId: string | undefined;

    if (workingPanelId && existing.panelId !== targetPanelId) {
      store.moveTab(existing.panelId, targetPanelId, existing.tabId);
      panelId = targetPanelId;
      movedFromPanelId = existing.panelId;
    } else {
      store.focusPanel(existing.panelId);
      store.setActiveTab(existing.panelId, existing.tabId);
    }

    if (viewState) {
      useCanvasStore.getState().setTabViewState(panelId, existing.tabId, viewState);
    }
    if (initialStructureAttrs && !preserveTargetView) {
      useCanvasStore.getState().updateTab(panelId, existing.tabId, {
        initialStructureAttrs,
        ...(savedView ? { molecularViewReferenceId: savedReferenceId } : {}),
      });
    }

    return finishNavigation({
      tabType,
      entityId,
      label,
      panelId,
      tabId: existing.tabId,
      created: false,
      ...(movedFromPanelId ? { movedFromPanelId } : {}),
      ...(viewState ? { viewState } : {}),
      tab: findTabSnapshot(panelId, existing.tabId),
    });
  }

  const panelId = targetPanelId;
  const result = await openDocument({
    target: { kind: 'record', tabType, entityId },
    label,
    placement: { kind: 'panel', panelId },
    view: {
      pendingViewState: viewState,
      ...(initialStructureAttrs ? { initialStructureAttrs } : {}),
    },
  });
  if (result.status !== 'presented')
    throw new Error('message' in result ? result.message : result.reason);
  const tabId = result.tabId;
  if (savedView)
    useCanvasStore.getState().updateTab(panelId, tabId, { molecularViewReferenceId: ref.id });

  return finishNavigation({
    tabType,
    entityId,
    label,
    panelId,
    tabId,
    created: result.disposition === 'created',
    ...(viewState ? { viewState } : {}),
    tab: findTabSnapshot(panelId, tabId),
  });
}

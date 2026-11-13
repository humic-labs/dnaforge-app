import { toUserMessage, userMessage } from '@waypoint/user-messages';
import { useEffect, useCallback, useState } from 'react';
import type { Tab } from '../types';
import { useCanvasStore } from '../store';
import { LoadingTab } from './load-states';
import { usePredictionResultAttrs } from '../../compute/public/prediction-result-view';
import { useSavedMolecularViewAttrs } from '../../page/public/embeds/structure3d/hooks/useSavedMolecularViewAttrs';
import { useStructure3dStore } from '../../page/public/embeds/structure3d/store';
import { LazyStructure3dPanel } from '../../page/public/embeds/structure3d/components/LazyStructure3dPanel';
import { ProteinRunVersionSwitcher } from '../../page/public/embeds/protein-prompt-history/RunVersionSwitcher';
import { ProteinRunStructureSwitcher } from '../../page/public/embeds/protein-prompt-history/ProteinRunStructureSwitcher';
import {
  acknowledgeStructureViewHandoff,
  failStructureViewHandoff,
  markStructureViewHostInteractive,
  markStructureViewHostReleased,
} from '../../structure-drawer/public/state/structure-view-handoff';

export function StructureTabContent({
  tab,
  panelId,
  isActive,
}: {
  tab: Tab;
  panelId: string;
  isActive: boolean;
}) {
  const prediction = usePredictionResultAttrs(tab.predictionResult, tab.entityId);
  const savedView = useSavedMolecularViewAttrs(
    tab.entityId,
    tab.initialStructureAttrs,
    tab.molecularViewReferenceId
  );
  const [restored, setRestored] = useState<{
    entityId: string;
    attrs?: NonNullable<Tab['initialStructureAttrs']>;
    error?: string;
  } | null>(null);
  const nativePointer =
    tab.initialStructureAttrs?.molecularDocumentPath &&
    !tab.initialStructureAttrs.molViewSpec &&
    !tab.initialStructureAttrs.sourceId
      ? tab.initialStructureAttrs
      : undefined;
  useEffect(() => {
    if (
      !isActive ||
      (!nativePointer && (tab.initialStructureAttrs || !tab.entityId.startsWith('saved-view:')))
    )
      return;
    let cancelled = false;
    void (async () => {
      if (nativePointer?.molecularDocumentPath) {
        const [
          services,
          { getCurrentMolecularSnapshot, savedSelectionRefsForDocument },
          viewModule,
        ] = await Promise.all([
          import('../../molecular-documents/public/services'),
          import('../../../shared/molecular-document'),
          import('../../page/public/embeds/structure3d/molecularView'),
        ]);
        const saved = await services.readMolecularDocumentFollowingRename(
          nativePointer.molecularDocumentPath,
          nativePointer.molecularDocumentId
        );
        const savedSelectionRefs = savedSelectionRefsForDocument(saved);
        const attrs = {
          ...viewModule.molecularViewAttrs(
            tab.entityId,
            getCurrentMolecularSnapshot(saved.document),
            undefined,
            saved.document.currentReferenceId
          ),
          label: saved.document.name,
          molecularDocumentId: saved.document.id,
          molecularDocumentPath: saved.path,
          molecularDocumentRevision: saved.revision,
          molecularDocumentSavedReferenceId: saved.document.currentReferenceId,
          ...(savedSelectionRefs.length ? { savedSelectionRefs } : {}),
        };
        if (!cancelled) {
          setRestored({ entityId: tab.entityId, attrs });
          useCanvasStore.getState().updateTab(panelId, tab.id, {
            initialStructureAttrs: attrs,
            label: saved.document.name,
          });
        }
        return;
      }
      const [{ getEntityReferenceByLocator }, viewModule] = await Promise.all([
        import('../../../db/entity-references'),
        import('../../page/public/embeds/structure3d/molecularView'),
      ]);
      const row = await getEntityReferenceByLocator(`entity://structure/${tab.entityId}`);
      const view = row?.data ? viewModule.molecularViewFromReferenceData(row.data) : null;
      if (!view) throw new Error('The saved molecular view is missing or invalid.');
      await viewModule.validateMolecularViewCoordinates(view);
      if (!cancelled)
        setRestored({
          entityId: tab.entityId,
          attrs: viewModule.molecularViewAttrs(tab.entityId, view, undefined, row!.id),
        });
    })().catch((error: unknown) => {
      if (!cancelled)
        setRestored({
          entityId: tab.entityId,
          error: toUserMessage(error, 'failure.the-saved-molecular-view-could-not-open'),
        });
    });
    return () => {
      cancelled = true;
    };
  }, [tab.entityId, tab.id, tab.initialStructureAttrs, nativePointer, panelId, isActive]);
  const structureAttrs = tab.predictionResult
    ? prediction?.attrs
    : (savedView?.attrs ??
      (!nativePointer ? tab.initialStructureAttrs : undefined) ??
      (restored?.entityId === tab.entityId ? restored.attrs : undefined));
  const coordinateStructureId = structureAttrs?.structureBinding?.structureId ?? tab.entityId;
  const structureViewId = structureAttrs?.structureViewIdentity?.structureViewId ?? tab.entityId;
  const bindingId = structureAttrs?.structureBinding?.bindingId;
  const handoff = structureAttrs?.structureViewHandoff;
  const viewerInstanceId = `tab:${tab.id}`;

  useEffect(() => {
    if (!tab.molecularViewReferenceId) return;
    return useStructure3dStore.subscribe((state, previous) => {
      const attrs = state.expandedStructures[structureViewId]?.data;
      if (!attrs || attrs === previous.expandedStructures[structureViewId]?.data) return;
      const canvas = useCanvasStore.getState();
      const currentTab = canvas.panels[panelId]?.tabs.find((item) => item.id === tab.id);
      if (currentTab?.entityId === tab.entityId && currentTab.initialStructureAttrs !== attrs)
        canvas.updateTab(panelId, tab.id, { initialStructureAttrs: attrs });
    });
  }, [panelId, tab.id, tab.entityId, tab.molecularViewReferenceId, structureViewId]);

  useEffect(
    () => () => markStructureViewHostReleased(structureViewId, viewerInstanceId),
    [structureViewId, viewerInstanceId]
  );

  const handleLoad = useCallback(() => {
    markStructureViewHostInteractive(structureViewId, viewerInstanceId);
    if (!handoff) return;
    acknowledgeStructureViewHandoff({
      transactionId: handoff.transactionId,
      structureViewId,
      viewerInstanceId,
      generation: handoff.generation,
    });
  }, [handoff, structureViewId, viewerInstanceId]);

  const handleError = useCallback(
    (message: string) => {
      if (handoff) failStructureViewHandoff(handoff.transactionId, message);
    },
    [handoff]
  );

  if (tab.predictionResult && !prediction?.attrs)
    return (
      <div role={prediction?.error ? 'alert' : 'status'} className="p-3 text-sm">
        {prediction?.error != null
          ? toUserMessage(prediction?.error, 'failure.opening-saved-prediction')
          : userMessage('failure.opening-saved-prediction')}
      </div>
    );
  if (savedView && !savedView.attrs)
    return (
      <div role={savedView.error ? 'alert' : 'status'} className="p-3 text-sm">
        {savedView.error != null
          ? toUserMessage(savedView.error, 'failure.opening-saved-molecular-view')
          : userMessage('failure.opening-saved-molecular-view')}
      </div>
    );
  if ((nativePointer || tab.entityId.startsWith('saved-view:')) && !structureAttrs) {
    return restored?.entityId === tab.entityId && restored.error ? (
      <div
        role="alert"
        className="flex h-full items-center justify-center p-6 text-sm text-fg-muted"
      >
        {toUserMessage(restored.error, 'structure.failed')}
      </div>
    ) : (
      <LoadingTab />
    );
  }

  return (
    <LazyStructure3dPanel
      key={tab.entityId}
      structureId={coordinateStructureId}
      structureViewId={structureViewId}
      bindingId={bindingId}
      initialStructureAttrs={structureAttrs}
      viewerInstanceId={viewerInstanceId}
      rendererHostId={`pane:${panelId}`}
      navigationAccessory={
        tab.entityId.startsWith('saved-view:') ? (
          <ProteinRunStructureSwitcher
            panelId={panelId}
            tabId={tab.id}
            savedViewId={tab.entityId}
            isActive={isActive}
          />
        ) : undefined
      }
      headerAccessory={
        tab.entityId.startsWith('saved-view:') ? (
          <ProteinRunVersionSwitcher
            panelId={panelId}
            tabId={tab.id}
            savedViewId={tab.entityId}
            isActive={isActive}
          />
        ) : undefined
      }
      onLoad={handleLoad}
      onError={handleError}
    />
  );
}

import { useCanvasStore } from '../canvas/public/store';
import { getWorkspaceResidueSelectionsStore } from './state/selected-codon-registry';
import type { StructureDrawerRequest } from './types/structure-drawer';
import type { ResidueSelection } from '@waypoint/workspace-editor';
import type { RetainedProteinView, StructureInspection } from './public/inspection-types';
export type { InspectionViewSettings, StructureInspection } from './public/inspection-types';

export const structureInspectionId = (documentId: string) => `structure-inspection:${documentId}`;

export function inspectionProteinKey(request: StructureDrawerRequest): string {
  return JSON.stringify([
    request.identityRequestKey ?? request.cdsLabel ?? null,
    request.translation,
  ]);
}

export function retainedStructureInspectionViews() {
  return Object.values(useCanvasStore.getState().panels).flatMap((panel) =>
    panel.tabs.flatMap((tab) => {
      const inspection = tab.structureInspection;
      if (!inspection || tab.entityId !== structureInspectionId(inspection.request.entityId ?? ''))
        return [];
      const currentKey = inspectionProteinKey(inspection.request);
      return Object.entries(inspection.retainedProteinViews ?? {}).flatMap(([proteinKey, view]) => {
        if (
          proteinKey === currentKey ||
          !view.request ||
          view.request.entityId !== inspection.request.entityId ||
          proteinKey !== inspectionProteinKey(view.request) ||
          !view.viewSettings?.structureViewId ||
          !view.candidateId ||
          view.viewSettings.candidateId !== view.candidateId
        )
          return [];
        return [
          {
            panelId: panel.id,
            tabId: tab.id,
            proteinKey,
            view,
            request: view.request,
            structureViewId: view.viewSettings.structureViewId,
          },
        ];
      });
    })
  );
}

export function openStructureInspection(
  request: StructureDrawerRequest,
  selections?: ResidueSelection[],
  initialView?: RetainedProteinView & Pick<StructureInspection, 'retainedProteinViews'>
): string | undefined {
  const canvas = useCanvasStore.getState();
  const source = request.entityId ? canvas.findTab('sequence', request.entityId) : null;
  if (!source || !request.entityId)
    return 'Open the source sequence before inspecting its protein.';
  const entityId = structureInspectionId(request.entityId);
  const existing = canvas.findTab('structure', entityId);
  const previous = existing
    ? canvas.panels[existing.panelId]?.tabs.find((tab) => tab.id === existing.tabId)
        ?.structureInspection
    : undefined;
  const comparedReference = previous?.request.comparisonOf;
  const oldVariant = comparedReference?.variantContext;
  const nextVariant = request.variantContext;
  if (
    !initialView &&
    comparedReference &&
    oldVariant &&
    nextVariant &&
    inspectionProteinKey(comparedReference) === inspectionProteinKey(request) &&
    oldVariant.position === nextVariant.position &&
    oldVariant.referenceBase === nextVariant.referenceBase &&
    oldVariant.alternateBase === nextVariant.alternateBase &&
    JSON.stringify(oldVariant.product) === JSON.stringify(nextVariant.product)
  ) {
    request = { ...previous.request, comparisonOf: request, variantContext: nextVariant };
  }

  if (!initialView && previous && JSON.stringify(previous.request) === JSON.stringify(request))
    request = previous.request;
  const retainedProteinViews = {
    ...initialView?.retainedProteinViews,
    ...previous?.retainedProteinViews,
  };
  if (previous) {
    retainedProteinViews[inspectionProteinKey(previous.request)] = {
      candidateId: previous.candidateId,
      comparison: previous.comparison,
      attachedChainId: previous.attachedChainId,
      viewSettings: previous.viewSettings,
      savedViewReferenceId: previous.savedViewReferenceId,
      measurements: previous.measurements,
      activeMeasurementId: previous.activeMeasurementId,
      prediction: previous.prediction,
      catalogSource: previous.catalogSource,
      continuationReferenceId: previous.continuationReferenceId,
      request: previous.request,
      selections: previous.selections,
    };
  }
  const retained = retainedProteinViews[inspectionProteinKey(request)];
  const mutationCamera = previous?.mutationCamera ?? 'follow';
  const inspection: StructureInspection = {
    ...retained,
    ...initialView,
    request,
    selections,
    mutationCamera,
    focusSelectionId:
      mutationCamera === 'follow' && !initialView && request.variantContext && selections?.length
        ? crypto.randomUUID()
        : undefined,
    retainedProteinViews,
  };
  const label = `${request.cdsLabel ?? 'Protein'} · mutations`;
  let targetPanelId = existing?.panelId;
  if (!targetPanelId || targetPanelId === source.panelId) {
    targetPanelId = canvas.agentContentPlacement(source.panelId).targetPanelId;
  }
  if (existing) {
    if (existing.panelId !== targetPanelId) {
      canvas.moveTab(existing.panelId, targetPanelId, existing.tabId);
    }
    canvas.updateTab(targetPanelId, existing.tabId, { structureInspection: inspection, label });
    canvas.setActiveTab(targetPanelId, existing.tabId);
  } else {
    canvas.openTab(targetPanelId, {
      type: 'structure',
      entityId,
      label,
      structureInspection: inspection,
    });
  }
  canvas.setActiveTab(source.panelId, source.tabId);
  canvas.focusPanel(source.panelId);
  return undefined;
}

export function clearStructureInspection(documentId: string, message: string): void {
  const canvas = useCanvasStore.getState();
  const existing = canvas.findTab('structure', structureInspectionId(documentId));
  if (!existing) return;
  const tab = canvas.panels[existing.panelId]?.tabs.find((item) => item.id === existing.tabId);
  if (!tab?.structureInspection) return;
  if (
    !tab.structureInspection.request.variantContext &&
    tab.structureInspection.message === message
  )
    return;
  getWorkspaceResidueSelectionsStore(documentId)?.set([]);
  canvas.updateTab(existing.panelId, existing.tabId, {
    structureInspection: {
      ...tab.structureInspection,
      candidateId: tab.structureInspection.candidateId,
      viewSettings: tab.structureInspection.viewSettings,
      selections: undefined,
      focusSelectionId: undefined,
      request: { ...tab.structureInspection.request, variantContext: undefined },
      message,
    },
  });
}

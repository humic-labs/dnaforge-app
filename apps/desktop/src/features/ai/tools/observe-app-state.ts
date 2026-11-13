import { isTabDirty } from '../../canvas/public/artifact-document-lifecycle';
   
                                                                    
   

import { resultTool, toolSuccess } from '../../agent-bridge/public/tool-result';
export { observeAppStateOutputSchema } from './observe-app-state-output-schema';
import { z } from 'zod';
import { useCanvasStore } from '../../canvas/public/store';
import { useDesignStore } from '../../design/public/store';
import { useSequenceStore } from '../../sequence/public/store';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { useStructureLinkRegistry } from '../../structure-drawer/public/state/use-structure-link-registry';
import { usePaperProtocolReviewStore } from '../../paper-protocol-review/public/store';
import { projectDesignHeader } from './design-projection';

export const observeAppStateSchema = z
  .object({
    targetLabel: z.string().min(1).max(200).optional(),
    targetDesignId: z.string().min(1).optional(),
    targetSequenceDocumentId: z.string().min(1).optional(),
  })
  .strict();

export type ObserveAppStateInput = z.infer<typeof observeAppStateSchema>;

export function observeAppState(params: ObserveAppStateInput = {}) {
  const canvasState = useCanvasStore.getState();
  const workspaceState = useWorkspaceStore.getState();
  const designState = useDesignStore.getState();
  const sequenceState = useSequenceStore.getState();
  const structureLinkState = useStructureLinkRegistry.getState();
  const paperReviewState = usePaperProtocolReviewStore.getState();

  const panels = Object.values(canvasState.panels).map((panel) => ({
    id: panel.id,
    activeTabId: panel.activeTabId,
    tabCount: panel.tabs.length,
    tabs: panel.tabs.map((tab) => ({
      id: tab.id,
      type: tab.type,
      entityId: tab.entityId,
      label: tab.label,
      active: panel.activeTabId === tab.id,
      isDirty: isTabDirty(tab),
      loadStatus: tab.loadStatus ?? null,
    })),
  }));
  const tabs = panels.flatMap((panel) =>
    panel.tabs.map((tab) => ({
      ...tab,
      panelId: panel.id,
    }))
  );
  const designs = Object.values(designState.designs).map(projectDesignHeader);
  const sequences = Object.entries(sequenceState.sequences).map(([documentId, sequence]) => {
    const primerCount =
      'primers' in sequence && Array.isArray(sequence.primers) ? sequence.primers.length : 0;
    return {
      documentId,
      name: sequence.name ?? null,
      length: sequence.sequence.length,
      circular: sequence.circular ?? false,
      annotationCount: sequence.annotations?.length ?? 0,
      primerCount,
      version: sequenceState.sequenceVersions[documentId] ?? 0,
      dirty: sequenceState.dirtyPaths[documentId] === true,
    };
  });
  const selectedReview = paperReviewState.selectedStep
    ? paperReviewState.protocols[paperReviewState.selectedStep.protocolPath]
    : null;
  const selectedReviewStep = selectedReview?.steps.find(
    (step) => step.id === paperReviewState.selectedStep?.stepId
  );
  const selectedProtocolTab = selectedReview
    ? tabs.find(
        (tab) => tab.type === 'scientific-document' && tab.entityId === selectedReview.protocolPath
      )
    : null;

  return {
    schemaVersion: 1,
    workspace: {
      activeWorkspaceFile: workspaceState.activeWorkspaceFile,
      focusedPanelId: canvasState.focusedPanelId,
      folderCount: workspaceState.folders.length,
      folders: workspaceState.folders.map((folder) => ({
        name: folder.name,
        path: folder.path,
        pinned: folder.pinned === true,
      })),
      panelCount: panels.length,
      tabCount: tabs.length,
    },
    panels,
    tabs,
    designs: {
      count: designs.length,
      activeDesignId: designState.activeDesignId,
      items: designs,
    },
    sequences: {
      count: sequences.length,
      loadingDocumentIds: Array.from(sequenceState.loadingDocumentIds),
      items: sequences,
    },
                                                       
                                                                       
                                                                      
                                                                    
                                                   
                                                                        
                                                  
    structureLinks: {
      count: Object.keys(structureLinkState.links).length,
      items: Object.values(structureLinkState.links).map((link) => ({
        structureId: link.structureId,
        sequenceDocumentId: link.sequenceDocumentId,
        cdsLabel: link.cdsLabel,
        cdsStart: link.cdsStart,
        cdsEnd: link.cdsEnd,
        strand: link.strand,
                                                                      
                                                                   
                                              
        translationLength: link.translation.length,
      })),
    },
    paperProtocolReview: selectedReview
      ? {
          displayMode: 'linked-tabs',
          protocolPath: selectedReview.protocolPath,
          candidate: selectedReview.candidate,
          selectedStepId: paperReviewState.selectedStep?.stepId ?? null,
          selectedEvidenceIds: selectedReviewStep?.anchors.map((anchor) => anchor.anchorId) ?? [],
          sourceRepresentations: selectedReview.sourceKinds,
          draftRevision: selectedReview.draftRevision,
          draftState: selectedReview.draftState,
          gapCount: selectedReview.gapCount,
          dirty: selectedProtocolTab?.isDirty === true,
        }
      : null,
    targets: buildTargets(params, { tabs, designs, sequences }),
  };
}

export const observeAppStateTool = resultTool({
  description:
    'Read a compact app-owned snapshot of the current project, tabs, designs, and loaded sequences. ' +
    'Use this before and after mutating tool calls to verify that the app actually changed state.',
  inputSchema: observeAppStateSchema as z.ZodTypeAny,
  execute: async (params: ObserveAppStateInput = {}) => toolSuccess(observeAppState(params)),
});

function buildTargets(
  params: ObserveAppStateInput,
  state: {
    tabs: Array<{
      id: string;
      type: string;
      entityId: string;
      label: string;
      active: boolean;
      panelId: string;
    }>;
    designs: Array<{ id: string; name: string; regionCount: number; assemblyState: string }>;
    sequences: Array<{ documentId: string; name: string | null; length: number }>;
  }
) {
  const targets: Record<string, unknown> = {};

  if (params.targetLabel) {
    const matchingTabs = state.tabs.filter((tab) => tab.label === params.targetLabel);
    targets.label = {
      label: params.targetLabel,
      present: matchingTabs.length > 0,
      count: matchingTabs.length,
      active: matchingTabs.some((tab) => tab.active),
      tabs: matchingTabs.map((tab) => ({
        id: tab.id,
        type: tab.type,
        entityId: tab.entityId,
        panelId: tab.panelId,
        active: tab.active,
      })),
    };
  }

  if (params.targetDesignId) {
    const design = state.designs.find((item) => item.id === params.targetDesignId) ?? null;
    targets.design = {
      designId: params.targetDesignId,
      present: design !== null,
      design,
      openTabs: state.tabs
        .filter((tab) => tab.type === 'design' && tab.entityId === params.targetDesignId)
        .map((tab) => ({
          id: tab.id,
          label: tab.label,
          panelId: tab.panelId,
          active: tab.active,
        })),
    };
  }

  if (params.targetSequenceDocumentId) {
    const sequence =
      state.sequences.find((item) => item.documentId === params.targetSequenceDocumentId) ?? null;
    targets.sequence = {
      documentId: params.targetSequenceDocumentId,
      present: sequence !== null,
      sequence,
      openTabs: state.tabs
        .filter(
          (tab) => tab.type === 'sequence' && tab.entityId === params.targetSequenceDocumentId
        )
        .map((tab) => ({
          id: tab.id,
          label: tab.label,
          panelId: tab.panelId,
          active: tab.active,
        })),
    };
  }

  return targets;
}

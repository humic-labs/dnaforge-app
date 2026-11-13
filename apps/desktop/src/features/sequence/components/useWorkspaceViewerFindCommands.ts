import { useCallback } from 'react';
import { COMMAND_IDS, COMMAND_SCOPES, useCommandHandler, useCommandScope } from '../../../commands';
import { useCanvasStore } from '../../canvas/public/store';
import type { UseSequenceSearchReturn } from '@waypoint/workspace-editor';
import type { SequenceViewSurface } from '../view-state/sequence-view-state';
import { workspaceViewerOwnsTabCommands } from './workspace-viewer-entity-keys';

export function useWorkspaceViewerFindCommands({
  surface,
  commandEntityId,
  isGapped,
  search,
}: {
  surface: SequenceViewSurface;
  commandEntityId: string | undefined;
  isGapped: boolean;
  search: Pick<UseSequenceSearchReturn, 'isOpen' | 'mode' | 'openInMode'>;
}) {
  const viewerCommandIsActive = useCanvasStore((state) => {
    const focusedPanel = state.focusedPanelId ? state.panels[state.focusedPanelId] : null;
    const candidatePanels = focusedPanel ? [focusedPanel] : Object.values(state.panels);
    return candidatePanels.some((panel) => {
      const activeTab = panel.tabs.find((tab) => tab.id === panel.activeTabId);
      return workspaceViewerOwnsTabCommands(surface, commandEntityId, activeTab);
    });
  });
  const sequenceCommandIsActive = surface === 'sequence' && viewerCommandIsActive;
  const sequenceScope = useCommandScope(COMMAND_SCOPES.tabSequence, {
    enabled: viewerCommandIsActive,
    claimOnMount: viewerCommandIsActive,
  });

  const sequenceFindEnabled = useCallback(() => !isGapped, [isGapped]);

  useCommandHandler(
    COMMAND_IDS.sequenceFind,
    () => {
      if (isGapped) return false;
      search.openInMode(search.isOpen && search.mode === 'nucleotide' ? 'aminoAcid' : 'nucleotide');
      return true;
    },
    {
      scope: COMMAND_SCOPES.tabSequence,
      active: viewerCommandIsActive,
      enabled: sequenceFindEnabled,
    }
  );

  useCommandHandler(
    COMMAND_IDS.sequenceFindAminoAcid,
    () => {
      if (isGapped) return false;
      search.openInMode('aminoAcid');
      return true;
    },
    {
      scope: COMMAND_SCOPES.tabSequence,
      active: viewerCommandIsActive,
      enabled: sequenceFindEnabled,
    }
  );

  return { viewerCommandIsActive, sequenceCommandIsActive, sequenceScope };
}

'use client';

import { useCallback } from 'react';
import type { ResidueLocation, HighlightGroup } from '../types';
import { useStructure3dStore } from '../store';
import { focusOnResidues } from './useResidueHighlight';
import type { MolstarPlugin } from '../molstar/cache';
import { forgetViewerOverview } from '../molstar/viewerSelection';

interface UseSelectionActionsProps {
  plugin: MolstarPlugin | null | unknown;
  structureId: string;
  selectedResidues: ResidueLocation[] | undefined;
  highlightGroups: HighlightGroup[] | undefined;
}

interface UseSelectionActionsReturn {
  handleClearSelection: () => void;
  handleClearUserSelection: () => void;
  handleResetCamera: () => void;
  handleCenterSelection: () => void;
  createContextCenterHandler: (targetResidue: ResidueLocation | null) => () => void;
}

export function useSelectionActions({
  plugin,
  structureId,
  selectedResidues,
  highlightGroups,
}: UseSelectionActionsProps): UseSelectionActionsReturn {
  const clearSelection = useStructure3dStore((s) => s.clearSelection);
  const clearUserSelection = useStructure3dStore((s) => s.clearUserSelection);

  const handleClearSelection = useCallback(() => {
    clearSelection(structureId);
    const p = plugin as MolstarPlugin | null | undefined;
    p?.managers?.interactivity?.lociSelects?.deselectAll();
  }, [structureId, clearSelection, plugin]);

  const handleClearUserSelection = useCallback(() => {
    clearUserSelection(structureId);
  }, [structureId, clearUserSelection]);

  const handleResetCamera = useCallback(() => {
    const p = plugin as MolstarPlugin | null | undefined;
    if (p) forgetViewerOverview(p);
    p?.managers?.structure?.focus?.clear();

    p?.canvas3d?.requestCameraReset?.({ durationMs: 250 });
  }, [plugin]);

  const handleCenterSelection = useCallback(() => {
    if (selectedResidues?.length) {
      focusOnResidues(plugin as MolstarPlugin | null, selectedResidues);
      return;
    }

    const groups = highlightGroups || [];
    const visibleGroups = groups.filter((g) => g.visible !== false);
    if (visibleGroups.length === 1) {
      const residues: ResidueLocation[] = [];
      for (const sel of visibleGroups[0].selections) {
        for (const [start, end] of sel.ranges) {
          for (let pos = start; pos <= end; pos++) {
            residues.push({
              chain: sel.chain,
              position: pos,
              baseChain: sel.baseChain,
              labelAsymId: sel.labelAsymId,
              authAsymId: sel.authAsymId,
              entityId: sel.entityId,
              operator: sel.operator,
            });
          }
        }
      }
      if (residues.length > 0) {
        focusOnResidues(plugin as MolstarPlugin | null, residues);
      }
    }
  }, [plugin, selectedResidues, highlightGroups]);

  const createContextCenterHandler = useCallback(
    (targetResidue: ResidueLocation | null) => () => {
      if (selectedResidues?.length) {
        focusOnResidues(plugin as MolstarPlugin | null, selectedResidues);
      } else if (targetResidue) {
        focusOnResidues(plugin as MolstarPlugin | null, [targetResidue]);
      }
    },
    [plugin, selectedResidues]
  );

  return {
    handleClearSelection,
    handleClearUserSelection,
    handleResetCamera,
    handleCenterSelection,
    createContextCenterHandler,
  };
}

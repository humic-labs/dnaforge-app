'use client';

import { useCallback } from 'react';
import type {
  ResidueLocation,
  HighlightGroup,
  Structure3dAttrs,
  StructureSelectionGesture,
} from '../types';
import { useStructure3dStore } from '../store';
import { observeWorkflowAction } from '../../../../../lib/workflow-telemetry';

interface UseSavedSelectionEditProps {
  highlightGroups: HighlightGroup[] | undefined;
  structureId: string;
  updateAttrs: (updates: Partial<Structure3dAttrs>) => void;
}

interface UseSavedSelectionEditReturn {
  handleResidueSelect: (
    residue: ResidueLocation,
    gesture: StructureSelectionGesture,
    orderedResidues?: ReadonlyArray<ResidueLocation>
  ) => void;
  handleResiduesSelect: (
    residues: ReadonlyArray<ResidueLocation>,
    gesture: StructureSelectionGesture
  ) => void;
}

export function useSavedSelectionEdit({
  structureId,
}: UseSavedSelectionEditProps): UseSavedSelectionEditReturn {
  const selectResidue = useStructure3dStore((s) => s.selectResidue);
  const selectResidues = useStructure3dStore((s) => s.selectResidues);

  const handleResidueSelect = useCallback(
    (
      residue: ResidueLocation,
      gesture: StructureSelectionGesture,
      orderedResidues?: ReadonlyArray<ResidueLocation>
    ) => {
      selectResidue(structureId, residue, gesture, orderedResidues);
      observeWorkflowAction({
        workflow: 'amino_acid_selection',
        action: 'select',
        selectedCount: 1,
        status: 'selected',
      });
    },
    [selectResidue, structureId]
  );

  const handleResiduesSelect = useCallback(
    (residues: ReadonlyArray<ResidueLocation>, gesture: StructureSelectionGesture) => {
      selectResidues(structureId, residues, gesture);
      observeWorkflowAction({
        workflow: 'amino_acid_selection',
        action: 'select',
        selectedCount: residues.length,
        status: 'selected',
      });
    },
    [selectResidues, structureId]
  );

  return { handleResidueSelect, handleResiduesSelect };
}

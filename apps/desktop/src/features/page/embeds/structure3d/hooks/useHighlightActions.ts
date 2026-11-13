'use client';

import { useCallback, useEffect, useMemo } from 'react';
import type {
  ChainSequence,
  HighlightGroup,
  ResidueLocation,
  SavedSelectionViewRef,
  Structure3dAttrs,
} from '../types';
import { useStructure3dStore } from '../store';
import {
  renameSavedSelectionRef,
  recordSelectionInOpenViews,
  saveStructureSelection,
  saveViewBeforeSelection,
  createViewForSelection,
  molecularViewBinding,
} from '../utils/savedSelectionPersistence';
import { observeWorkflowAction, runWorkflowAction } from '../../../../../lib/workflow-telemetry';
import { focusOnResidues } from './useResidueHighlight';
import type { MolstarPlugin } from '../molstar/cache';

interface UseHighlightActionsProps {
  plugin?: MolstarPlugin | null;
  highlightGroups: HighlightGroup[] | undefined;
  structureId: string;
  interactionKey?: string;
  updateAttrs: (updates: Partial<Structure3dAttrs>) => void;
  attrs: Structure3dAttrs | undefined;
  chains: ReadonlyArray<ChainSequence>;
  workspaceRoot: string | null;
  savedSelectionRefs: ReadonlyArray<SavedSelectionViewRef> | undefined;
  structureViewId?: string;
}

interface UseHighlightActionsReturn {
  handleSaveSelection: (group: HighlightGroup) => Promise<void>;
  handleActivateHighlight: (groupId: string) => void;
  handleTargetHighlight: (groupId: string) => void;
  handleDeleteHighlight: (groupId: string) => void;
  handleRenameHighlight: (groupId: string, newLabel: string) => Promise<void>;
}

export function useHighlightActions({
  plugin,
  highlightGroups,
  structureId,
  interactionKey = structureId,
  updateAttrs,
  attrs,
  chains,
  workspaceRoot,
  savedSelectionRefs,
  structureViewId,
}: UseHighlightActionsProps): UseHighlightActionsReturn {
  const setSelected = useStructure3dStore((s) => s.setSelected);
  const selectionOwner = useMemo(
    () => ({
      status: 'active' as 'active' | 'retired',
      refs: [] as ReadonlyArray<SavedSelectionViewRef>,
    }),
    [structureId, structureViewId, workspaceRoot]
  );
  selectionOwner.refs = savedSelectionRefs ?? [];
  useEffect(() => {
    selectionOwner.status = 'active';
    return () => {
      selectionOwner.status = 'retired';
    };
  }, [selectionOwner]);
  const updateSelectionRefs = useCallback(
    (refs: ReadonlyArray<SavedSelectionViewRef>, changes: Partial<Structure3dAttrs> = {}) => {
      if (selectionOwner.status !== 'active') return;
      selectionOwner.refs = refs;
      updateAttrs({ ...changes, savedSelectionRefs: [...refs] });
    },
    [selectionOwner, updateAttrs]
  );

  const handleSaveSelection = useCallback(
    async (group: HighlightGroup) => {
      if (!attrs) throw new Error('Structure is not ready to save a residue selection');
      const savesView =
        !attrs.molecularDocumentPath &&
        Boolean(structureViewId) &&
        Boolean(attrs.coordinateFilePath);
      const createsView = !attrs.molecularDocumentPath && !savesView && Boolean(workspaceRoot);
      if (!workspaceRoot && !savesView) {
        throw new Error('Save this structure inside a project before saving a residue selection');
      }
      let viewBinding: Partial<Structure3dAttrs> = {};
      const saved = await runWorkflowAction(
        {
          workflow: 'amino_acid_selection',
          action: 'save',
          selectedCount: group.residueLocations?.length,
        },
        async () => {
          const target = savesView
            ? await saveViewBeforeSelection(structureViewId!, attrs)
            : createsView
              ? await createViewForSelection({ workspaceRoot: workspaceRoot!, attrs })
              : { attrs, workspaceRoot: workspaceRoot! };
          if (target.attrs !== attrs) {
            const { molecularDocumentRevision: _revision, ...binding } = molecularViewBinding(
              target.attrs
            );
            viewBinding = binding;
          }
          return saveStructureSelection({
            workspaceRoot: target.workspaceRoot,
            structureId,
            attrs: target.attrs,
            chains,
            group,
          });
        },
        () => ({ status: 'saved', selectedCount: group.residueLocations?.length })
      );
      if (saved.molecularDocumentRevision && saved.molecularDocumentPath) {
        if (
          recordSelectionInOpenViews(
            saved.molecularDocumentPath,
            saved.ref,
            saved.molecularDocumentRevision
          ) > 0
        )
          return;
      }
      if (selectionOwner.status !== 'active') return;
      updateSelectionRefs(
        [
          ...selectionOwner.refs.filter((ref) => ref.selectionId !== saved.ref.selectionId),
          saved.ref,
        ],
        {
          ...viewBinding,
          ...(saved.structureArtifactRef
            ? { structureArtifactRef: saved.structureArtifactRef }
            : {}),
          ...(saved.molecularDocumentRevision
            ? { molecularDocumentRevision: saved.molecularDocumentRevision }
            : {}),
        }
      );
    },
    [
      workspaceRoot,
      attrs,
      structureId,
      structureViewId,
      chains,
      selectionOwner,
      updateSelectionRefs,
    ]
  );

  const handleActivateHighlight = useCallback(
    (groupId: string) => {
      const targetGroup = (highlightGroups ?? []).find((group) => group.id === groupId);
      if (!targetGroup) return;
      const residues = targetGroup.residueLocations?.length
        ? [...targetGroup.residueLocations]
        : residueLocationsForHighlightGroup(targetGroup, chains);
      if (residues.length === 0) return;
      setSelected(interactionKey, residues, null);
      observeWorkflowAction({
        workflow: 'amino_acid_selection',
        action: 'view',
        selectedCount: residues.length,
        status: 'viewed',
      });
    },
    [chains, highlightGroups, interactionKey, setSelected]
  );

  const handleDeleteHighlight = useCallback(
    (groupId: string) => {
      const groups = highlightGroups || [];
      updateSelectionRefs(
        selectionOwner.refs.filter((ref) => ref.selectionId !== groupId),
        {
          highlightGroups: groups.filter(
            (g) => g.id !== groupId && !selectionOwner.refs.some((ref) => ref.selectionId === g.id)
          ),
        }
      );
      observeWorkflowAction({
        workflow: 'amino_acid_selection',
        action: 'delete',
        affectedCount: 1,
        status: 'deleted',
      });
    },
    [highlightGroups, selectionOwner, updateSelectionRefs]
  );

  const handleTargetHighlight = useCallback(
    (groupId: string) => {
      const group = (highlightGroups ?? []).find((candidate) => candidate.id === groupId);
      if (!group || !plugin) return;
      const residues = group.residueLocations?.length
        ? [...group.residueLocations]
        : residueLocationsForHighlightGroup(group, chains);
      if (residues.length) focusOnResidues(plugin, residues);
    },
    [plugin, highlightGroups, chains]
  );

  const handleRenameHighlight = useCallback(
    async (groupId: string, newLabel: string) => {
      await runWorkflowAction(
        {
          workflow: 'amino_acid_selection',
          action: 'update',
        },
        async () => {
          const groups = highlightGroups || [];
          const durableRef = selectionOwner.refs.find((ref) => ref.selectionId === groupId);
          if (durableRef) {
            if (!workspaceRoot) throw new Error('Saved selection project is unavailable');
            const renamed = await renameSavedSelectionRef(workspaceRoot, durableRef, newLabel);
            if (
              selectionOwner.status !== 'active' ||
              !selectionOwner.refs.some((ref) => ref.selectionId === groupId)
            )
              return;
            updateSelectionRefs(
              selectionOwner.refs.map((ref) => (ref.selectionId === groupId ? renamed.ref : ref)),
              {
                ...(renamed.molecularDocumentRevision
                  ? { molecularDocumentRevision: renamed.molecularDocumentRevision }
                  : {}),
              }
            );
            return;
          }
          const updated = groups.map((g) => (g.id === groupId ? { ...g, label: newLabel } : g));
          updateAttrs({ highlightGroups: updated });
        },
        () => ({ status: 'updated', affectedCount: 1 })
      );
    },
    [highlightGroups, selectionOwner, workspaceRoot, updateAttrs, updateSelectionRefs]
  );

  return {
    handleSaveSelection,
    handleActivateHighlight,
    handleTargetHighlight,
    handleDeleteHighlight,
    handleRenameHighlight,
  };
}

export function residueLocationsForHighlightGroup(
  group: HighlightGroup,
  chains: ReadonlyArray<ChainSequence>
): ResidueLocation[] {
  const result: ResidueLocation[] = [];
  for (const selection of group.selections) {
    if (selection.compId) {
      for (const [start, end] of selection.ranges) {
        for (let position = start; position <= end; position += 1) {
          result.push({
            chain: selection.chain,
            position,
            compId: selection.compId,
            baseChain: selection.baseChain,
            labelAsymId: selection.labelAsymId,
            authAsymId: selection.authAsymId,
            entityId: selection.entityId,
            operator: selection.operator,
          });
        }
      }
      continue;
    }

    const chain = chains.find(
      (candidate) =>
        candidate.chainId === selection.chain &&
        optionalIdentityMatches(candidate.baseChain, selection.baseChain) &&
        optionalIdentityMatches(candidate.labelAsymId, selection.labelAsymId) &&
        optionalIdentityMatches(candidate.authAsymId, selection.authAsymId) &&
        optionalIdentityMatches(candidate.entityId, selection.entityId) &&
        optionalIdentityMatches(candidate.operator, selection.operator)
    );
    if (!chain) continue;

    const selectedPositions = new Set<number>();
    for (const [start, end] of selection.ranges) {
      for (const residue of chain.residues) {
        if (residue.position >= start && residue.position <= end) {
          selectedPositions.add(residue.position);
        }
      }
    }
    for (const residue of chain.residues) {
      if (!selectedPositions.has(residue.position)) continue;
      result.push({
        chain: chain.chainId,
        position: residue.position,
        labelCompId: residue.name3,
        ...(residue.labelSeqId !== undefined ? { labelSeqId: residue.labelSeqId } : {}),
        ...(chain.baseChain ? { baseChain: chain.baseChain } : {}),
        ...(chain.labelAsymId ? { labelAsymId: chain.labelAsymId } : {}),
        ...(chain.authAsymId ? { authAsymId: chain.authAsymId } : {}),
        ...(chain.entityId ? { entityId: chain.entityId } : {}),
        ...(chain.operator ? { operator: chain.operator } : {}),
      });
    }
  }
  return result;
}

function optionalIdentityMatches(actual: string | undefined, expected: string | undefined) {
  return expected === undefined || actual === expected;
}

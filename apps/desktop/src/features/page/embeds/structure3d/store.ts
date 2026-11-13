'use client';

import { create } from 'zustand';
import { retainMolecularDocumentOwner } from '../../../../shared/molecular-document-owner';
import {
  AGENT_HIGHLIGHT_GROUP_ID_PREFIX,
  type Structure3dAttrs,
  type ResidueLocation,
  type ResidueInteractionState,
  type StructureSelectionGesture,
} from './types';
import { useStructureLinkRegistry } from '../../../structure-drawer/public/state/use-structure-link-registry';
import { useStructureResidueSessionRegistry } from '../../../structure-drawer/public/state/structure-residue-session-registry';

export const DEFAULT_INTERACTION_STATE: ResidueInteractionState = {
  hovered: null,
  selected: [],
} as const;

interface ExpandedStructure {
  data: Structure3dAttrs;
  label: string;
  onUpdate?: (attrs: Structure3dAttrs) => void;
}

interface Structure3dStore {
  expandedStructures: Record<string, ExpandedStructure>;
  registerStructure: (
    id: string,
    data: Structure3dAttrs,
    label: string,
    callbacks?: { onUpdate?: (attrs: Structure3dAttrs) => void }
  ) => void;
  updateStructureData: (id: string, data: Structure3dAttrs) => void;
  unregisterStructure: (id: string) => void;

  interactionState: Record<string, ResidueInteractionState>;
  selectionAnchor: Record<string, ResidueLocation | null>;
  selectionRangeBase: Record<string, ResidueLocation[]>;
  setHovered: (structureId: string, residue: ResidueLocation | null) => void;
  setSelected: (
    structureId: string,
    residues: ReadonlyArray<ResidueLocation>,
    anchor?: ResidueLocation | null
  ) => void;
  selectResidue: (
    structureId: string,
    residue: ResidueLocation,
    gesture?: StructureSelectionGesture,
    orderedResidues?: ReadonlyArray<ResidueLocation>
  ) => void;
  selectResidues: (
    structureId: string,
    residues: ReadonlyArray<ResidueLocation>,
    gesture?: StructureSelectionGesture
  ) => void;
  clearSelection: (structureId: string) => void;
  clearUserSelection: (structureId: string) => void;
  resetInteractionState: (structureId: string) => void;
  clearAgentHighlightGroups: (structureId?: string) => void;
}

function isSameResidue(a: ResidueLocation | null, b: ResidueLocation | null): boolean {
  if (!a || !b) return a === b;
  if (a.chain !== b.chain || a.position !== b.position) return false;
  return (
    a.compId === b.compId &&
    a.baseChain === b.baseChain &&
    a.labelAsymId === b.labelAsymId &&
    a.authAsymId === b.authAsymId &&
    a.entityId === b.entityId &&
    a.labelSeqId === b.labelSeqId &&
    a.operator === b.operator &&
    a.structureRef === b.structureRef &&
    a.instanceId === b.instanceId
  );
}

function residueSelectionKey(residue: ResidueLocation): string {
  return [
    residue.chain,
    residue.position,
    residue.compId ?? '',
    residue.baseChain ?? '',
    residue.labelAsymId ?? '',
    residue.authAsymId ?? '',
    residue.entityId ?? '',
    residue.labelSeqId ?? '',
    residue.operator ?? '',
    residue.structureRef ?? '',
    residue.instanceId ?? '',
  ].join('\u0000');
}

function isSameResidueList(
  left: ReadonlyArray<ResidueLocation>,
  right: ReadonlyArray<ResidueLocation>
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((residue, index) => isSameResidue(residue, right[index]));
}

function mergeExactResidues(
  ...groups: ReadonlyArray<ReadonlyArray<ResidueLocation>>
): ResidueLocation[] {
  const seen = new Set<string>();
  const merged: ResidueLocation[] = [];
  for (const group of groups) {
    for (const residue of group) {
      const key = residueSelectionKey(residue);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(residue);
    }
  }
  return merged;
}

function isSameStructureRegistration(
  existing: ExpandedStructure | undefined,
  data: Structure3dAttrs,
  label: string,
  callbacks?: { onUpdate?: (attrs: Structure3dAttrs) => void }
): boolean {
  if (!existing) return false;
  return (
    existing.label === label &&
    existing.onUpdate === callbacks?.onUpdate &&
    sameStructureAttrsForRegistration(existing.data, data)
  );
}

function sameStructureAttrsForRegistration(
  left: Structure3dAttrs,
  right: Structure3dAttrs
): boolean {
  if (left === right) return true;
  const { structureData: leftStructureData, ...leftComparable } = left;
  const { structureData: rightStructureData, ...rightComparable } = right;
  if (leftStructureData !== rightStructureData) return false;
  try {
    return JSON.stringify(leftComparable) === JSON.stringify(rightComparable);
  } catch {
    return false;
  }
}

function getDefaultInteractionState(): ResidueInteractionState {
  return { hovered: null, selected: [] };
}

export const useStructure3dStore = create<Structure3dStore>((set, get) => ({
  expandedStructures: {},
  interactionState: {},
  selectionAnchor: {},
  selectionRangeBase: {},

  registerStructure: (id, data, label, callbacks) => {
    const original = data;
    data = retainMolecularDocumentOwner(data, get().expandedStructures[id]?.data);
    set((state) => {
      if (isSameStructureRegistration(state.expandedStructures[id], data, label, callbacks)) {
        return state;
      }
      return {
        expandedStructures: {
          ...state.expandedStructures,
          [id]: { data, label, onUpdate: callbacks?.onUpdate },
        },
      };
    });
    if (original !== data) callbacks?.onUpdate?.(data);
  },

  updateStructureData: (id, data) => {
    const { expandedStructures } = get();
    const structure = expandedStructures[id];
    if (!structure) return;
    data = retainMolecularDocumentOwner(data, structure.data);

    set((state) => ({
      expandedStructures: {
        ...state.expandedStructures,
        [id]: { ...structure, data },
      },
    }));

    structure.onUpdate?.(data);
  },

  unregisterStructure: (id) => {
    useStructureLinkRegistry.getState().unregisterLink(id);
    useStructureResidueSessionRegistry.getState().unregisterSession(id);
    set((state) => {
      const { [id]: _, ...rest } = state.expandedStructures;
      const { [id]: __, ...restInteraction } = state.interactionState;
      const { [id]: ___, ...restSelectionAnchor } = state.selectionAnchor;
      const { [id]: ____, ...restSelectionRangeBase } = state.selectionRangeBase;
      return {
        expandedStructures: rest,
        interactionState: restInteraction,
        selectionAnchor: restSelectionAnchor,
        selectionRangeBase: restSelectionRangeBase,
      };
    });
  },

  setHovered: (structureId, residue) => {
    set((state) => {
      const current = state.interactionState[structureId] ?? getDefaultInteractionState();
      if (isSameResidue(current.hovered, residue)) return state;
      return {
        interactionState: {
          ...state.interactionState,
          [structureId]: { ...current, hovered: residue },
        },
      };
    });
  },

  setSelected: (structureId, residues, anchor) => {
    get().clearAgentHighlightGroups(structureId);
    set((state) => {
      const current = state.interactionState[structureId] ?? getDefaultInteractionState();
      const currentAnchor = state.selectionAnchor[structureId] ?? null;
      const currentRangeBase = state.selectionRangeBase[structureId] ?? [];
      const nextAnchor = anchor === undefined ? currentAnchor : anchor;
      const nextRangeBase =
        residues.length === 0 ? [] : anchor === undefined ? currentRangeBase : [];
      if (
        isSameResidueList(current.selected, residues) &&
        isSameResidue(currentAnchor, nextAnchor) &&
        isSameResidueList(currentRangeBase, nextRangeBase)
      ) {
        return state;
      }
      return {
        interactionState: {
          ...state.interactionState,
          [structureId]: { ...current, selected: [...residues] },
        },
        selectionAnchor: {
          ...state.selectionAnchor,
          [structureId]: nextAnchor,
        },
        selectionRangeBase: {
          ...state.selectionRangeBase,
          [structureId]: nextRangeBase,
        },
      };
    });
  },

  selectResidue: (structureId, residue, gesture = 'replace', orderedResidues = []) => {
    get().clearAgentHighlightGroups(structureId);
    set((state) => {
      const current = state.interactionState[structureId] ?? getDefaultInteractionState();
      const currentAnchor = state.selectionAnchor[structureId] ?? null;
      const currentRangeBase = state.selectionRangeBase[structureId] ?? [];
      let newSelected: ResidueLocation[];
      let newAnchor: ResidueLocation | null;
      let newRangeBase: ResidueLocation[];

      if (gesture === 'range') {
        const anchorIndex = currentAnchor
          ? orderedResidues.findIndex((candidate) => isSameResidue(candidate, currentAnchor))
          : -1;
        const targetIndex = orderedResidues.findIndex((candidate) =>
          isSameResidue(candidate, residue)
        );

        if (currentAnchor && anchorIndex >= 0 && targetIndex >= 0) {
          const startIndex = Math.min(anchorIndex, targetIndex);
          const endIndex = Math.max(anchorIndex, targetIndex);
          const activeRange = orderedResidues.slice(startIndex, endIndex + 1);
          newSelected = mergeExactResidues(currentRangeBase, activeRange);
          newAnchor = currentAnchor;
          newRangeBase = currentRangeBase;
        } else {
          newSelected = [residue];
          newAnchor = residue;
          newRangeBase = [];
        }
      } else if (gesture === 'toggle') {
        const targetKey = residueSelectionKey(residue);
        const alreadySelected = current.selected.some(
          (candidate) => residueSelectionKey(candidate) === targetKey
        );
        newSelected = alreadySelected
          ? current.selected.filter((candidate) => residueSelectionKey(candidate) !== targetKey)
          : [...current.selected, residue];
        newAnchor = residue;
        newRangeBase = newSelected.filter(
          (candidate) => residueSelectionKey(candidate) !== targetKey
        );
      } else {
        newSelected = [residue];
        newAnchor = residue;
        newRangeBase = [];
      }

      if (
        isSameResidueList(current.selected, newSelected) &&
        isSameResidue(currentAnchor, newAnchor) &&
        isSameResidueList(currentRangeBase, newRangeBase)
      ) {
        return state;
      }

      return {
        interactionState: {
          ...state.interactionState,
          [structureId]: { ...current, selected: newSelected },
        },
        selectionAnchor: {
          ...state.selectionAnchor,
          [structureId]: newAnchor,
        },
        selectionRangeBase: {
          ...state.selectionRangeBase,
          [structureId]: newRangeBase,
        },
      };
    });
  },

  selectResidues: (structureId, residues, gesture = 'replace') => {
    get().clearAgentHighlightGroups(structureId);
    set((state) => {
      const current = state.interactionState[structureId] ?? getDefaultInteractionState();
      const currentRangeBase = state.selectionRangeBase[structureId] ?? [];
      const seenTargetKeys = new Set<string>();
      const targets = residues.filter((residue) => {
        const key = residueSelectionKey(residue);
        if (seenTargetKeys.has(key)) return false;
        seenTargetKeys.add(key);
        return true;
      });
      const currentKeys = new Set(current.selected.map(residueSelectionKey));
      let newSelected: ResidueLocation[];

      const allTargetsSelected =
        targets.length > 0 &&
        targets.every((target) => currentKeys.has(residueSelectionKey(target)));

      if (gesture === 'replace') {
        newSelected = [...targets];
      } else if (gesture === 'range') {
        newSelected = mergeExactResidues(currentRangeBase, targets);
      } else if (allTargetsSelected) {
        newSelected = current.selected.filter(
          (item) => !seenTargetKeys.has(residueSelectionKey(item))
        );
      } else {
        newSelected = [...current.selected];
        for (const target of targets) {
          const key = residueSelectionKey(target);
          if (!currentKeys.has(key)) {
            newSelected.push(target);
            currentKeys.add(key);
          }
        }
      }

      const currentAnchor = state.selectionAnchor[structureId] ?? null;
      const targetAnchor = targets[targets.length - 1] ?? null;
      const newAnchor = gesture === 'range' ? (currentAnchor ?? targetAnchor) : targetAnchor;
      const anchorKey = newAnchor ? residueSelectionKey(newAnchor) : null;
      const newRangeBase =
        gesture === 'range'
          ? currentRangeBase
          : gesture === 'toggle' && anchorKey
            ? newSelected.filter((candidate) => residueSelectionKey(candidate) !== anchorKey)
            : [];
      if (
        isSameResidueList(current.selected, newSelected) &&
        isSameResidue(currentAnchor, newAnchor) &&
        isSameResidueList(currentRangeBase, newRangeBase)
      ) {
        return state;
      }

      return {
        interactionState: {
          ...state.interactionState,
          [structureId]: { ...current, selected: newSelected },
        },
        selectionAnchor: {
          ...state.selectionAnchor,
          [structureId]: newAnchor,
        },
        selectionRangeBase: {
          ...state.selectionRangeBase,
          [structureId]: newRangeBase,
        },
      };
    });
  },

  clearSelection: (structureId) => {
    get().clearAgentHighlightGroups(structureId);
    get().clearUserSelection(structureId);
  },

  clearUserSelection: (structureId) => {
    set((state) => {
      const current = state.interactionState[structureId];
      const currentAnchor = state.selectionAnchor[structureId] ?? null;
      const currentRangeBase = state.selectionRangeBase[structureId] ?? [];
      if (
        (!current || current.selected.length === 0) &&
        currentAnchor === null &&
        currentRangeBase.length === 0
      ) {
        return state;
      }
      return {
        interactionState: {
          ...state.interactionState,
          [structureId]: { ...(current ?? getDefaultInteractionState()), selected: [] },
        },
        selectionAnchor: {
          ...state.selectionAnchor,
          [structureId]: null,
        },
        selectionRangeBase: {
          ...state.selectionRangeBase,
          [structureId]: [],
        },
      };
    });
  },

  resetInteractionState: (structureId) => {
    get().clearAgentHighlightGroups(structureId);
    set((state) => ({
      interactionState: {
        ...state.interactionState,
        [structureId]: getDefaultInteractionState(),
      },
      selectionAnchor: {
        ...state.selectionAnchor,
        [structureId]: null,
      },
      selectionRangeBase: {
        ...state.selectionRangeBase,
        [structureId]: [],
      },
    }));
  },

  clearAgentHighlightGroups: (structureId) => {
    const { expandedStructures, updateStructureData } = get();
    const entries = structureId
      ? ([[structureId, expandedStructures[structureId]]] as const)
      : Object.entries(expandedStructures);
    for (const [id, entry] of entries) {
      if (!entry) continue;
      const current = entry.data.highlightGroups ?? [];
      const next = current.filter(
        (group) =>
          group.renderMode !== 'selection' && !group.id.startsWith(AGENT_HIGHLIGHT_GROUP_ID_PREFIX)
      );
      if (next.length === current.length) continue;
      updateStructureData(id, { ...entry.data, highlightGroups: next });
    }
  },
}));

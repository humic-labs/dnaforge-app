import { OrderedSet } from 'molstar/lib/mol-data/int';
import { StructureElement } from 'molstar/lib/mol-model/structure';
import { extractEffectiveChainInfo, WATER_RESIDUES } from './molstarChainUtils';

export interface MolstarSelectedResidueReadbackEntry {
  chain: string;
  position: number;
  labelSeqId: number | null;
  compId: string;
  selectedAtomCount: number;
  totalResidueAtomCount: number;
  baseChain?: string;
  labelAsymId?: string;
  authAsymId?: string;
  entityId?: string;
  operator?: string;
  instanceId?: string;
}

export interface MolstarSelectionReadback {
  residues: MolstarSelectedResidueReadbackEntry[];
  elementCount: number | null;
  statsLabel: string | null;
}

type LociSelectionElement = {
  unit?: {
    elements?: ArrayLike<number>;
    residueIndex?: ArrayLike<number>;
    chainIndex?: ArrayLike<number>;
    model?: {
      atomicHierarchy?: {
        atoms?: { label_comp_id?: { value: (idx: number) => unknown } };
        residues?: {
          auth_seq_id?: { value: (idx: number) => unknown };
          label_seq_id?: { value: (idx: number) => unknown };
        };
        chains?: unknown;
      };
    };
  };
  indices?: unknown;
};

type SelectionEntry = {
  selection?: {
    elements?: readonly unknown[];
  };
};

type SelectionManagerLike = {
  entries?: { forEach: (callback: (entry: SelectionEntry) => void) => void };
  elementCount?: () => number;
  stats?: { label?: string };
};

type MolstarPluginSelectionReadbackLike = {
  managers?: {
    structure?: {
      selection?: SelectionManagerLike;
    };
  };
};

export function extractMolstarSelectionReadback(
  plugin: MolstarPluginSelectionReadbackLike
): MolstarSelectionReadback {
  const selectionManager = plugin.managers?.structure?.selection;
  const residues = new Map<string, MolstarSelectedResidueReadbackEntry>();
  selectionManager?.entries?.forEach((entry) => {
    for (const element of entry.selection?.elements ?? []) {
      addLociElementResidues(residues, element as LociSelectionElement);
    }
  });

  return {
    residues: [...residues.values()].sort(compareSelectedResidues),
    elementCount:
      typeof selectionManager?.elementCount === 'function' ? selectionManager.elementCount() : null,
    statsLabel: selectionManager?.stats?.label ?? null,
  };
}

export function readMolstarLociResidues(
  loci: StructureElement.Loci
): MolstarSelectedResidueReadbackEntry[] {
  const residues = new Map<string, MolstarSelectedResidueReadbackEntry>();
  for (const element of loci.elements)
    addLociElementResidues(residues, element as LociSelectionElement);
  return [...residues.values()].sort(compareSelectedResidues);
}

function addLociElementResidues(
  residues: Map<string, MolstarSelectedResidueReadbackEntry>,
  lociElement: LociSelectionElement
): void {
  const unit = lociElement.unit;
  const hierarchy = unit?.model?.atomicHierarchy;
  if (!unit?.elements || !unit.residueIndex || !unit.chainIndex || !hierarchy) return;
  if (!lociElement.indices) return;
  const unitElements = unit.elements;
  const unitResidueIndex = unit.residueIndex;
  const unitChainIndex = unit.chainIndex;

  forEachSelectedUnitElementIndex(lociElement.indices, (elementIndex) => {
    const atomIndex = unitElements[elementIndex];
    if (typeof atomIndex !== 'number') return;
    const residueIndex = unitResidueIndex[atomIndex];
    const chainIndex = unitChainIndex[atomIndex];
    if (typeof residueIndex !== 'number' || typeof chainIndex !== 'number') return;
    const chainInfo = extractEffectiveChainInfo(
      unit as never,
      hierarchy.chains as never,
      chainIndex
    );
    if (!chainInfo) return;
    const position = hierarchy.residues?.auth_seq_id?.value(residueIndex);
    if (typeof position !== 'number' || !Number.isFinite(position)) return;
    const labelSeqValue = hierarchy.residues?.label_seq_id?.value(residueIndex);
    const labelSeqId =
      typeof labelSeqValue === 'number' && Number.isFinite(labelSeqValue) ? labelSeqValue : null;
    const compId = hierarchy.atoms?.label_comp_id?.value(atomIndex);
    if (typeof compId !== 'string' || WATER_RESIDUES.has(compId)) return;
    const key = [
      chainInfo.effectiveChainId,
      chainInfo.labelAsymId ?? '',
      chainInfo.authAsymId ?? '',
      chainInfo.entityId ?? '',
      chainInfo.operator ?? '',
      chainInfo.instanceId ?? '',
      position,
      compId,
    ].join('\u0000');
    const existing = residues.get(key);
    if (existing) {
      existing.selectedAtomCount += 1;
      return;
    }
    residues.set(key, {
      chain: chainInfo.effectiveChainId,
      position,
      labelSeqId,
      compId,
      selectedAtomCount: 1,
      totalResidueAtomCount: countResidueAtoms(unitElements, unitResidueIndex, residueIndex),
      ...(chainInfo.baseChain ? { baseChain: chainInfo.baseChain } : {}),
      ...(chainInfo.labelAsymId ? { labelAsymId: chainInfo.labelAsymId } : {}),
      ...(chainInfo.authAsymId ? { authAsymId: chainInfo.authAsymId } : {}),
      ...(chainInfo.entityId ? { entityId: chainInfo.entityId } : {}),
      ...(chainInfo.operator ? { operator: chainInfo.operator } : {}),
      ...(chainInfo.instanceId ? { instanceId: chainInfo.instanceId } : {}),
    });
  });
}

function forEachSelectedUnitElementIndex(
  indices: unknown,
  callback: (elementIndex: number) => void
): void {
  if (Array.isArray(indices)) {
    for (const elementIndex of indices) {
      if (typeof elementIndex === 'number') callback(elementIndex);
    }
    return;
  }
  OrderedSet.forEach(indices as never, callback);
}

function countResidueAtoms(
  unitElements: ArrayLike<number>,
  unitResidueIndex: ArrayLike<number>,
  residueIndex: number
): number {
  let total = 0;
  for (let unitElementIndex = 0; unitElementIndex < unitElements.length; unitElementIndex += 1) {
    const unitAtomIndex = unitElements[unitElementIndex];
    if (unitResidueIndex[unitAtomIndex] === residueIndex) total += 1;
  }
  return total;
}

function compareSelectedResidues(
  left: MolstarSelectedResidueReadbackEntry,
  right: MolstarSelectedResidueReadbackEntry
): number {
  return (
    (left.authAsymId ?? '').localeCompare(right.authAsymId ?? '') ||
    (left.labelAsymId ?? '').localeCompare(right.labelAsymId ?? '') ||
    left.position - right.position ||
    (left.labelSeqId ?? Number.MAX_SAFE_INTEGER) - (right.labelSeqId ?? Number.MAX_SAFE_INTEGER)
  );
}

import { Structure, Unit } from 'molstar/lib/mol-model/structure';
import { StructureSubsetBuilder } from 'molstar/lib/mol-model/structure/structure/util/subset-builder';
import type { MVSData } from 'molstar/lib/extensions/mvs/mvs-data';
import type { MolecularProfileNode } from './nucleotidePresentationSettings';
import { molecularAtomSelector } from './molecularConnections';
import { componentPropsFromSelector } from 'molstar/lib/extensions/mvs/load-helpers';
import { substructureFromSelector } from 'molstar/lib/extensions/mvs/components/selector';

export type PrimaryConformerReceipt = {
  contract: 'primary-deposited-conformer-v1';
  mode: 'primary' | 'comparison';
  reason?: string;
  selectedAtomCount: number;
  excludedAtomCount: number;
  alternatives: Array<{
    modelId: string;
    instanceId: string;
    labelAsymId: string;
    authSeqId: number;
    insertionCode: string;
    selectedAltId: string | null;
    choices: Array<{ altId: string; meanOccupancy: number; atomCount: number }>;
  }>;
};

const atomicRepresentation = (node: MolecularProfileNode) =>
  node.kind === 'representation' &&
  ['ball_and_stick', 'spacefill', 'line'].includes(String(node.params?.type));

function containsAtomicRepresentation(node: MolecularProfileNode): boolean {
  return atomicRepresentation(node) || (node.children ?? []).some(containsAtomicRepresentation);
}

export function primaryMolecularConformer(
  source: Structure,
  root: MolecularProfileNode
): { structure: Structure; receipt: PrimaryConformerReceipt } {
  const comparison = root.custom?.dnaforge_conformer_comparison as { reason?: unknown } | undefined;
  if (
    comparison !== undefined &&
    (typeof comparison?.reason !== 'string' || !comparison.reason.trim())
  )
    throw Object.assign(
      new Error(
        'A deposited-conformer comparison requires a scientific reason in custom.dnaforge_conformer_comparison.reason.'
      ),
      {
        code: 'MVS_CONFORMER_COMPARISON_REASON_REQUIRED',
      }
    );
  const receipt: PrimaryConformerReceipt = {
    contract: 'primary-deposited-conformer-v1',
    mode: comparison ? 'comparison' : 'primary',
    ...(comparison ? { reason: String(comparison.reason).trim() } : {}),
    selectedAtomCount: source.elementCount,
    excludedAtomCount: 0,
    alternatives: [],
  };
  const subset = new StructureSubsetBuilder(source, true);
  const shared = (id: string) => !id || id === '.' || id === '?';
  for (const unit of source.units) {
    if (!Unit.isAtomic(unit)) {
      subset.setUnit(unit.id, unit.elements);
      continue;
    }
    const h = unit.model.atomicHierarchy;
    const residues = new Map<number, Map<string, { total: number; count: number }>>();
    for (let i = 0; i < unit.elements.length; i++) {
      const atom = unit.elements[i];
      const altId = h.atoms.label_alt_id.value(atom);
      if (shared(altId)) continue;
      const residue = unit.residueIndex[atom];
      const alternatives = residues.get(residue) ?? new Map();
      const alternative = alternatives.get(altId) ?? { total: 0, count: 0 };
      const occupancy = unit.model.atomicConformation.occupancy.value(atom);
      alternative.total += Number.isFinite(occupancy) ? occupancy : 0;
      alternative.count++;
      alternatives.set(altId, alternative);
      residues.set(residue, alternatives);
    }
    const chosen = new Map<number, string>();
    for (const [residue, alternatives] of residues) {
      const choices = [...alternatives]
        .map(([altId, score]) => ({
          altId,
          meanOccupancy: score.total / score.count,
          atomCount: score.count,
        }))
        .sort((a, b) => b.meanOccupancy - a.meanOccupancy || a.altId.localeCompare(b.altId));
      chosen.set(residue, choices[0].altId);
      const atom = h.residueAtomSegments.offsets[residue];
      receipt.alternatives.push({
        modelId: unit.model.id,
        instanceId: unit.conformation.operator.instanceId,
        labelAsymId: h.chains.label_asym_id.value(unit.chainIndex[atom]),
        authSeqId: h.residues.auth_seq_id.value(residue),
        insertionCode: h.residues.pdbx_PDB_ins_code.value(residue),
        selectedAltId: comparison ? null : choices[0].altId,
        choices,
      });
    }
    for (let i = 0; i < unit.elements.length; i++) {
      const atom = unit.elements[i];
      const altId = h.atoms.label_alt_id.value(atom);
      if (comparison || shared(altId) || chosen.get(unit.residueIndex[atom]) === altId)
        subset.addToUnit(unit.id, atom);
      else receipt.excludedAtomCount++;
    }
  }
  receipt.selectedAtomCount -= receipt.excludedAtomCount;
  return {
    structure: receipt.excludedAtomCount ? subset.getStructure() : source,
    receipt,
  };
}

export function constructPrimaryConformerDisplays(
  document: MVSData,
  sourceFor: (node: MolecularProfileNode, index: number) => Structure | undefined
): MVSData {
  document = structuredClone(document);
  const roots =
    document.kind === 'multiple' ? document.snapshots.map((s) => s.root) : [document.root];
  for (const [index, root] of roots.entries()) {
    const receipts: Array<PrimaryConformerReceipt & { structureRef?: string }> = [];
    const visit = (node: MolecularProfileNode, source?: Structure, primary?: Structure) => {
      if (node.kind === 'structure') {
        source = sourceFor(node, index);
        if (!source && containsAtomicRepresentation(node))
          throw Object.assign(
            new Error(
              'Atomic construction requires a loaded coordinate source. Load this pinned structure in a cartoon-only staging step first.'
            ),
            { code: 'MVS_CONFORMER_SOURCE_NOT_LOADED' }
          );
        const selected = source ? primaryMolecularConformer(source, root) : undefined;
        primary = selected?.structure;
        if (selected) receipts.push({ structureRef: node.ref, ...selected.receipt });
      }
      if (
        source &&
        primary &&
        node.kind === 'component' &&
        node.children?.some(atomicRepresentation)
      ) {
        const prior = node.custom?.dnaforge_primary_conformer_selector as
          | { original: unknown; resolved: unknown }
          | undefined;
        if (primary === source && !prior) {
          for (const child of node.children ?? []) visit(child, source, primary);
          return;
        }
        const original =
          prior && JSON.stringify(prior.resolved) === JSON.stringify(node.params?.selector)
            ? prior.original
            : node.params?.selector;
        const props = componentPropsFromSelector(
          original as Parameters<typeof componentPropsFromSelector>[0]
        );
        const selected = substructureFromSelector(primary, props);
        const originalCount = substructureFromSelector(source, props).elementCount;
        if (!selected.elementCount && originalCount)
          throw Object.assign(
            new Error(
              'This atomic selection contains only nonprimary deposited alternatives. A scientific comparison reason is required to display them.'
            ),
            {
              code: 'MVS_ALTERNATE_CONFORMER_SELECTION',
            }
          );
        const resolved =
          selected.elementCount === originalCount
            ? original
            : molecularAtomSelector(selected, source);
        node.params = { ...node.params, selector: resolved };
        if (JSON.stringify(resolved) !== JSON.stringify(original))
          node.custom = {
            ...node.custom,
            dnaforge_primary_conformer_selector: { original, resolved },
          };
        else if (node.custom) delete node.custom.dnaforge_primary_conformer_selector;
      }
      for (const child of node.children ?? []) visit(child, source, primary);
    };
    visit(root);
    root.custom = { ...root.custom, dnaforge_primary_conformers: receipts };
  }
  return document;
}

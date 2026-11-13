import { Unit, Structure } from 'molstar/lib/mol-model/structure';
import { isNucleic, NucleicBackboneAtoms } from 'molstar/lib/mol-model/structure/model/types';
import { StructureSubsetBuilder } from 'molstar/lib/mol-model/structure/structure/util/subset-builder';
import { componentPropsFromSelector } from 'molstar/lib/extensions/mvs/load-helpers';
import { substructureFromSelector } from 'molstar/lib/extensions/mvs/components/selector';

export type NucleotideAtomicMode = 'base-only' | 'full';

export function filterNucleotideAtomicStructure(
  structure: Structure,
  mode: NucleotideAtomicMode,
  keepAtoms: readonly unknown[] = []
): Structure {
  if (mode !== 'base-only') return structure;
  const keptResidues = new Map<number, Set<number>>();
  if (keepAtoms.length) {
    const endpoints = substructureFromSelector(
      structure,
      componentPropsFromSelector(keepAtoms as Parameters<typeof componentPropsFromSelector>[0])
    );
    for (const unit of endpoints.units) {
      if (!Unit.isAtomic(unit)) continue;
      keptResidues.set(
        unit.id,
        new Set(
          Array.from(
            unit.elements,
            (atom) => unit.model.atomicHierarchy.residueAtomSegments.index[atom]
          )
        )
      );
    }
  }
  const subset = new StructureSubsetBuilder(structure, true);
  for (const unit of structure.units) {
    subset.beginUnit(unit.id);
    for (let i = 0; i < unit.elements.length; i++) {
      const atom = unit.elements[i];
      if (Unit.isAtomic(unit)) {
        const residue = unit.model.atomicHierarchy.residueAtomSegments.index[atom];
        if (isNucleic(unit.model.atomicHierarchy.derived.residue.moleculeType[residue])) {
          const name = unit.model.atomicHierarchy.atoms.label_atom_id.value(atom);
          if (
            (NucleicBackboneAtoms.has(name) || name.includes("'") || name.includes('*')) &&
            !keptResidues.get(unit.id)?.has(residue)
          )
            continue;
        }
      }
      subset.addElement(atom);
    }
    subset.commitUnit();
  }
  return subset.elementCount === structure.elementCount ? structure : subset.getStructure();
}

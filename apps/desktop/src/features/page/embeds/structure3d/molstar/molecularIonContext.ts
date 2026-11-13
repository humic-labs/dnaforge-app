import { Structure, Unit } from 'molstar/lib/mol-model/structure';
import { isPolymer } from 'molstar/lib/mol-model/structure/model/types';
import * as NativeModelTypes from 'molstar/lib/mol-model/structure/model/types';
import { getElementMoleculeType } from 'molstar/lib/mol-model/structure/util';
import { Box3D } from 'molstar/lib/mol-math/geometry';
import { Vec3 } from 'molstar/lib/mol-math/linear-algebra';
import type { Task } from 'molstar/lib/mol-task';
import type { ElementIndex } from 'molstar/lib/mol-model/structure/model';
import { computeMolecularInterfaceBurial } from './molecularInterfaceBurial';
import { molecularAtomSelector } from './molecularConnections';

const moleculeTypes = (NativeModelTypes as unknown as { MoleculeType: { Ion: number } })
  .MoleculeType;

function subset(source: Structure, include: (unit: Unit.Atomic, atom: ElementIndex) => boolean) {
  const builder = source.subsetBuilder(true);
  for (const unit of source.units) {
    if (!Unit.isAtomic(unit)) continue;
    builder.beginUnit(unit.id);
    for (const atom of Array.from(unit.elements)) if (include(unit, atom)) builder.addElement(atom);
    builder.commitUnit();
  }
  return builder.getStructure();
}

const physicalFrame = (unit: Unit.Atomic) =>
  `${unit.model.id}:${JSON.stringify(Array.from(unit.conformation.operator.matrix))}`;

function monatomicIonTarget(source: Structure, target: Structure) {
  if (!target.elementCount || target.units.some((unit) => !Unit.isAtomic(unit))) return false;
  for (const unit of target.units) {
    if (!Unit.isAtomic(unit)) return false;
    const parent = source.unitMap.get(unit.id);
    if (!parent || !Unit.isAtomic(parent)) return false;
    for (const atom of Array.from(unit.elements)) {
      if (getElementMoleculeType(unit, atom) !== moleculeTypes.Ion) return false;
      const residue = unit.residueIndex[atom];
      if (
        Array.from(parent.elements).filter((index) => parent.residueIndex[index] === residue)
          .length !== 1
      )
        return false;
    }
  }
  return true;
}

export async function molecularIonPhysicalContext(
  source: Structure,
  target: Structure,
  nativeEnvironment: Structure,
  radius: number,
  runTask: <T>(task: Task<T>) => Promise<T> = (task) => task.run()
) {
  if (!monatomicIonTarget(source, target)) return undefined;
  const targetKeys = new Set<string>();
  const frames = new Set<string>();
  for (const unit of target.units) {
    if (!Unit.isAtomic(unit)) continue;
    for (const atom of Array.from(unit.elements)) {
      targetKeys.add(`${unit.id}:${atom}`);
      frames.add(
        `${physicalFrame(unit)}:${unit.model.atomicHierarchy.atoms.label_comp_id.value(atom)}`
      );
    }
  }
  const localUnitIds = new Set<number>();
  for (const unit of nativeEnvironment.units) {
    if (
      Unit.isAtomic(unit) &&
      Array.from(unit.elements).some((atom) => isPolymer(getElementMoleculeType(unit, atom)))
    )
      localUnitIds.add(unit.id);
  }
  const polymer = subset(
    source,
    (unit, atom) => localUnitIds.has(unit.id) && isPolymer(getElementMoleculeType(unit, atom))
  );
  const envelope = Box3D.setEmpty(Box3D());
  for (const unit of polymer.units) {
    if (!Unit.isAtomic(unit)) continue;
    for (const atom of Array.from(unit.elements))
      Box3D.add(envelope, unit.conformation.position(atom, Vec3()));
  }
  Box3D.expandUniformly(envelope, envelope, radius);
  const cohort = subset(source, (unit, atom) => {
    if (targetKeys.has(`${unit.id}:${atom}`)) return true;
    return (
      polymer.elementCount > 0 &&
      getElementMoleculeType(unit, atom) === moleculeTypes.Ion &&
      frames.has(
        `${physicalFrame(unit)}:${unit.model.atomicHierarchy.atoms.label_comp_id.value(atom)}`
      ) &&
      Box3D.containsVec3(envelope, unit.conformation.position(atom, Vec3()))
    );
  });
  const packing = polymer.elementCount
    ? await computeMolecularInterfaceBurial(source, cohort, polymer, runTask)
    : undefined;
  return {
    cohort,
    packing,
    receipt: {
      contract: 'native-molstar-ion-physical-context-v2' as const,
      declaredTargetAtomCount: target.elementCount,
      cohortAtomCount: cohort.elementCount,
      contextualIonAtomCount: cohort.elementCount - target.elementCount,
      polymerUnitCount: localUnitIds.size,
      selector: molecularAtomSelector(cohort, source),
      envelope: polymer.elementCount
        ? { min: [...envelope.min], max: [...envelope.max], margin: radius }
        : undefined,
      packing,
      meaning:
        'Same-species sites in the selected model/operator within the spatial envelope of whole polymer units touching the native seed neighborhood, plus complete residues with native site-induced solvent-accessible area loss. Every displayed cohort site belongs to the computed contact boundary. Standard native classification and distance settings are unchanged; the discovery seed does not prune cohort guides.',
    },
  };
}

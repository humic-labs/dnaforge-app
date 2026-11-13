import { Structure, Unit } from 'molstar/lib/mol-model/structure';
import { AccessibleSurfaceArea } from 'molstar/lib/mol-model-props/computed/accessible-surface-area/shrake-rupley';
import type { Task } from 'molstar/lib/mol-task';
import { molecularAtomSelector } from './molecularConnections';

export const MOLECULAR_INTERFACE_AREA_PARAMETERS = {
  probeSize: 1.4,
  numberOfSpherePoints: 92,
  nonPolymer: true,
  traceOnly: false,
} as const;

const atomKeys = (structure: Structure) =>
  new Set(
    structure.units.flatMap((unit) =>
      Unit.isAtomic(unit) ? Array.from(unit.elements, (atom) => `${unit.id}:${atom}`) : []
    )
  );

function subset(source: Structure, included: ReadonlySet<string>): Structure {
  const builder = source.subsetBuilder(true);
  for (const unit of source.units) {
    builder.beginUnit(unit.id);
    for (const atom of Array.from(unit.elements))
      if (included.has(`${unit.id}:${atom}`)) builder.addElement(atom);
    builder.commitUnit();
  }
  return builder.getStructure();
}

function residueAreas(structure: Structure, result: AccessibleSurfaceArea): Map<string, number> {
  const areas = new Map<string, number>();
  let serialAtom = 0;
  for (const unit of structure.units) {
    if (!Unit.isAtomic(unit)) throw Error('Interface surface burial requires atomic coordinates.');
    for (const atom of Array.from(unit.elements)) {
      const serialResidue = result.serialResidueIndex[serialAtom++];
      if (serialResidue < 0) continue;
      const area = result.area[serialResidue];
      if (!Number.isFinite(area)) throw Error('Native interface surface area is unavailable.');
      areas.set(`${unit.id}:${unit.residueIndex[atom]}`, area);
    }
  }
  return areas;
}

function buriedSide(
  source: Structure,
  side: Structure,
  alone: Map<string, number>,
  together: Map<string, number>
) {
  const residues = new Set<string>();
  let buriedArea = 0;
  for (const [key, isolatedArea] of alone) {
    const complexArea = together.get(key);
    if (complexArea === undefined)
      throw Error('Native interface residue correspondence is missing.');
    const loss = isolatedArea - complexArea;
    if (loss < -0.001) throw Error('Adding a partner increased sampled surface area unexpectedly.');
    if (loss > 0.001) {
      residues.add(key);
      buriedArea += loss;
    }
  }
  const included = new Set(
    side.units.flatMap((unit) =>
      Unit.isAtomic(unit)
        ? Array.from(unit.elements)
            .filter((atom) => residues.has(`${unit.id}:${unit.residueIndex[atom]}`))
            .map((atom) => `${unit.id}:${atom}`)
        : []
    )
  );
  const patch = subset(source, included);
  return {
    selector: patch.elementCount ? molecularAtomSelector(patch, source) : [],
    buriedArea,
    residueCount: residues.size,
    atomCount: patch.elementCount,
  };
}

export async function computeMolecularInterfaceBurial(
  source: Structure,
  target: Structure,
  partner: Structure,
  runTask: <T>(task: Task<T>) => Promise<T> = (task) => task.run()
) {
  const targetKeys = atomKeys(target),
    partnerKeys = atomKeys(partner),
    sourceKeys = atomKeys(source);
  if (!targetKeys.size || !partnerKeys.size || [...targetKeys].some((key) => partnerKeys.has(key)))
    throw Error('Interface surface burial requires two nonempty disjoint physical sides.');
  if ([...targetKeys, ...partnerKeys].some((key) => !sourceKeys.has(key)))
    throw Error('Interface sides must belong to their declared coordinate source.');
  const together = subset(source, new Set([...targetKeys, ...partnerKeys]));
  const targetResult = await runTask(
    AccessibleSurfaceArea.compute(target, MOLECULAR_INTERFACE_AREA_PARAMETERS)
  );
  const partnerResult = await runTask(
    AccessibleSurfaceArea.compute(partner, MOLECULAR_INTERFACE_AREA_PARAMETERS)
  );
  const complexResult = await runTask(
    AccessibleSurfaceArea.compute(together, MOLECULAR_INTERFACE_AREA_PARAMETERS)
  );
  const complexAreas = residueAreas(together, complexResult);
  return {
    contract: 'native-molstar-interface-burial-v1' as const,
    parameters: { ...MOLECULAR_INTERFACE_AREA_PARAMETERS },
    target: buriedSide(source, target, residueAreas(target, targetResult), complexAreas),
    partner: buriedSide(source, partner, residueAreas(partner, partnerResult), complexAreas),
  };
}

export type MolecularInterfaceBurial = Awaited<ReturnType<typeof computeMolecularInterfaceBurial>>;

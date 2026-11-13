import { Structure, Unit, type StructureElement } from 'molstar/lib/mol-model/structure';
import { BondType } from 'molstar/lib/mol-model/structure/model/types';
import { IntAdjacencyGraph } from 'molstar/lib/mol-math/graph/int-adjacency-graph';
import { InterUnitGraph } from 'molstar/lib/mol-math/graph/inter-unit-graph';
import { InterUnitBonds } from 'molstar/lib/mol-model/structure/structure/unit/bonds';
import { FeaturesBuilder } from 'molstar/lib/mol-model-props/computed/interactions/features';
import { MetalProvider } from 'molstar/lib/mol-model-props/computed/interactions/metal';
import * as NativeInteractionTypes from 'molstar/lib/mol-model-props/computed/interactions/common';

const { IonicTypeMetal } = (
  NativeInteractionTypes as unknown as { FeatureType: { IonicTypeMetal: number } }
).FeatureType;
const metalRoles = new WeakMap<Unit.Atomic, Map<number, number>>();
const depictionCache = new WeakMap<Structure, Structure>();

function roles(structure: Structure, unit: Unit.Atomic): Map<number, number> {
  const prior = metalRoles.get(unit);
  if (prior) return prior;
  const builder = FeaturesBuilder.create();
  MetalProvider.add(structure, unit, builder);
  const features = builder.getFeatures(unit.elements.length);
  const result = new Map<number, number>();
  for (let feature = 0; feature < features.count; feature++)
    for (let member = features.offsets[feature]; member < features.offsets[feature + 1]; member++)
      result.set(features.members[member], Number(features.types[feature]));
  metalRoles.set(unit, result);
  return result;
}

export function unsupportedIonicMetalCoordination(
  structure: Structure,
  a: Unit.Atomic,
  ai: number,
  b: Unit.Atomic,
  bi: number,
  flags: number
): boolean {
  if (!(flags & BondType.Names['metal-coordination']) || flags & BondType.Names.covalent)
    return false;
  const typeA = roles(structure, a).get(ai),
    typeB = roles(structure, b).get(bi);
  return (
    typeA !== undefined &&
    typeB !== undefined &&
    (typeA === IonicTypeMetal || typeB === IonicTypeMetal)
  );
}

export function coordinationDepictionStructure(structure: Structure): Structure {
  const prior = depictionCache.get(structure);
  if (prior) return prior;
  if (structure.child) {
    const parent = coordinationDepictionStructure(structure.target);
    const selected = coordinationDepictionStructure(structure.child);
    if (parent === structure.target && selected === structure.child) {
      depictionCache.set(structure, structure);
      return structure;
    }
    const result = Structure.create(selected.units, {
      parent,
      interUnitBonds: selected.interUnitBonds,
      coordinateSystem: selected.coordinateSystem,
      label: selected.label,
      masterModel: selected.masterModel,
      representativeModel: selected.representativeModel,
    }).asParent();
    depictionCache.set(structure, result);
    depictionCache.set(result, result);
    return result;
  }
  let changed = false;
  const units = structure.units.map((unit) => {
    if (!Unit.isAtomic(unit)) return unit;
    const bonds = unit.bonds;
    const kept: number[] = [];
    let removed = false;
    for (let edge = 0; edge < bonds.a.length; edge++) {
      if (bonds.a[edge] >= bonds.b[edge]) continue;
      if (
        unsupportedIonicMetalCoordination(
          structure,
          unit,
          bonds.a[edge],
          unit,
          bonds.b[edge],
          bonds.edgeProps.flags[edge]
        )
      )
        removed = true;
      else kept.push(edge);
    }
    if (!removed) return unit;
    changed = true;
    const builder = new IntAdjacencyGraph.EdgeBuilder(
      unit.elements.length,
      kept.map((edge) => bonds.a[edge]),
      kept.map((edge) => bonds.b[edge])
    );
    const order = new Int8Array(builder.slotCount),
      flags = new Uint16Array(builder.slotCount),
      key = new Int32Array(builder.slotCount);
    for (const edge of kept) {
      builder.addNextEdge();
      builder.assignProperty(order, bonds.edgeProps.order[edge]);
      builder.assignProperty(flags, bonds.edgeProps.flags[edge]);
      builder.assignProperty(key, bonds.edgeProps.key[edge]);
    }
    return new Unit.Atomic(
      unit.id,
      unit.invariantId,
      unit.chainGroupId,
      unit.traits,
      unit.model,
      unit.elements,
      unit.conformation,
      { ...unit.props, bonds: builder.createGraph({ order, flags, key }, bonds.props) }
    );
  });
  const keptEdges = structure.interUnitBonds.edges.filter((edge) => {
    const a = structure.unitMap.get(edge.unitA),
      b = structure.unitMap.get(edge.unitB);
    if (!Unit.isAtomic(a) || !Unit.isAtomic(b)) return true;
    const unsupported = unsupportedIonicMetalCoordination(
      structure,
      a,
      edge.indexA,
      b,
      edge.indexB,
      edge.props.flag
    );
    if (unsupported) changed = true;
    return !unsupported;
  });
  if (!changed) {
    depictionCache.set(structure, structure);
    return structure;
  }
  const builder = new InterUnitGraph.Builder<
    number,
    StructureElement.UnitIndex,
    { order: number; flag: BondType.Flag; key: number }
  >();
  const pairs = new Map<string, typeof keptEdges>();
  for (const edge of keptEdges) {
    if (edge.unitA > edge.unitB) continue;
    const key = `${edge.unitA}:${edge.unitB}`;
    const edges = pairs.get(key) ?? [];
    edges.push(edge);
    pairs.set(key, edges);
  }
  for (const edges of pairs.values()) {
    builder.startUnitPair(edges[0].unitA, edges[0].unitB);
    for (const edge of edges) builder.add(edge.indexA, edge.indexB, edge.props);
    builder.finishUnitPair();
  }
  const result = Structure.create(units, {
    parent: structure.parent,
    interUnitBonds: new InterUnitBonds(builder.getMap()),
    coordinateSystem: structure.coordinateSystem,
    label: structure.label,
    masterModel: structure.masterModel,
    representativeModel: structure.representativeModel,
  });
  depictionCache.set(structure, result);
  depictionCache.set(result, result);
  return result;
}

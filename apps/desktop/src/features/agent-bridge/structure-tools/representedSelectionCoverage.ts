import { OrderedSet, SortedArray } from 'molstar/lib/mol-data/int';
import type { Loci } from 'molstar/lib/mol-model/loci';
import { StructureElement, Unit } from 'molstar/lib/mol-model/structure';
import type { MolstarPlugin } from '../../page/public/embeds/structure3d/viewerCache';

export function representedSelectionCoverage(plugin: MolstarPlugin, loci: Loci) {
  if (loci.kind !== 'element-loci') return null;
  type UnitElements = (typeof loci.elements)[number]['unit']['elements'];
  const visibleUnits = new Map<number, UnitElements[]>();
  for (const structure of plugin.managers.structure.hierarchy.current.structures) {
    for (const component of structure.components) {
      if (component.cell.state.isHidden) continue;
      const data = component.cell.obj?.data;
      if (!data) continue;
      for (const representation of component.representations) {
        if (representation.cell.state.isHidden) continue;
        const native = representation.cell.obj?.data.repr;
        if (
          native &&
          (!native.state.visible || native.state.alphaFactor === 0 || native.props.alpha === 0)
        )
          continue;
        const cartoon = representation.cell.params?.values.type.name === 'cartoon' && native;
        const locations = new Map<number, Set<number>>();
        if (cartoon) {
          native.eachLocation((location) => {
            if (!StructureElement.Location.is(location)) return;
            const represented = locations.get(location.unit.id) ?? new Set<number>();
            represented.add(
              Unit.isAtomic(location.unit)
                ? location.unit.model.atomicHierarchy.residueAtomSegments.index[location.element]
                : location.element
            );
            locations.set(location.unit.id, represented);
          });
        }
        for (const unit of data.units) {
          const represented = locations.get(unit.id);
          const covered = cartoon
            ? SortedArray.ofSortedArray<UnitElements[number]>(
                Array.from(unit.elements).filter((atom) =>
                  represented?.has(
                    Unit.isAtomic(unit)
                      ? unit.model.atomicHierarchy.residueAtomSegments.index[atom]
                      : atom
                  )
                )
              )
            : unit.elements;
          const elements = visibleUnits.get(unit.id);
          if (elements) elements.push(covered);
          else visibleUnits.set(unit.id, [covered]);
        }
      }
    }
  }
  let selectedAtomCount = 0;
  let representedAtomCount = 0;
  for (const element of loci.elements) {
    const representedUnits = visibleUnits.get(element.unit.id) ?? [];
    OrderedSet.forEach(element.indices, (index) => {
      selectedAtomCount++;
      const atom = element.unit.elements[index];
      if (representedUnits.some((unit) => SortedArray.has(unit, atom))) representedAtomCount++;
    });
  }
  return { selectedAtomCount, representedAtomCount };
}

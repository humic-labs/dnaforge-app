import { Unit, type Structure } from 'molstar/lib/mol-model/structure';
import { isNucleic } from 'molstar/lib/mol-model/structure/model/types';
import type { MolstarPlugin } from './cache';
import {
  filterNucleotideAtomicStructure,
  filterNucleotideVisualStructure,
} from './nucleotidePresentation';

export type DuplicateMolViewSpecGeometry = {
  type: string;
  largerType: string;
  smallerComponent: string;
  largerComponent: string;
  repeatedElementCount: number;
  feature?: string;
};
type Footprint = Map<string, Set<number>>;
type FeatureOwner = { type: string; component: string; feature: string; footprint: Footprint };

function visualRoles(type: string, visuals?: readonly string[]): string[] {
  if (!visuals) {
    if (type === 'cartoon' || type === 'backbone') return ['polymer-path'];
    if (['ball-and-stick', 'spacefill', 'line', 'point'].includes(type)) return ['atomistic'];
    return [type];
  }
  return visuals.flatMap((visual) => {
    if (visual === 'nucleotide-ring') return ['nucleotide-plane', 'nucleotide-attachment'];
    if (visual === 'dnaforge-nucleotide-base-plane') return ['nucleotide-plane'];
    if (visual === 'dnaforge-nucleotide-connector') return ['nucleotide-attachment'];
    if (visual === 'nucleotide-atomic-ring-fill')
      return ['nucleotide-plane', 'nucleotide-sugar-plane'];
    if (
      [
        'polymer-trace',
        'polymer-tube',
        'polymer-backbone-cylinder',
        'polymer-backbone-sphere',
      ].includes(visual)
    )
      return ['polymer-path'];
    if (/^(?:element-|intra-bond|inter-bond)/.test(visual)) return ['atomistic'];
    if (/^nucleotide-atomic-(?:bond|element)/.test(visual)) return ['atomistic'];
    return [visual];
  });
}
function add(footprint: Footprint, key: string, element: number): void {
  const elements = footprint.get(key) ?? new Set<number>();
  elements.add(element);
  footprint.set(key, elements);
}
function sourceFootprint(source: Structure, feature: string, ignoreHydrogens = false): Footprint {
  const footprint: Footprint = new Map();
  for (const unit of source.units) {
    const key = `${unit.model.id}:${JSON.stringify(unit.conformation.operator.matrix)}`;
    if (!Unit.isAtomic(unit) || !unit.model.atomicHierarchy?.residueAtomSegments) {
      if (feature === 'nucleotide-atomic-attachment') continue;
      for (let index = 0; index < unit.elements.length; index++)
        add(footprint, key, unit.elements[index]);
      continue;
    }
    if (feature === 'polymer-path') {
      for (let index = 0; index < unit.polymerElements.length; index++)
        add(footprint, key, unit.polymerElements[index]);
    } else if (feature.startsWith('nucleotide-') && feature !== 'nucleotide-atomic-attachment') {
      for (let index = 0; index < unit.nucleotideElements.length; index++)
        add(
          footprint,
          key,
          unit.model.atomicHierarchy.residueAtomSegments.index[unit.nucleotideElements[index]]
        );
    } else if (feature === 'nucleotide-atomic-attachment') {
      const hierarchy = unit.model.atomicHierarchy;
      const atomsByResidue = new Map<number, Set<string>>();
      for (let index = 0; index < unit.elements.length; index++) {
        const atom = unit.elements[index];
        const residue = hierarchy.residueAtomSegments.index[atom];
        if (!isNucleic(hierarchy.derived.residue.moleculeType[residue])) continue;
        const names = atomsByResidue.get(residue) ?? new Set<string>();
        names.add(hierarchy.atoms.label_atom_id.value(atom));
        atomsByResidue.set(residue, names);
      }
      for (const [residue, names] of atomsByResidue) {
        if ((names.has('N9') || names.has('N1')) && (names.has("C1'") || names.has('C1*')))
          add(footprint, key, residue);
      }
    } else {
      for (let index = 0; index < unit.elements.length; index++) {
        const atom = unit.elements[index];
        if (
          ignoreHydrogens &&
          ['H', 'D', 'T'].includes(unit.model.atomicHierarchy.atoms.type_symbol.value(atom))
        )
          continue;
        add(footprint, key, atom);
      }
    }
  }
  return footprint;
}
function overlap(first: Footprint, second: Footprint): number {
  let count = 0;
  for (const [unit, atoms] of first) {
    const other = second.get(unit);
    if (other) for (const atom of atoms) if (other.has(atom)) count++;
  }
  return count;
}
export function findDuplicateMolViewSpecGeometry(
  plugin: MolstarPlugin
): DuplicateMolViewSpecGeometry[] {
  const owners: FeatureOwner[] = [];
  for (const structure of plugin.managers.structure.hierarchy.current.structures) {
    for (const component of structure.components) {
      const source = component.cell.obj?.data;
      if (!source || source.elementCount === 0) continue;
      for (const representation of component.representations) {
        const values = representation.cell.params?.values;
        const native = representation.cell.obj?.data.repr;
        if (
          !values?.type ||
          !native?.state.visible ||
          native.state.alphaFactor === 0 ||
          native.props.alpha === 0
        )
          continue;
        const type = values.type.name;
        const props = { ...values.type.params, ...native.props } as Record<string, unknown>;
        const visuals = Array.isArray(props.visuals) ? (props.visuals as string[]) : undefined;
        const roles = visualRoles(type, visuals);
        const atomicSource =
          props.dnaforgeNucleotideAtomicMode === 'base-only'
            ? filterNucleotideAtomicStructure(
                source,
                'base-only',
                Array.isArray(props.dnaforgeNucleotideKeepAtoms)
                  ? props.dnaforgeNucleotideKeepAtoms
                  : []
              )
            : source;
        const compositional = new Set<string>();
        for (const feature of roles) {
          if (['atomistic', 'polymer-path'].includes(feature)) {
            if (compositional.has(feature)) continue;
            compositional.add(feature);
          }
          let selected = source;
          if (feature === 'atomistic') selected = atomicSource;
          if (feature.startsWith('nucleotide-') && Array.isArray(props.dnaforgeNucleotideExclude))
            selected = filterNucleotideVisualStructure(source, props.dnaforgeNucleotideExclude);
          owners.push({
            type,
            component: component.cell.obj?.label || source.label || 'Unnamed selection',
            feature,
            footprint: sourceFootprint(selected, feature, props.ignoreHydrogens === true),
          });
        }
        if (['ball-and-stick', 'line'].includes(type) && roles.includes('atomistic'))
          owners.push({
            type,
            component: component.cell.obj?.label || source.label || 'Unnamed selection',
            feature: 'nucleotide-attachment',
            footprint: sourceFootprint(atomicSource, 'nucleotide-atomic-attachment'),
          });
      }
    }
  }
  const duplicates: DuplicateMolViewSpecGeometry[] = [];
  for (let index = 0; index < owners.length; index++) {
    const first = owners[index];
    for (let secondIndex = index + 1; secondIndex < owners.length; secondIndex++) {
      const second = owners[secondIndex];
      if (first.feature !== second.feature) continue;
      const repeated = overlap(first.footprint, second.footprint);
      if (!repeated) continue;
      const firstCount = [...first.footprint.values()].reduce((n, atoms) => n + atoms.size, 0);
      const secondCount = [...second.footprint.values()].reduce((n, atoms) => n + atoms.size, 0);
      const [smaller, larger] = firstCount <= secondCount ? [first, second] : [second, first];
      duplicates.push({
        type: smaller.type,
        largerType: larger.type,
        smallerComponent: smaller.component,
        largerComponent: larger.component,
        repeatedElementCount: repeated,
        feature: first.feature,
      });
    }
  }
  return duplicates;
}

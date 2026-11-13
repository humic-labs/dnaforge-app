import { componentPropsFromSelector } from 'molstar/lib/extensions/mvs/load-helpers';
import { substructureFromSelector } from 'molstar/lib/extensions/mvs/components/selector';
import { OrderedSet } from 'molstar/lib/mol-data/int';
import {
  Structure,
  StructureElement,
  StructureProperties,
  Unit,
} from 'molstar/lib/mol-model/structure';
import type { Color } from 'molstar/lib/mol-util/color';
import type { MolstarPlugin } from './cache';
import { hiddenChainLoci } from './chainVisibility';
import { nativeStructureSourceScope } from '../utils/structureIds';
import { filterNucleotideAtomicStructure } from './nucleotidePresentation';
import {
  activeMolViewSpecScene,
  activeMolViewSpecSnapshotIndex,
  sameLoadedMolViewSpecScene,
} from './molViewSpec';
import {
  MAX_SWATCH_SECTORS,
  molViewSpecColorGroups,
  type MolViewSpecColorGroup,
  type MolViewSpecSwatch,
} from './molViewSpecLegend';
import { resolveMolViewSpecStructureRef } from './molViewSpecStructureIdentity';
import { rememberViewerOverview } from './viewerSelection';

export function nativeMolViewSpecColorGroups(
  plugin: MolstarPlugin,
  scene: string | undefined,
  snapshotIndex: number
): MolViewSpecColorGroup[] {
  const resolved = new Map<
    MolViewSpecColorGroup,
    ReturnType<typeof resolveMolViewSpecColorGroupLociByStructure>
  >();
  const selections = (group: MolViewSpecColorGroup) => {
    let loci = resolved.get(group);
    if (!loci) {
      loci = resolveMolViewSpecColorGroupLociByStructure(plugin, group);
      resolved.set(group, loci);
    }
    return loci;
  };
  const groups = molViewSpecColorGroups(scene, snapshotIndex, (left, right) => {
    try {
      const a = selections(left),
        b = selections(right);
      return (
        a.length > 0 &&
        a.length === b.length &&
        a.every(({ structureRef, loci }) => {
          const other = b.find((selection) => selection.structureRef === structureRef);
          return (
            !!structureRef &&
            !!other &&
            !StructureElement.Loci.isEmpty(loci) &&
            StructureElement.Loci.areEqual(loci, other.loci)
          );
        })
      );
    } catch {
      return false;
    }
  });
  for (const group of groups) {
    if (!group.multicolor) continue;
    try {
      const swatch = drawnSwatch(plugin, group, selections(group));
      if (swatch) group.swatch = swatch;
    } catch {
      continue;
    }
  }
  return groups;
}

function drawnSwatch(
  plugin: MolstarPlugin,
  group: MolViewSpecColorGroup,
  selected: ReturnType<typeof resolveMolViewSpecColorGroupLociByStructure>
): MolViewSpecSwatch | undefined {
  const theme = group.targets[0]?.colorTheme;
  if (
    !theme ||
    group.targets.some((target) => JSON.stringify(target.colorTheme) !== JSON.stringify(theme))
  )
    return undefined;
  const registry = plugin.representation.structure.themes.colorThemeRegistry;
  const tiers = [new Set<Color>(), new Set<Color>(), new Set<Color>(), new Set<Color>()];
  for (const { loci } of selected) {
    const paint = registry.create(theme.name, { structure: loci.structure }, theme.params);
    if (paint.legend?.kind === 'scale-legend')
      return {
        kind: 'gradient',
        colors: paint.legend.colors.map((entry) => (Array.isArray(entry) ? entry[0] : entry)),
      };
    if (!('color' in paint)) return undefined;
    const location = StructureElement.Location.create(loci.structure);
    for (const { unit, indices } of loci.elements) {
      location.unit = unit;
      const atomic = Unit.isAtomic(unit) ? unit : undefined;
      let residue = -1;
      let polymer = true;
      const sampled = [false, false];
      for (let i = 0, n = OrderedSet.size(indices); i < n; i++) {
        const element = unit.elements[OrderedSet.getAt(indices, i)];
        location.element = element;
        let carbon = true;
        if (atomic) {
          if (atomic.residueIndex[element] !== residue) {
            residue = atomic.residueIndex[element];
            polymer = StructureProperties.entity.type(location) === 'polymer';
            sampled.fill(false);
          }
          carbon = atomic.model.atomicHierarchy.atoms.type_symbol.value(element) === 'C';
          if (sampled[carbon ? 0 : 1]) continue;
          sampled[carbon ? 0 : 1] = true;
        }
        const tier = tiers[(polymer ? 0 : 2) + (carbon ? 0 : 1)];
        if (tier.size <= MAX_SWATCH_SECTORS) tier.add(paint.color(location, false));
        if (tiers[0].size > MAX_SWATCH_SECTORS) return { kind: 'colors', colors: [...tiers[0]] };
      }
    }
  }
  const colors = tiers.find((tier) => tier.size);
  return colors ? { kind: 'colors', colors: [...colors] } : undefined;
}

export function selectMolViewSpecColorGroup(
  plugin: MolstarPlugin,
  scene: string,
  snapshotIndex: number,
  group: MolViewSpecColorGroup,
  hiddenChainInstanceIds: readonly string[] = []
): number {
  const { selected, atomCount } = displayedGroup(
    plugin,
    scene,
    snapshotIndex,
    group,
    hiddenChainInstanceIds
  );
  plugin.managers.interactivity.lociSelects.deselectAll();
  for (const { loci } of selected)
    plugin.managers.interactivity.lociSelects.select({ loci }, false);
  return atomCount;
}

export function focusMolViewSpecColorGroup(
  plugin: MolstarPlugin,
  scene: string,
  snapshotIndex: number,
  group: MolViewSpecColorGroup,
  hiddenChainInstanceIds: readonly string[] = []
): number {
  const { selected, atomCount } = displayedGroup(
    plugin,
    scene,
    snapshotIndex,
    group,
    hiddenChainInstanceIds
  );
  rememberViewerOverview(plugin);
  plugin.managers.camera.focusLoci(selected.map(({ loci }) => loci));
  return atomCount;
}

function displayedGroup(
  plugin: MolstarPlugin,
  scene: string,
  snapshotIndex: number,
  group: MolViewSpecColorGroup,
  hiddenChainInstanceIds: readonly string[]
) {
  if (
    !sameLoadedMolViewSpecScene(activeMolViewSpecScene(plugin), scene) ||
    activeMolViewSpecSnapshotIndex(plugin) !== snapshotIndex
  )
    throw new Error('The displayed structure changed before the color group could be selected.');

  const selected = resolveMolViewSpecColorGroupLociByStructure(
    plugin,
    group,
    hiddenChainInstanceIds
  );
  const atomCount = selected.reduce(
    (sum, selection) => sum + StructureElement.Loci.size(selection.loci),
    0
  );
  if (!atomCount) throw new Error('This color group has no atoms in the displayed structure.');
  return { selected, atomCount };
}

export function resolveMolViewSpecColorGroupLoci(
  plugin: MolstarPlugin,
  group: MolViewSpecColorGroup,
  hiddenChainInstanceIds: readonly string[] = []
): StructureElement.Loci {
  const selections = resolveMolViewSpecColorGroupLociByStructure(
    plugin,
    group,
    hiddenChainInstanceIds
  );
  if (selections.length !== 1)
    throw new Error('This group owns atoms in several structures; use source-qualified loci.');
  return selections[0].loci;
}

export function resolveMolViewSpecColorGroupLociByStructure(
  plugin: MolstarPlugin,
  group: MolViewSpecColorGroup,
  hiddenChainInstanceIds: readonly string[] = []
): Array<{ structureRef?: string; loci: StructureElement.Loci }> {
  if (!group.selectable || !group.targets.length)
    throw new Error('This color group cannot be mapped to an exact atom selection.');
  const structures = plugin.managers.structure.hierarchy.current.structures;
  const selector = (value: unknown) =>
    componentPropsFromSelector(value as Parameters<typeof componentPropsFromSelector>[0]);
  const selections = new Map<Structure, { structureRef?: string; loci: StructureElement.Loci }>();
  for (const target of group.targets) {
    const parent = target.structureRef
      ? resolveMolViewSpecStructureRef(plugin, target.structureRef)
      : group.structureCount === 1 && structures.length === 1 && target.structureIndex === 0
        ? (structures[0].transform?.cell.obj?.data ?? structures[0].cell.obj?.data)
        : undefined;
    if (!parent) throw new Error('The color group has no exact loaded structure identity.');
    const source = substructureFromSelector(parent, selector(target.componentSelector));
    const component = target.nucleotideAtomicMode
      ? filterNucleotideAtomicStructure(
          source,
          target.nucleotideAtomicMode,
          target.nucleotideKeepAtoms
        )
      : source;
    const colored = substructureFromSelector(component, selector(target.colorSelector));
    let loci = Structure.toSubStructureElementLoci(parent, colored);
    if (target.nucleotideJunctionAtoms?.length) {
      const support = substructureFromSelector(parent, selector(target.nucleotideJunctionAtoms));
      loci = StructureElement.Loci.subtract(
        loci,
        Structure.toSubStructureElementLoci(parent, support)
      );
    }
    for (const laterSelector of target.laterColorSelectors) {
      const repaint = substructureFromSelector(component, selector(laterSelector));
      loci = StructureElement.Loci.subtract(
        loci,
        Structure.toSubStructureElementLoci(parent, repaint)
      );
    }
    const previous = selections.get(parent);
    selections.set(parent, {
      structureRef: previous?.structureRef ?? target.structureRef,
      loci: previous ? StructureElement.Loci.union(previous.loci, loci) : loci,
    });
  }
  for (const [parent, selection] of selections) {
    if (hiddenChainInstanceIds.length) {
      const hidden = hiddenChainLoci(
        parent,
        new Set(hiddenChainInstanceIds),
        nativeStructureSourceScope(plugin, parent)
      );
      if (hidden) selection.loci = StructureElement.Loci.subtract(selection.loci, hidden);
    }
  }
  return [...selections.values()];
}

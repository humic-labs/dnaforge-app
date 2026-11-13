import { Bond, Structure, StructureElement, Unit } from 'molstar/lib/mol-model/structure';
import type { PluginContext } from 'molstar/lib/mol-plugin/context';
import type { Representation } from 'molstar/lib/mol-repr/representation';
import type { Location } from 'molstar/lib/mol-model/location';
import type { StructureThemeLegend } from '../types';
import { ColorTheme as ColorThemeRuntime } from 'molstar/lib/mol-theme/color';
import { Color } from 'molstar/lib/mol-util/color';
import { isHydrogen, isTrace } from 'molstar/lib/mol-repr/structure/visual/util/common';
import type { StructureAtomicDetail, StructureColoration } from '../types';
import { colorationFromColors, structureResidueColorKey } from '../utils/structureColoration';
import { nativeStructureSources } from '../utils/structureIds';

type NativeRepresentation = Representation.Any;
type NativeColorTheme = NativeRepresentation['theme']['color'];
type Subscription = { unsubscribe(): void };
const externalColorChangeListeners = new WeakMap<object, Set<() => void>>();
const PROTEIN_BACKBONE_ATOMS = new Set(['N', 'CA', 'C', 'O', 'OXT']);
const ATOMISTIC_REPRESENTATIONS = new Set(['ball-and-stick', 'spacefill', 'line', 'point']);

export function effectiveRepresentationStructures(
  representation: NativeRepresentation,
  fallback?: Structure
): readonly Structure[] {
  if (typeof representation.getAllLoci !== 'function') return fallback ? [fallback] : [];
  const sources = new Set<Structure>();
  for (const loci of representation.getAllLoci()) {
    if (Structure.isLoci(loci)) sources.add(loci.structure);
    else if (StructureElement.Loci.is(loci)) sources.add(StructureElement.Loci.toStructure(loci));
  }
  return [...sources];
}

export function notifyStructureColorChanges(plugin: object): void {
  for (const listener of externalColorChangeListeners.get(plugin) ?? []) listener();
}

function atomicLocation(
  location: Location,
  secondary = false
): StructureElement.Location<Unit.Atomic> | null {
  if (StructureElement.Location.is(location) && Unit.isAtomic(location.unit)) {
    return location as StructureElement.Location<Unit.Atomic>;
  }
  if (Bond.isLocation(location)) {
    const unit = secondary ? location.bUnit : location.aUnit;
    if (!Unit.isAtomic(unit)) return null;
    return StructureElement.Location.create(
      secondary ? location.bStructure : location.aStructure,
      unit,
      unit.elements[secondary ? location.bIndex : location.aIndex]
    );
  }
  return null;
}

function atomKey(location: StructureElement.Location): string {
  return `${location.unit.model.id}:${location.unit.id}:${location.element}`;
}

function resolvedThemeColor(
  theme: NativeColorTheme,
  location: Location,
  isSecondary: boolean
): number | null {
  if (!('color' in theme)) return null;
  const color = theme.color(location, isSecondary);
  if (!Number.isInteger(color) || color < 0 || color > 0xffffff) return null;
  if (!theme.palette) return color;
  const palette = theme.palette.colors;
  if (!palette.length) return null;
  const normalized = (color - 1) / ColorThemeRuntime.PaletteScale;
  if (theme.palette.filter !== 'linear') {
    return palette[
      Math.max(0, Math.min(palette.length - 1, Math.floor(normalized * palette.length)))
    ];
  }
  const position = Math.max(0, Math.min(palette.length - 1, normalized * palette.length - 0.5));
  const left = Math.floor(position);
  return Color.interpolate(
    palette[left],
    palette[Math.min(left + 1, palette.length - 1)],
    position - left
  );
}

function overpaintForRepresentation(representation: NativeRepresentation): Map<string, number> {
  const paints = new Map<string, number>();
  for (const layer of representation.state.overpaint?.layers ?? []) {
    if (!StructureElement.Loci.is(layer.loci)) continue;
    StructureElement.Loci.forEachLocation(layer.loci, (location) => {
      if (layer.clear) paints.delete(atomKey(location));
      else paints.set(atomKey(location), layer.color);
    });
  }
  return paints;
}

function hiddenAtomsForRepresentation(representation: NativeRepresentation): Set<string> {
  const hidden = new Set<string>();
  const strength = representation.state.themeStrength?.transparency ?? 1;
  for (const layer of representation.state.transparency?.layers ?? []) {
    if (!StructureElement.Loci.is(layer.loci)) continue;
    StructureElement.Loci.forEachLocation(layer.loci, (location) => {
      if (layer.value * strength >= 1) hidden.add(atomKey(location));
      else hidden.delete(atomKey(location));
    });
  }
  return hidden;
}

export function visibleStructureAtomKeys(plugin: unknown): ReadonlySet<string> {
  const context = plugin as PluginContext | null;
  const visible = new Set<string>();
  const structures = context?.managers?.structure?.hierarchy?.current?.structures ?? [];
  structures.forEach((structure, index) => {
    for (const component of structure.components ?? [])
      for (const reference of component.representations ?? []) {
        const representation = reference.cell.obj?.data.repr;
        if (
          !representation ||
          !representation.state.visible ||
          representation.state.alphaFactor === 0 ||
          representation.props.alpha === 0 ||
          !representation.renderObjects.some(
            (object) =>
              object.state.visible &&
              object.values.drawCount.ref.value > 0 &&
              object.values.uAlpha.ref.value > 0
          )
        )
          continue;
        const hidden = hiddenAtomsForRepresentation(representation);
        representation.eachLocation((location, secondary) => {
          const atomic = Bond.isLocation(location)
            ? StructureElement.Location.create(
                secondary ? location.bStructure : location.aStructure,
                secondary ? location.bUnit : location.aUnit,
                secondary
                  ? location.bUnit.elements[location.bIndex]
                  : location.aUnit.elements[location.aIndex]
              )
            : StructureElement.Location.is(location)
              ? location
              : null;
          if (!atomic || hidden.has(atomKey(atomic))) return;
          if (!Unit.isAtomic(atomic.unit)) {
            visible.add(`${index}:${atomic.unit.id}:${atomic.element}`);
            return;
          }
          if (
            representation.props.ignoreHydrogens &&
            isHydrogen(
              atomic.structure!,
              atomic.unit,
              atomic.element,
              representation.props.ignoreHydrogensVariant === 'non-polar' ? 'non-polar' : 'all'
            )
          )
            return;
          if (representation.props.traceOnly && !isTrace(atomic.unit, atomic.element)) return;
          visible.add(`${index}:${atomic.unit.id}:${atomic.element}`);
        });
      }
  });
  return visible;
}

export function resolveStructureColorProjection(plugin: unknown): {
  all: ReadonlyMap<string, StructureColoration>;
  backbone: ReadonlyMap<string, StructureColoration>;
  alphaCarbon: ReadonlyMap<string, StructureColoration>;
  atomicDetail: ReadonlyMap<string, StructureAtomicDetail>;
} {
  const sources = nativeStructureSources(plugin);
  const colors = new Map<string, Set<number>>();
  const backboneColors = new Map<string, Set<number>>();
  const backboneTraceColors = new Map<string, Set<number>>();
  const atomisticTraceColors = new Map<string, Set<number>>();
  const atomisticTraceUnavailable = new Set<string>();
  const unavailable = new Set<string>();
  const backboneUnavailable = new Set<string>();
  const alphaCarbonColors = new Map<string, Set<number>>();
  const alphaCarbonUnavailable = new Set<string>();
  const atomicDetail = new Map<string, StructureAtomicDetail>();
  for (const { entry: structure, structureRef } of sources) {
    for (const component of structure.components ?? []) {
      for (const ref of component.representations ?? []) {
        const typeName = ref.cell.params?.values.type.name;
        const isAtomistic = ATOMISTIC_REPRESENTATIONS.has(typeName ?? '');
        const representation = ref.cell.obj?.data.repr;
        if (
          !representation ||
          !representation.state.visible ||
          representation.state.alphaFactor === 0 ||
          representation.props.alpha === 0
        )
          continue;
        const visuals =
          representation.props.visuals ?? ref.cell.params?.values.type.params?.visuals;
        const isBackbone =
          typeName === 'backbone' ||
          (typeName === 'cartoon' &&
            (!Array.isArray(visuals) || visuals.includes('polymer-trace')));
        const hidden = hiddenAtomsForRepresentation(representation);
        const recordAtomicDetail = (atomic: StructureElement.Location<Unit.Atomic>) => {
          if (!isAtomistic) return;
          const key = structureResidueColorKey(
            atomic.unit,
            atomic.unit.residueIndex[atomic.element],
            structureRef
          );
          const atomName = atomic.unit.model.atomicHierarchy.atoms.label_atom_id.value(
            atomic.element
          );
          atomicDetail.set(
            key,
            atomicDetail.get(key) === 'atoms' || !PROTEIN_BACKBONE_ATOMS.has(atomName)
              ? 'atoms'
              : 'backbone'
          );
        };
        const theme = representation.theme.color;
        if (
          !('color' in theme) ||
          theme.granularity === 'vertex' ||
          theme.granularity === 'vertexInstance'
        ) {
          for (const source of effectiveRepresentationStructures(
            representation,
            component.cell.obj?.data
          )) {
            for (const unit of source.units) {
              if (!Unit.isAtomic(unit)) continue;
              for (let index = 0; index < unit.elements.length; index++) {
                const element = unit.elements[index];
                if (hidden.has(`${unit.model.id}:${unit.id}:${element}`)) continue;
                const key = structureResidueColorKey(
                  unit,
                  unit.residueIndex[element],
                  structureRef
                );
                unavailable.add(key);
                if (isBackbone) backboneUnavailable.add(key);
                if (isAtomistic && isTrace(unit, element)) atomisticTraceUnavailable.add(key);
                if (
                  isAtomistic &&
                  unit.model.atomicHierarchy.atoms.label_atom_id.value(element) === 'CA'
                )
                  alphaCarbonUnavailable.add(key);
              }
            }
          }
          if (isAtomistic) {
            representation.eachLocation((location, secondary) => {
              const atomic = atomicLocation(location, secondary);
              if (atomic && !hidden.has(atomKey(atomic))) recordAtomicDetail(atomic);
            });
          }
          continue;
        }
        const paints = overpaintForRepresentation(representation);
        const paintStrength = representation.state.themeStrength?.overpaint ?? 1;
        representation.eachLocation((location, isSecondary) => {
          const atomic = atomicLocation(location, isSecondary);
          if (!atomic || hidden.has(atomKey(atomic))) return;
          if (
            representation.props.ignoreHydrogens &&
            isHydrogen(
              atomic.structure!,
              atomic.unit,
              atomic.element,
              representation.props.ignoreHydrogensVariant === 'non-polar' ? 'non-polar' : 'all'
            )
          )
            return;
          if (representation.props.traceOnly && !isTrace(atomic.unit, atomic.element)) return;
          recordAtomicDetail(atomic);
          const key = structureResidueColorKey(
            atomic.unit,
            atomic.unit.residueIndex[atomic.element],
            structureRef
          );
          const isAlphaCarbon =
            isAtomistic &&
            atomic.unit.model.atomicHierarchy.atoms.label_atom_id.value(atomic.element) === 'CA';
          let color = resolvedThemeColor(theme, location, isSecondary);
          if (color === null) {
            unavailable.add(key);
            if (isBackbone) backboneUnavailable.add(key);
            if (isAtomistic && isTrace(atomic.unit, atomic.element))
              atomisticTraceUnavailable.add(key);
            return;
          }
          const paint = paints.get(atomKey(atomic));
          if (paint !== undefined && paintStrength > 0) {
            color = Color.interpolate(Color(color), Color(paint), Math.min(1, paintStrength));
          }
          const residueColors = colors.get(key) ?? new Set<number>();
          residueColors.add(color);
          colors.set(key, residueColors);
          if (isAlphaCarbon) {
            const colors = alphaCarbonColors.get(key) ?? new Set<number>();
            colors.add(color);
            alphaCarbonColors.set(key, colors);
          }
          if (isAtomistic && isTrace(atomic.unit, atomic.element)) {
            const traceColors = atomisticTraceColors.get(key) ?? new Set<number>();
            traceColors.add(color);
            atomisticTraceColors.set(key, traceColors);
          }
          if (isBackbone) {
            const colorsForBackbone = backboneColors.get(key) ?? new Set<number>();
            colorsForBackbone.add(color);
            backboneColors.set(key, colorsForBackbone);
            if (isTrace(atomic.unit, atomic.element)) {
              const traceColors = backboneTraceColors.get(key) ?? new Set<number>();
              traceColors.add(color);
              backboneTraceColors.set(key, traceColors);
            }
          }
        });
      }
    }
  }
  const all = new Map<string, StructureColoration>();
  for (const [key, values] of colors) all.set(key, colorationFromColors(values));
  for (const key of unavailable) all.set(key, { kind: 'unavailable' });
  const backbone = new Map<string, StructureColoration>();
  for (const [key, values] of backboneColors) {
    backbone.set(key, colorationFromColors(backboneTraceColors.get(key) ?? values));
  }
  for (const [key, values] of atomisticTraceColors) {
    if (!backbone.has(key)) backbone.set(key, colorationFromColors(values));
  }
  for (const key of atomisticTraceUnavailable) {
    if (!backboneColors.has(key)) backbone.set(key, { kind: 'unavailable' });
  }
  for (const key of backboneUnavailable) backbone.set(key, { kind: 'unavailable' });
  const alphaCarbon = new Map<string, StructureColoration>();
  for (const [key, values] of alphaCarbonColors) alphaCarbon.set(key, colorationFromColors(values));
  for (const key of alphaCarbonUnavailable) alphaCarbon.set(key, { kind: 'unavailable' });
  return { all, backbone, alphaCarbon, atomicDetail };
}

export function resolveStructureColors(plugin: unknown): ReadonlyMap<string, StructureColoration> {
  return resolveStructureColorProjection(plugin).all;
}

export function resolveStructureColorLegends(plugin: unknown): readonly StructureThemeLegend[] {
  const context = plugin as PluginContext | null;
  const legends = new Map<string, StructureThemeLegend>();
  for (const structure of context?.managers?.structure?.hierarchy?.current?.structures ?? []) {
    for (const component of structure.components ?? []) {
      for (const ref of component.representations ?? []) {
        if (ref.cell.params?.values.colorTheme?.name === 'element-symbol') continue;
        const representation = ref.cell.obj?.data.repr;
        if (
          !representation?.state.visible ||
          representation.state.alphaFactor === 0 ||
          representation.props.alpha === 0 ||
          representation.state.overpaint?.layers.length
        )
          continue;
        const legend = representation.theme.color.legend;
        if (!legend) continue;
        if (
          legend.kind === 'table-legend' &&
          legend.table.length === 1 &&
          legend.table[0][0].toLowerCase() === 'uniform'
        )
          continue;
        legends.set(JSON.stringify(legend), {
          themeName: String(ref.cell.params?.values.colorTheme?.name ?? ''),
          legend,
        });
      }
    }
  }
  return [...legends.values()];
}

export function observeStructureColorChanges(plugin: unknown, onChange: () => void): () => void {
  const context = plugin as PluginContext | null;
  const state = context?.state?.data;
  if (!state) return () => {};
  let disposed = false;
  let queued = false;
  const representationSubscriptions = new Map<NativeRepresentation, Subscription>();
  const schedule = () => {
    if (queued || disposed) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (disposed || state.behaviors.isUpdating.value) return;
      bindRepresentations();
      onChange();
    });
  };
  const bindRepresentations = () => {
    const current = new Set<NativeRepresentation>();
    for (const structure of context!.managers.structure.hierarchy.current.structures) {
      for (const component of structure.components) {
        for (const ref of component.representations) {
          const representation = ref.cell.obj?.data.repr;
          if (!representation) continue;
          current.add(representation);
          if (!representationSubscriptions.has(representation)) {
            representationSubscriptions.set(
              representation,
              representation.updated.subscribe(schedule)
            );
          }
        }
      }
    }
    for (const [representation, subscription] of representationSubscriptions) {
      if (!current.has(representation)) {
        subscription.unsubscribe();
        representationSubscriptions.delete(representation);
      }
    }
  };
  bindRepresentations();
  const listeners = externalColorChangeListeners.get(context!) ?? new Set<() => void>();
  listeners.add(schedule);
  externalColorChangeListeners.set(context!, listeners);
  const subscriptions = [
    state.events.changed.subscribe(schedule),
    state.events.cell.stateUpdated.subscribe(schedule),
    state.behaviors.isUpdating.subscribe((updating) => {
      if (!updating) schedule();
    }),
  ];
  return () => {
    disposed = true;
    listeners.delete(schedule);
    for (const subscription of subscriptions) subscription.unsubscribe();
    for (const subscription of representationSubscriptions.values()) subscription.unsubscribe();
  };
}

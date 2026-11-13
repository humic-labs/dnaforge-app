import { OrderedSet } from 'molstar/lib/mol-data/int';
import { Structure, StructureElement, Unit } from 'molstar/lib/mol-model/structure';
import type { PluginContext } from 'molstar/lib/mol-plugin/context';
import type { Representation } from 'molstar/lib/mol-repr/representation';
import type { Transparency } from 'molstar/lib/mol-theme/transparency';
import { extractEffectiveChainInfo } from '../utils/molstarChainUtils';
import {
  chainInstanceIdForIdentity,
  nativeStructureSources,
  type NativeStructureSourceScope,
} from '../utils/structureIds';
import { effectiveRepresentationStructures, notifyStructureColorChanges } from './structureColors';

type NativeRepresentation = Representation.Any;
type AppliedVisibility = {
  original: Transparency;
  originalStrength: number;
  originalVisible: boolean;
  fullyHidden: boolean;
  applied: Transparency;
  signature: string;
  sources: readonly Structure[];
};

const appliedVisibility = new WeakMap<NativeRepresentation, AppliedVisibility>();

export function hiddenChainLoci(
  structure: StructureElement.Loci['structure'],
  hiddenChainInstanceIds: ReadonlySet<string>,
  sourceScope: NativeStructureSourceScope = {}
): StructureElement.Loci | null {
  const elements: StructureElement.Loci['elements'][number][] = [];
  for (const unit of structure.units) {
    if (!Unit.isAtomic(unit)) continue;
    const chains = unit.model.atomicHierarchy.chains;
    const chainIds = new Map<number, string>();
    const indices: number[] = [];
    for (let index = 0; index < unit.elements.length; index++) {
      const chainIndex = unit.chainIndex[unit.elements[index]];
      let id = chainIds.get(chainIndex);
      if (id === undefined) {
        const chain = extractEffectiveChainInfo(unit, chains, chainIndex);
        id = chain
          ? chainInstanceIdForIdentity({
              chainId: chain.effectiveChainId,
              authAsymId: chain.authAsymId,
              labelAsymId: chain.labelAsymId,
              entityId: chain.entityId,
              operator: chain.operator,
              instanceId: chain.instanceId,
              ...sourceScope,
            })
          : '';
        chainIds.set(chainIndex, id);
      }
      if (hiddenChainInstanceIds.has(id)) indices.push(index);
    }
    if (indices.length)
      elements.push({
        unit,
        indices: OrderedSet.ofSortedArray(
          indices
        ) as StructureElement.Loci['elements'][number]['indices'],
      });
  }
  return elements.length ? StructureElement.Loci(structure, elements) : null;
}

export function applyNativeChainVisibility(
  plugin: unknown,
  hiddenChainInstanceIds: readonly string[]
): boolean {
  const context = plugin as PluginContext | null;
  if (!context) return false;
  const hidden = new Set(hiddenChainInstanceIds);
  const signature = [...hidden].sort().join('|');
  let changed = false;
  for (const structure of nativeStructureSources(context)) {
    const sourceScope = {
      structureRef: structure.structureRef,
      isPrimarySource: structure.isPrimarySource,
    };
    for (const component of structure.entry.components ?? []) {
      const source = component.cell.obj?.data;
      if (!source) continue;
      const hiddenLoci = hidden.size ? hiddenChainLoci(source, hidden, sourceScope) : null;
      for (const ref of component.representations ?? []) {
        const representation = ref.cell.obj?.data.repr;
        if (!representation) continue;
        const sources = effectiveRepresentationStructures(representation, source);
        let drawn = Structure.toStructureElementLoci(source);
        if (!sources.includes(source)) {
          let nativeDrawn = StructureElement.Loci.none(source);
          for (const scope of sources)
            nativeDrawn = StructureElement.Loci.union(
              nativeDrawn,
              Structure.toSubStructureElementLoci(source, scope)
            );
          drawn = StructureElement.Loci.intersect(drawn, nativeDrawn);
        }
        let loci: StructureElement.Loci | null = null;
        if (hiddenLoci) {
          const masked = StructureElement.Loci.intersect(hiddenLoci, drawn);
          if (!StructureElement.Loci.isEmpty(masked)) loci = masked;
        }
        let previous = appliedVisibility.get(representation);
        if (previous && representation.state.transparency !== previous.applied) {
          previous = undefined;
          appliedVisibility.delete(representation);
        }
        if (!loci) {
          if (!previous) continue;
          representation.setState({
            visible:
              previous.originalVisible &&
              !ref.cell.state?.isHidden &&
              !component.cell.state?.isHidden,
            transparency: previous.original,
            themeStrength: {
              ...representation.state.themeStrength,
              transparency: previous.originalStrength,
            },
          });
          appliedVisibility.delete(representation);
          changed = true;
          continue;
        }
        const drawnAtomCount = StructureElement.Loci.size(drawn);
        const fullyHidden =
          drawnAtomCount > 0 && StructureElement.Loci.size(loci) === drawnAtomCount;
        if (
          previous?.signature === signature &&
          previous.fullyHidden === fullyHidden &&
          (!fullyHidden || representation.state.visible === false) &&
          previous.sources.length === sources.length &&
          previous.sources.every((scope, index) => scope === sources[index])
        )
          continue;
        const original = previous?.original ?? representation.state.transparency;
        const originalStrength =
          previous?.originalStrength ?? representation.state.themeStrength.transparency;
        const originalVisible = previous?.originalVisible ?? representation.state.visible;
        const applied: Transparency = fullyHidden
          ? original
          : {
              kind: 'element-loci',
              layers: [...original.layers, { loci, value: 1 }],
            };
        representation.setState({
          visible: fullyHidden ? false : originalVisible,
          transparency: applied,
          themeStrength: {
            ...representation.state.themeStrength,
            transparency: fullyHidden ? originalStrength : 1,
          },
        });
        appliedVisibility.set(representation, {
          original,
          originalStrength,
          originalVisible,
          fullyHidden,
          applied,
          signature,
          sources,
        });
        changed = true;
      }
    }
  }
  if (changed) {
    context.canvas3d?.requestDraw();
    notifyStructureColorChanges(context);
  }
  return changed;
}

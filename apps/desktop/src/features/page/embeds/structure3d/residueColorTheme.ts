import type { ColorScaleConfig, ResidueColorLayer } from './types';

import { Structure, StructureSelection } from 'molstar/lib/mol-model/structure';
import { Script } from 'molstar/lib/mol-script/script';
import { MolScriptBuilder as MS } from 'molstar/lib/mol-script/language/builder';
import { Color } from 'molstar/lib/mol-util/color';
import { Bundle } from 'molstar/lib/mol-model/structure/structure/element/bundle';
import { StateTransforms } from 'molstar/lib/mol-plugin-state/transforms';
import { isQueryPolymerComponentLabel } from './molstar/componentLabels';

type ResidueColorPlugin = {
  managers?: {
    structure?: {
      hierarchy?: {
        current?: {
          structures?: ReadonlyArray<{
            cell?: { obj?: { data?: unknown } };
            components?: unknown;
          }>;
        };
      };
    };
  };
  state: {
    data: {
      build: () => {
        to: (ref: string) => {
          update: (params: unknown) => unknown;
          apply: (transform: unknown, params: unknown) => unknown;
        };
        delete: (ref: unknown) => unknown;
        commit: () => Promise<unknown>;
      };
      select: (ref: string) => Array<{ transform?: { transformer?: { id?: string } } } | undefined>;
      tree: { children: { get: (ref: string) => unknown } };
      cells: {
        get: (ref: unknown) => { transform?: { transformer?: { id?: string } } } | undefined;
      };
    };
  };
};

type AtomicUnitLike = {
  model?: {
    atomicHierarchy?: {
      residues?: { label_seq_id?: { value: (index: number) => number } };
    };
  };
  elements: ArrayLike<number>;
  residueIndex: ArrayLike<number>;
};

function atomicUnitsFromStructureData(data: unknown): AtomicUnitLike[] {
  if (!data || typeof data !== 'object' || !('units' in data)) return [];
  const units = (data as { units?: unknown }).units;
  if (!Array.isArray(units)) return [];
  return units.filter((unit): unit is AtomicUnitLike => {
    if (!unit || typeof unit !== 'object') return false;
    return 'elements' in unit && 'residueIndex' in unit;
  });
}

function iterateUnknown(value: unknown): unknown[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'object' && Symbol.iterator in value) {
    return Array.from(value as Iterable<unknown>);
  }
  return [];
}

type PolymerComponentLike = {
  cell?: { obj?: { label?: string } };
  representations?: Array<{ cell?: { transform?: { ref?: string } } }>;
};

function polymerComponentsOf(structure: { components?: unknown }): PolymerComponentLike[] {
  return iterateUnknown(structure.components).filter((entry): entry is PolymerComponentLike => {
    if (!entry || typeof entry !== 'object') return false;
    const label = (entry as PolymerComponentLike).cell?.obj?.label || '';
    return isQueryPolymerComponentLabel(label);
  });
}

function lerpColor(c1: number, c2: number, t: number): number {
  const r1 = (c1 >> 16) & 0xff;
  const g1 = (c1 >> 8) & 0xff;
  const b1 = c1 & 0xff;

  const r2 = (c2 >> 16) & 0xff;
  const g2 = (c2 >> 8) & 0xff;
  const b2 = c2 & 0xff;

  const r = Math.round(r1 + (r2 - r1) * t);
  const g = Math.round(g1 + (g2 - g1) * t);
  const b = Math.round(b1 + (b2 - b1) * t);

  return (r << 16) | (g << 8) | b;
}

function interpolateColors(colors: number[], t: number): number {
  if (colors.length === 0) return 0x888888;
  if (colors.length === 1) return colors[0];
  if (t <= 0) return colors[0];
  if (t >= 1) return colors[colors.length - 1];

  const segments = colors.length - 1;
  const segment = Math.min(Math.floor(t * segments), segments - 1);
  const localT = t * segments - segment;

  return lerpColor(colors[segment], colors[segment + 1], localT);
}

export function mapValueToColor(
  value: number,
  domain: [number, number],
  scale: ColorScaleConfig
): number {
  const [min, max] = domain;

  if (scale.type === 'discrete' && scale.breakpoints && scale.breakpoints.length > 0) {
    for (let i = 0; i < scale.breakpoints.length; i++) {
      if (value < scale.breakpoints[i]) {
        return scale.colors[i] ?? scale.colors[0];
      }
    }
    return scale.colors[scale.colors.length - 1] ?? scale.colors[0];
  }

  const t = Math.max(0, Math.min(1, (value - min) / (max - min)));
  return interpolateColors(scale.colors, t);
}

export const DEFAULT_NO_DATA_COLOR = 0x888888;

export function createColorLookup(layer: ResidueColorLayer): (residueNum: number) => number {
  const { values, domain, colorScale } = layer;

  return (residueNum: number): number => {
    const value = values[residueNum];
    if (value === undefined) return DEFAULT_NO_DATA_COLOR;
    return mapValueToColor(value, domain, colorScale);
  };
}

export async function applyResidueColorLayer(
  plugin: unknown,
  layer: ResidueColorLayer
): Promise<boolean> {
  const typed = plugin as ResidueColorPlugin | null | undefined;
  if (!typed?.managers?.structure?.hierarchy) return false;
  const stateData = typed.state?.data;
  if (!stateData) return false;

  try {
    const structures = typed.managers.structure.hierarchy.current?.structures;
    if (!structures || structures.length === 0) return false;

    const colorLookup = createColorLookup(layer);

    for (const structure of structures) {
      if (!structure.cell?.obj?.data) continue;

      const structureData = structure.cell.obj.data;

      const residueColors = new Map<number, number>();
      const units = atomicUnitsFromStructureData(structureData);

      for (const unit of units) {
        if (!unit.model?.atomicHierarchy?.residues) continue;
        const residues = unit.model.atomicHierarchy.residues;
        const seqIds = residues.label_seq_id;
        if (!seqIds) continue;

        const seenResidues = new Set<number>();
        for (let i = 0; i < unit.elements.length; i++) {
          const residueIndex = unit.residueIndex[unit.elements[i]];
          const seqId = seqIds.value(residueIndex);
          if (!seenResidues.has(seqId)) {
            seenResidues.add(seqId);
            if (!residueColors.has(seqId)) {
              residueColors.set(seqId, colorLookup(seqId));
            }
          }
        }
      }

      const colorGroups = new Map<number, number[]>();
      for (const [residueNum, color] of residueColors) {
        if (color === DEFAULT_NO_DATA_COLOR) continue;
        if (!colorGroups.has(color)) {
          colorGroups.set(color, []);
        }
        colorGroups.get(color)!.push(residueNum);
      }

      const polymerComponents = polymerComponentsOf(structure);

      if (polymerComponents.length === 0) return false;

      const overpaintLayers: {
        bundle: ReturnType<typeof Bundle.fromLoci>;
        color: ReturnType<typeof Color>;
        clear: boolean;
      }[] = [];

      for (const [colorHex, residueNums] of colorGroups) {
        try {
          const expression = MS.struct.generator.atomGroups({
            'residue-test': MS.core.set.has([
              MS.set(...residueNums),
              MS.struct.atomProperty.macromolecular.label_seq_id(),
            ]),
          });

          const selection = Script.getStructureSelection(expression, structureData as Structure);
          const loci = StructureSelection.toLociWithSourceUnits(selection);

          if (loci.elements && loci.elements.length > 0) {
            const bundle = Bundle.fromLoci(loci);
            overpaintLayers.push({
              bundle,
              color: Color(colorHex),
              clear: false,
            });
          }
        } catch {}
      }

      if (overpaintLayers.length === 0) return false;

      for (const component of polymerComponents) {
        const representations = component.representations || [];
        for (const repr of representations) {
          if (!repr.cell?.transform?.ref) continue;

          try {
            const update = stateData.build();

            const reprState = stateData.select(repr.cell.transform.ref)[0];
            if (!reprState) continue;

            const children = stateData.tree.children.get(repr.cell.transform.ref);
            let overpaintRef: string | null = null;
            if (children) {
              for (const childRef of iterateUnknown(children)) {
                if (typeof childRef !== 'string') continue;
                const child = stateData.cells.get(childRef);
                const id = child?.transform?.transformer?.id || '';
                if (id.includes('overpaint-structure-representation-3d-from-bundle')) {
                  overpaintRef = childRef;
                  break;
                }
              }
            }

            if (overpaintRef) {
              update.to(overpaintRef).update({ layers: overpaintLayers });
            } else {
              update
                .to(repr.cell.transform.ref)
                .apply(
                  StateTransforms.Representation.OverpaintStructureRepresentation3DFromBundle,
                  { layers: overpaintLayers }
                );
            }

            await update.commit();
          } catch {}
        }
      }
    }

    return true;
  } catch {
    return false;
  }
}

export async function clearResidueColorLayer(plugin: unknown): Promise<void> {
  const typed = plugin as ResidueColorPlugin | null | undefined;
  if (!typed?.managers?.structure?.hierarchy) return;
  const stateData = typed.state?.data;
  if (!stateData) return;

  try {
    const structures = typed.managers.structure.hierarchy.current?.structures;
    if (!structures || structures.length === 0) return;

    for (const structure of structures) {
      const polymerComponents = polymerComponentsOf(structure);

      if (polymerComponents.length === 0) continue;

      for (const component of polymerComponents) {
        const representations = component.representations || [];
        for (const repr of representations) {
          if (!repr.cell?.transform?.ref) continue;

          try {
            const children = stateData.tree.children.get(repr.cell.transform.ref);
            if (children) {
              for (const childRef of iterateUnknown(children)) {
                const child = stateData.cells.get(childRef);
                const id = child?.transform?.transformer?.id || '';
                if (id.includes('overpaint-structure-representation-3d-from-bundle')) {
                  const update = stateData.build();
                  update.delete(childRef);
                  await update.commit();
                  break;
                }
              }
            }
          } catch {}
        }
      }
    }
  } catch (e) {
    console.warn('[ResidueColorTheme] Failed to clear residue color layer:', e);
  }
}

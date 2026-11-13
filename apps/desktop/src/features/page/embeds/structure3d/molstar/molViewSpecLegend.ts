import { structureScoreState, type StructureScoreContext } from '../utils/structureScoreState';
import {
  molViewSpecColorGroups,
  type MolViewSpecColorGroup,
} from '../../../../../shared/molecular-color-groups';
export {
  molViewSpecColorGroups,
  type MolViewSpecColorGroup,
  type SceneNode,
  isAnonymousGeneratedSurfaceSupplement,
  type MolViewSpecColorTarget,
  MVS_LEGEND_LABEL_KEY,
  colorValue,
  type MolViewSpecSwatch,
} from '../../../../../shared/molecular-color-groups';
import { ScaleLegend, TableLegend, type Legend } from 'molstar/lib/mol-util/legend';
import { Color } from 'molstar/lib/mol-util/color';
import type { Structure3dAttrs, StructureThemeLegend } from '../types';
import type { MolecularDataLayer } from '../utils/molecularData';

export const MAX_SWATCH_SECTORS = 6;

export function colorLegendsForMolViewSpecScene(
  scene: string | undefined,
  snapshotIndex: number,
  namedGroups?: readonly MolViewSpecColorGroup[]
): Legend[] {
  const groups = namedGroups ?? molViewSpecColorGroups(scene, snapshotIndex);
  return groups.length ? [TableLegend(groups.map(({ label, color }) => [label, color]))] : [];
}

export type ColorKey = { title: string; legend: Legend };

export function molecularDataKeyTitle(
  layer: Pick<MolecularDataLayer, 'column' | 'units' | 'style'>
): string {
  const qualifiers = [
    layer.units,
    layer.style.kind === 'continuous' && layer.style.transform === 'log10' ? 'log scale' : '',
  ].filter(Boolean);
  return qualifiers.length ? `${layer.column} (${qualifiers.join(', ')})` : layer.column;
}

function molecularDataColorKey(layer: MolecularDataLayer): ColorKey {
  const { style } = layer;
  return {
    title: molecularDataKeyTitle(layer),
    legend:
      style.kind === 'continuous'
        ? ScaleLegend(
            String(style.domain[0]),
            String(style.domain[1]),
            style.colors.map(Color.fromHexStyle)
          )
        : TableLegend(
            Object.entries(style.colors).map(([label, color]) => [label, Color.fromHexStyle(color)])
          ),
  };
}

export function colorKeysForThemes(
  themes: readonly StructureThemeLegend[],
  source: string | (StructureScoreContext & Pick<Structure3dAttrs, 'molecularData'>) | undefined
): ColorKey[] {
  const keys: ColorKey[] = themes.flatMap(({ themeName, legend }) => {
    const title =
      themeName === 'plddt-confidence'
        ? 'pLDDT'
        : themeName === 'uncertainty'
          ? structureScoreState(source).label
          : null;
    return title ? [{ title, legend }] : [];
  });
  const data = typeof source === 'object' ? source.molecularData : undefined;
  const layer = data?.layers.find(({ id }) => id === data.activeLayerId);
  return layer ? [...keys, molecularDataColorKey(layer)] : keys;
}

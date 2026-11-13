import type { StructureScoreContext } from '../utils/structureScoreState';
import type { Structure3dColorMode } from '../types';
import { getColorOptions } from '../utils/structureScoreState';
type SceneNode = {
  kind: string;
  params?: Record<string, unknown>;
  custom?: Record<string, unknown>;
  children?: SceneNode[];
};
type Scene = { root?: SceneNode; snapshots?: Array<{ root: SceneNode }> };
const themes = {
  chain: 'chain-id',
  element: 'element-symbol',
  bfactor: 'uncertainty',
  confidence: 'plddt-confidence',
} as const;
export type SceneColorMode = keyof typeof themes;
const sceneModeByColorMode: Partial<Record<Structure3dColorMode, SceneColorMode>> = {
  chain: 'chain',
  element: 'element',
  bfactor: 'bfactor',
  plddt: 'confidence',
};

export function sceneColorOptions(
  source: string | StructureScoreContext
): { mode: SceneColorMode; label: string }[] {
  return getColorOptions(source).flatMap(({ value, label }) => {
    const mode = sceneModeByColorMode[value];
    return mode ? [{ mode, label }] : [];
  });
}
const colorKinds = ['color', 'color_from_uri', 'color_from_source'];
const legendKeys = [
  'dnaforge_legend_label',
  'dnaforge_legend_generated',
  'dnaforge_display_group_id',
  'dnaforge_display_group_color',
  'dnaforge_binding_scope',
] as const;

function legendIdentity(representation: SceneNode, colors: SceneNode[]): Record<string, unknown> {
  const designated = colors.find(
    (color) => typeof color.custom?.dnaforge_legend_label === 'string'
  );
  if (designated)
    return Object.fromEntries(
      legendKeys.flatMap((key) =>
        designated.custom?.[key] === undefined ? [] : [[key, designated.custom[key]]]
      )
    );
  const group = representation.custom?.dnaforge_display_group as
    | { label?: unknown; id?: unknown }
    | undefined;
  return typeof group?.label === 'string'
    ? {
        dnaforge_legend_label: group.label,
        ...(typeof group.id === 'string' ? { dnaforge_display_group_id: group.id } : {}),
      }
    : {};
}

function representations(scene: Scene, index: number): SceneNode[] {
  const root = scene.snapshots ? scene.snapshots[index]?.root : scene.root;
  if (!root) throw new Error('The selected scene is unavailable.');
  const pending = [root],
    result: SceneNode[] = [];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.kind === 'representation') result.push(node);
    pending.push(...(node.children ?? []));
  }
  return result;
}

export function recolorStructureScene(scene: string, index: number, mode: SceneColorMode): string {
  const document = JSON.parse(scene) as Scene;
  if (!themes[mode]) throw new Error('Unknown structure color mode.');
  const nodes = representations(document, index);
  if (!nodes.length) throw new Error('The selected scene has no molecular representations.');
  for (const node of nodes) {
    const legend = legendIdentity(
      node,
      (node.children ?? []).filter((child) => colorKinds.includes(child.kind))
    );
    node.children = (node.children ?? []).filter((child) => !colorKinds.includes(child.kind));
    node.children.unshift({
      kind: 'color',
      params: { color: '#3388ff' },
      custom: {
        molstar_color_theme_name: themes[mode],
        ...(mode === 'element'
          ? { molstar_color_theme_params: { carbonColor: { name: 'element-symbol', params: {} } } }
          : {}),
        ...legend,
      },
    });
  }
  return JSON.stringify(document);
}

export function structureSceneColorMode(scene: string, index: number): SceneColorMode | '' {
  try {
    const nodes = representations(JSON.parse(scene) as Scene, index);
    for (const [mode, theme] of Object.entries(themes)) {
      if (
        nodes.length &&
        nodes.every((node) => {
          const colors = (node.children ?? []).filter((child) => colorKinds.includes(child.kind));
          return colors.length === 1 && colors[0].custom?.molstar_color_theme_name === theme;
        })
      )
        return mode as SceneColorMode;
    }
  } catch {}
  return '';
}

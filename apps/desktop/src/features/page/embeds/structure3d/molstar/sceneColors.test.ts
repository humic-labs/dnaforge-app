import { describe, it, expect } from 'vitest';
import { recolorStructureScene, structureSceneColorMode } from './sceneColors';
import {
  ElementSymbolColorTheme,
  ElementSymbolColorThemeParams,
} from 'molstar/lib/mol-theme/color/element-symbol';
import { ParamDefinition } from 'molstar/lib/mol-util/param-definition';
import { DISPLAY_GROUP_CONTRACT, requireMolecularDisplayGroups } from './molecularDisplayGroups';
describe('canonical scene coloring', () => {
  const root = {
    kind: 'root',
    children: [
      { kind: 'camera', params: { position: [10, 0, 0], target: [0, 0, 0], up: [0, 1, 0] } },
      {
        kind: 'download',
        params: { url: 'exact.cif' },
        children: [
          {
            kind: 'component',
            params: { selector: { label_asym_id: 'A' } },
            children: [
              {
                kind: 'representation',
                params: { type: 'cartoon' },
                children: [
                  { kind: 'opacity', params: { opacity: 0.25 } },
                  { kind: 'color', params: { color: '#ff0000' } },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  it('changes colors without replacing the authored selections, coordinates, geometry or camera', () => {
    const original = JSON.stringify({ root });
    const next = recolorStructureScene(original, 0, 'chain');
    expect(structureSceneColorMode(original, 0)).toBe('');
    expect(structureSceneColorMode(next, 0)).toBe('chain');
    const changed = JSON.parse(next);
    expect(changed.root.children[0]).toEqual(root.children[0]);
    expect(changed.root.children[1].params).toEqual({ url: 'exact.cif' });
    expect(changed.root.children[1].children[0].params).toEqual({
      selector: { label_asym_id: 'A' },
    });
    expect(changed.root.children[1].children[0].children[0].children).toContainEqual({
      kind: 'opacity',
      params: { opacity: 0.25 },
    });
  });
  it('keeps a designated scene saveable after a color change ', () => {
    type Node = {
      kind: string;
      params?: Record<string, unknown>;
      custom?: Record<string, unknown>;
      children?: Node[];
    };
    const at = (node: Node, index: number): Node => {
      const child = node.children?.[index];
      if (!child) throw new Error(`Missing child ${index} of ${node.kind}`);
      return child;
    };
    const designated: Node = structuredClone(root);
    designated.custom = { dnaforge_display_group_contract: DISPLAY_GROUP_CONTRACT };
    const representation = at(at(at(designated, 1), 0), 0);
    representation.custom = {
      dnaforge_display_group: { label: 'Chain A', color: '#ff0000', id: 'chain-a' },
    };
    at(representation, 1).custom = {
      dnaforge_legend_label: 'Chain A',
      dnaforge_display_group_id: 'chain-a',
    };
    const scene = JSON.stringify({ root: designated });
    expect(() => requireMolecularDisplayGroups(JSON.parse(scene))).not.toThrow();
    const next = recolorStructureScene(scene, 0, 'element');
    expect(() => requireMolecularDisplayGroups(JSON.parse(next))).not.toThrow();
    expect(structureSceneColorMode(next, 0)).toBe('element');
    const recolored: Node = JSON.parse(next).root;
    expect(at(at(at(recolored, 1), 0), 0).children).toContainEqual({
      kind: 'color',
      params: { color: '#3388ff' },
      custom: {
        molstar_color_theme_name: 'element-symbol',
        molstar_color_theme_params: { carbonColor: { name: 'element-symbol', params: {} } },
        dnaforge_legend_label: 'Chain A',
        dnaforge_display_group_id: 'chain-a',
      },
    });
  });
  it('only recolors the selected story step and refuses an absent step', () => {
    const scene = JSON.stringify({ kind: 'multiple', snapshots: [{ root }, { root }] });
    const next = recolorStructureScene(scene, 1, 'element');
    expect(JSON.parse(next).snapshots[0]).toEqual({ root });
    expect(structureSceneColorMode(next, 1)).toBe('element');
    expect(() => recolorStructureScene(scene, 2, 'chain')).toThrow('unavailable');
  });
  it('authors element coloring independently of context-sensitive carbon chain palettes', () => {
    const scene = JSON.parse(recolorStructureScene(JSON.stringify({ root }), 0, 'element'));
    const color = scene.root.children[1].children[0].children[0].children[0];
    const params = ParamDefinition.merge(
      ElementSymbolColorThemeParams,
      ParamDefinition.getDefaultValues(ElementSymbolColorThemeParams),
      color.custom.molstar_color_theme_params
    );
    const theme = ElementSymbolColorTheme({}, params);
    expect(theme.props.carbonColor).toEqual({ name: 'element-symbol', params: {} });
    expect(structureSceneColorMode(JSON.stringify(scene), 0)).toBe('element');
  });
});

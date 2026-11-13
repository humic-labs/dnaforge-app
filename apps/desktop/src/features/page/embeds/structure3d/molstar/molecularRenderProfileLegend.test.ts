import { describe, expect, it } from 'vitest';
import { MVSData } from 'molstar/lib/extensions/mvs/mvs-data';
import { resolveMolViewSpecRenderProfile } from './molecularRenderProfile';
import { molViewSpecColorGroups } from './molViewSpecLegend';

function scene(named: boolean) {
  const builder = MVSData.createBuilder();
  builder
    .download({ url: 'structure.cif' })
    .parse({ format: 'mmcif' })
    .modelStructure()
    .component({ selector: [{ label_asym_id: 'D' }, { label_asym_id: 'E' }] })
    .representation({
      type: 'ball_and_stick',
      custom: {
        dnaforge_carbon_color: '#33aabb',
        ...(named ? { dnaforge_legend_label: 'Attached glycans' } : {}),
      },
    });
  return resolveMolViewSpecRenderProfile(builder.getState());
}

describe('named molecular-profile groups', () => {
  it('uses the carbon hue as a semantic swatch and selects every atom in the exact component', () => {
    const groups = molViewSpecColorGroups(MVSData.toMVSJ(scene(true)), 0);
    expect(groups).toEqual([
      {
        id: `Attached glycans\u0000${0x33aabb}`,
        label: 'Attached glycans',
        color: 0x33aabb,
        structureCount: 1,
        selectable: true,
        targets: [
          {
            structureIndex: 0,
            structureRef: 'dnaforge:structure:root.0.0.0',
            componentSelector: [{ label_asym_id: 'D' }, { label_asym_id: 'E' }],
            colorSelector: 'all',
            laterColorSelectors: [],
          },
        ],
      },
    ]);
  });

  it('does not create generic element or uniform labels for default-colored representations', () => {
    expect(molViewSpecColorGroups(MVSData.toMVSJ(scene(false)), 0)).toEqual([]);
  });

  it('keeps unknown native themes and multilayer themes out of the semantic key', () => {
    const document = scene(true);
    if (document.kind === 'multiple') throw new Error('Expected one scene.');
    const representation =
      document.root.children![0].children![0].children![0].children![0].children![0];
    const unknownTheme = structuredClone(document);
    unknownTheme.root.children![0].children![0].children![0].children![0].children![0].children![0].custom!.molstar_color_theme_name =
      'chain-id';
    expect(molViewSpecColorGroups(MVSData.toMVSJ(unknownTheme), 0)).toEqual([]);
    representation.children!.push({
      kind: 'color',
      params: { color: '#ff5500', selector: { label_seq_id: 1 } },
    });
    expect(molViewSpecColorGroups(MVSData.toMVSJ(document), 0)).toEqual([]);
  });
});

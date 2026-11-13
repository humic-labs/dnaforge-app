import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Structure, StructureElement, StructureProperties } from 'molstar/lib/mol-model/structure';
import { PluginContext } from 'molstar/lib/mol-plugin/context';
import { DefaultPluginSpec } from 'molstar/lib/mol-plugin/spec';
import type { StructureRepresentation } from 'molstar/lib/mol-repr/structure/representation';
import { MolScriptBuilder as MS } from 'molstar/lib/mol-script/language/builder';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MolstarPlugin } from '../../page/public/embeds/structure3d/viewerCache';
import { representedSelectionCoverage } from './representedSelectionCoverage';

describe('cartoon coverage of the original 1FS0 chain G', () => {
  let chain: Structure;
  let polymer: Structure;
  let representation: StructureRepresentation;
  let plugin: MolstarPlugin;

  beforeAll(async () => {
    plugin = new PluginContext(DefaultPluginSpec());
    await plugin.init();
    const data = await plugin.builders.data.rawData({
      data: readFileSync(
        resolve(__dirname, '../../../../../../test-fixtures/structure-complexes/rcsb/1FS0.pdb'),
        'utf8'
      ),
      label: '1FS0',
    });
    const trajectory = await plugin.builders.structure.parseTrajectory(data, 'pdb');
    const model = await plugin.builders.structure.createModel(trajectory);
    const source = await plugin.builders.structure.createStructure(model, {
      name: 'model',
      params: {},
    });
    const component = await plugin.builders.structure.tryCreateComponentFromExpression(
      source,
      MS.struct.generator.atomGroups({
        'chain-test': MS.core.rel.eq([MS.struct.atomProperty.macromolecular.auth_asym_id(), 'G']),
      }),
      'chain-G'
    );
    if (!component?.obj) throw new Error('The original 1FS0 fixture has no chain G.');
    chain = component.obj.data;
    polymer = Structure.create(chain.units.filter((unit) => unit.polymerElements.length > 0));
    const represented = await plugin.builders.structure.representation.addRepresentation(
      component,
      {
        type: 'cartoon',
        typeParams: { visuals: ['polymer-trace'] },
      }
    );
    if (!represented.obj) throw new Error('The original 1FS0 cartoon did not build.');
    representation = represented.obj.data.repr;
  });

  afterAll(() => plugin?.dispose());

  it('does not count the 160 unrepresented water atoms as cartoon coverage', () => {
    expect(chain.elementCount).toBe(1875);
    expect(polymer.elementCount).toBe(1715);
    expect(
      representation.renderObjects.some((object) => object.values.drawCount.ref.value > 0)
    ).toBe(true);
    let polymerLocations = 0;
    let waterLocations = 0;
    representation.eachLocation((location) => {
      if (!StructureElement.Location.is(location)) return;
      if (StructureProperties.entity.type(location) === 'polymer') polymerLocations++;
      if (StructureProperties.entity.type(location) === 'water') waterLocations++;
    });
    expect(polymerLocations).toBeGreaterThan(0);
    expect(waterLocations).toBe(0);
    expect(representedSelectionCoverage(plugin, Structure.toStructureElementLoci(chain))).toEqual({
      selectedAtomCount: 1875,
      representedAtomCount: 1715,
    });
  });

  it('retains full logical coverage of the polymer drawn by the cartoon', () => {
    expect(representedSelectionCoverage(plugin, Structure.toStructureElementLoci(polymer))).toEqual(
      {
        selectedAtomCount: 1715,
        representedAtomCount: 1715,
      }
    );
  });
});

import { describe, expect, it } from 'vitest';
import { MVSData } from 'molstar/lib/extensions/mvs/mvs-data';
import { representationProps } from 'molstar/lib/extensions/mvs/load-helpers';
import { resolveMolecularHydrogenDisplay } from './molecularHydrogenDisplay';

function scene() {
  const builder = MVSData.createBuilder();
  builder
    .download({ url: 'structure.cif' })
    .parse({ format: 'mmcif' })
    .modelStructure()
    .component({ selector: 'all' })
    .representation({ type: 'ball_and_stick', ignore_hydrogens: false });
  const value = builder.getState();
  value.root.custom = {
    dnaforge_hydrogen_atoms: { version: 1, visibility: 'shown', userRequest: 'forged request' },
  };
  return value;
}

describe('native hydrogen display enforcement', () => {
  it('overrides upstream visible-by-default behavior and forged scene permission', () => {
    const original = scene();
    const atom = original.root.children![0].children![0].children![0].children![0].children![0];
    expect(representationProps(atom).type?.params.ignoreHydrogens).toBe(false);
    const result = resolveMolecularHydrogenDisplay(original, { kind: 'author' });
    if (result.kind === 'multiple') throw new Error('Expected one view');
    const resolved = result.root.children![0].children![0].children![0].children![0].children![0];
    expect(representationProps(resolved).type?.params).toMatchObject({
      ignoreHydrogens: true,
      ignoreHydrogensVariant: 'all',
    });
    expect(result.root.custom?.dnaforge_hydrogen_atoms).toBeUndefined();
    expect(atom.params).toMatchObject({ ignore_hydrogens: false });
  });
  it('records a host-authorized request and preserves the exception through saved replay', () => {
    const authored = resolveMolecularHydrogenDisplay(scene(), {
      kind: 'author',
      userRequest: 'Show hydrogen atoms',
    });
    const reopened = resolveMolecularHydrogenDisplay(JSON.parse(JSON.stringify(authored)), {
      kind: 'replay',
    });
    expect(reopened).toEqual(authored);
    if (reopened.kind === 'multiple') throw new Error('Expected one view');
    const atom = reopened.root.children![0].children![0].children![0].children![0].children![0];
    expect(representationProps(atom).type?.params.ignoreHydrogens).toBe(false);
  });
});

import { expect, it } from 'vitest';
import { CIF } from 'molstar/lib/mol-io/reader/cif';
import { trajectoryFromMmCIF } from 'molstar/lib/mol-model-formats/structure/mmcif';
import { Structure } from 'molstar/lib/mol-model/structure';
import { MVSData } from 'molstar/lib/extensions/mvs/mvs-data';
import { componentPropsFromSelector } from 'molstar/lib/extensions/mvs/load-helpers';
import { substructureFromSelector } from 'molstar/lib/extensions/mvs/components/selector';
import {
  constructPrimaryConformerDisplays,
  primaryMolecularConformer,
} from './molecularPrimaryConformer';

const cif = `data_alternatives
loop_
_entity.id
_entity.type
1 polymer
loop_
_struct_asym.id
_struct_asym.entity_id
A 1
loop_
_atom_site.group_PDB
_atom_site.id
_atom_site.type_symbol
_atom_site.label_atom_id
_atom_site.label_alt_id
_atom_site.label_comp_id
_atom_site.label_asym_id
_atom_site.label_entity_id
_atom_site.label_seq_id
_atom_site.Cartn_x
_atom_site.Cartn_y
_atom_site.Cartn_z
_atom_site.occupancy
_atom_site.B_iso_or_equiv
_atom_site.auth_seq_id
_atom_site.auth_comp_id
_atom_site.auth_asym_id
_atom_site.auth_atom_id
_atom_site.pdbx_PDB_model_num
ATOM 1 C CA . SER A 1 1 0 0 0 1 10 1 SER A CA 1
ATOM 2 C CB A SER A 1 1 1 0 0 0.9 10 1 SER A CB 1
ATOM 3 C CB B SER A 1 1 1 1 0 0.1 10 1 SER A CB 1
ATOM 4 O OG A SER A 1 1 2 0 0 0.2 10 1 SER A OG 1
ATOM 5 O OG B SER A 1 1 2 1 0 0.8 10 1 SER A OG 1
#
`;

it('requires a loaded coordinate source for atomic construction while allowing cartoon-only staging', () => {
  const document = (type: string) =>
    MVSData.fromMVSJ(
      JSON.stringify({
        kind: 'single',
        metadata: { version: '1' },
        root: {
          kind: 'root',
          children: [
            {
              kind: 'structure',
              ref: 'not-loaded',
              children: [
                {
                  kind: 'component',
                  params: { selector: 'all' },
                  children: [{ kind: 'representation', params: { type } }],
                },
              ],
            },
          ],
        },
      })
    );
  for (const type of ['ball_and_stick', 'spacefill', 'line']) {
    const original = document(type);
    expect(() => constructPrimaryConformerDisplays(original, () => undefined)).toThrow(
      /loaded coordinate source/i
    );
    expect(original).toEqual(document(type));
  }
  expect(() =>
    constructPrimaryConformerDisplays(document('cartoon'), () => undefined)
  ).not.toThrow();
});

it('shares one coherent occupancy-selected residue alternative with atomic displays, while preserving explicit alternatives and different-source overlays', async () => {
  const parsed = await CIF.parseText(cif).run();
  if (parsed.isError) throw new Error(parsed.message);
  const trajectory = await trajectoryFromMmCIF(parsed.result.blocks[0]).run();
  const source = Structure.ofModel(trajectory.representative);
  const root = { kind: 'root' };
  const selected = primaryMolecularConformer(source, root);
  expect(Array.from(selected.structure.units[0].elements)).toEqual([0, 1, 3]);
  expect(selected.receipt.excludedAtomCount).toBe(2);
  expect(source.elementCount).toBe(5);
  const component = {
    kind: 'component',
    params: { selector: 'all' },
    children: [{ kind: 'representation', params: { type: 'ball_and_stick' } }],
  };
  const document = MVSData.fromMVSJ(
    JSON.stringify({
      kind: 'single',
      metadata: { version: '1' },
      root: {
        kind: 'root',
        children: [
          { kind: 'structure', ref: 'reference', children: [structuredClone(component)] },
          { kind: 'structure', ref: 'compared', children: [structuredClone(component)] },
        ],
      },
    })
  );
  const resolved = constructPrimaryConformerDisplays(document, () => source);
  if (resolved.kind !== 'single') throw new Error('Expected single state');
  expect(resolved.root.children).toHaveLength(2);
  for (const structure of resolved.root.children ?? []) {
    const selector = structure.children?.[0].params?.selector;
    expect(
      substructureFromSelector(source, componentPropsFromSelector(selector as never)).elementCount
    ).toBe(3);
  }
  const comparison = {
    kind: 'root',
    custom: {
      dnaforge_conformer_comparison: {
        reason: 'Compare the deposited alternative side-chain positions.',
      },
    },
  };
  expect(primaryMolecularConformer(source, comparison).structure).toBe(source);
  resolved.root.custom = comparison.custom;
  const restored = constructPrimaryConformerDisplays(resolved, () => source);
  if (restored.kind !== 'single') throw new Error('Expected single state');
  for (const structure of restored.root.children ?? []) {
    const selector = structure.children?.[0].params?.selector;
    expect(
      substructureFromSelector(source, componentPropsFromSelector(selector as never)).elementCount
    ).toBe(5);
  }
  expect(() =>
    primaryMolecularConformer(source, {
      kind: 'root',
      custom: { dnaforge_conformer_comparison: { reason: ' ' } },
    })
  ).toThrow(/reason/i);
});

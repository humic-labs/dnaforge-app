import { molstarPluginFixture } from '@/test/fixtures/molstar-plugin';
import { expect, it } from 'vitest';
import { CIF } from 'molstar/lib/mol-io/reader/cif';
import { trajectoryFromMmCIF } from 'molstar/lib/mol-model-formats/structure/mmcif';
import { Structure } from 'molstar/lib/mol-model/structure';
import { ParamDefinition as PD } from 'molstar/lib/mol-util/param-definition';
import { BondType } from 'molstar/lib/mol-model/structure/model/types';
import {
  coordinationDepictionStructure,
  unsupportedIonicMetalCoordination,
} from './molecularCoordination';
import {
  NucleotideBallAndStickRepresentationProvider,
  registerMolecularRenderProfileVisuals,
} from './nucleotidePresentation';
import { readMolecularConnectionCoverage, readMolecularConnections } from './molecularConnections';
import type { MolstarPlugin } from './cache';
import { StructureRepresentationRegistry } from 'molstar/lib/mol-repr/structure/registry';
import { componentPropsFromSelector } from 'molstar/lib/extensions/mvs/load-helpers';
import { substructureFromSelector } from 'molstar/lib/extensions/mvs/components/selector';

const cif = `data_coordination
loop_
_entity.id
_entity.type
1 non-polymer
2 water
loop_
_struct_asym.id
_struct_asym.entity_id
A 1
B 2
C 1
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
_atom_site.pdbx_PDB_ins_code
_atom_site.Cartn_x
_atom_site.Cartn_y
_atom_site.Cartn_z
_atom_site.occupancy
_atom_site.B_iso_or_equiv
_atom_site.pdbx_formal_charge
_atom_site.auth_seq_id
_atom_site.auth_comp_id
_atom_site.auth_asym_id
_atom_site.auth_atom_id
_atom_site.pdbx_PDB_model_num
HETATM 1 K K . K A 1 . ? 0 0 0 1 10 1 1 K A K 1
HETATM 2 K K . K A 1 . ? 0 0 2.7 1 10 1 2 K A K 1
HETATM 3 O O . HOH B 2 . ? 2.7 0 0 1 10 0 3 HOH B O 1
HETATM 4 FE FE . FE C 1 . ? 10 0 0 1 10 0 4 FE C FE 1
HETATM 5 FE FE . FE C 1 . ? 12.5 0 0 1 10 0 5 FE C FE 1
loop_
_struct_conn.id
_struct_conn.conn_type_id
_struct_conn.ptnr1_label_asym_id
_struct_conn.ptnr1_label_comp_id
_struct_conn.ptnr1_label_seq_id
_struct_conn.ptnr1_label_atom_id
_struct_conn.ptnr1_auth_seq_id
_struct_conn.ptnr1_symmetry
_struct_conn.ptnr2_label_asym_id
_struct_conn.ptnr2_label_comp_id
_struct_conn.ptnr2_label_seq_id
_struct_conn.ptnr2_label_atom_id
_struct_conn.ptnr2_auth_seq_id
_struct_conn.ptnr2_symmetry
kk metalc A K . K 1 1_555 A K . K 2 1_555
ko metalc A K . K 1 1_555 B HOH . O 3 1_555
cluster metalc C FE . FE 4 1_555 C FE . FE 5 1_555
`;

it('filters unsupported ionic metal pairs from both native depictions while retaining source evidence, donors and transition-metal clusters', async () => {
  const parsed = await CIF.parseText(cif).run();
  if (parsed.isError) throw new Error(parsed.message);
  const trajectory = await trajectoryFromMmCIF(parsed.result.blocks[0]).run();
  const source = Structure.ofModel(trajectory.representative);
  const registry = new StructureRepresentationRegistry();
  registerMolecularRenderProfileVisuals({ representation: { structure: { registry } } } as never);
  const inventoryPlugin = (type: string): MolstarPlugin =>
    molstarPluginFixture({
      managers: {
        structure: {
          hierarchy: {
            current: {
              structures: [
                {
                  cell: { obj: { data: source } },
                  components: [
                    {
                      cell: { obj: { data: source } },
                      representations: [
                        {
                          cell: {
                            params: { values: { type: { name: type } } },
                            obj: {
                              data: {
                                repr: {
                                  state: { visible: true, alphaFactor: 1 },
                                  props: { alpha: 1, visuals: ['intra-bond', 'inter-bond'] },
                                },
                              },
                            },
                          },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        },
      },
    });
  const original = readMolecularConnections(inventoryPlugin('ball-and-stick'));
  expect(original.filter((c) => c.source === 'deposited-struct_conn')).toHaveLength(3);
  expect(original.filter((c) => c.kind === 'metal-coordination').every((c) => c.bondPresent)).toBe(
    true
  );
  const count = (s: Structure) =>
    s.units.reduce((n, u) => n + ('bonds' in u ? u.bonds.edgeCount : 0), 0) +
    s.interUnitBonds.edgeCount / 2;
  const sourceBondCount = count(source);
  const sanitized = coordinationDepictionStructure(source);
  expect(sanitized.elementCount).toBe(source.elementCount);
  expect(count(sanitized)).toBe(sourceBondCount - 1);
  expect(count(source)).toBe(sourceBondCount);
  expect(coordinationDepictionStructure(source)).toBe(sanitized);
  for (const type of ['ball-and-stick', 'line']) {
    const provider = registry.get(type);
    const props = PD.getDefaultValues(provider.getParams({} as never, source));
    expect(provider.getData!(source, props).elementCount).toBe(source.elementCount);
    expect(count(provider.getData!(source, props))).toBe(sourceBondCount - 1);
    const coverage = readMolecularConnectionCoverage(inventoryPlugin(type));
    const kk = coverage.find((c) => c.a.element === 'K' && c.b.element === 'K')!;
    expect(kk.source).toBe('deposited-struct_conn');
    expect(kk.status).toBe('suppressed-unsupported-coordination');
    expect(kk.depictionIssue).toBe('ionic-metal-to-metal');
    expect(coverage.find((c) => c.a.element === 'O' || c.b.element === 'O')!.status).toBe('drawn');
    expect(coverage.find((c) => c.a.element === 'FE' && c.b.element === 'FE')!.status).toBe(
      'drawn'
    );
  }
  const unit = source.units.find(
    (u) =>
      u.elements.length === 2 &&
      u.model.atomicHierarchy.atoms.type_symbol.value(u.elements[0]) === 'K'
  )!;
  expect(
    unsupportedIonicMetalCoordination(
      source,
      unit as never,
      0,
      unit as never,
      1,
      BondType.Names.covalent
    )
  ).toBe(false);
  const selected = substructureFromSelector(
    source,
    componentPropsFromSelector([{ label_asym_id: 'A' }, { label_asym_id: 'B' }])
  );
  const withContext = NucleotideBallAndStickRepresentationProvider.getData!(selected, {
    ...NucleotideBallAndStickRepresentationProvider.defaultValues,
    includeParent: true,
  });
  expect(withContext.child!.elementCount).toBe(selected.elementCount);
  expect(count(withContext)).toBe(sourceBondCount - 1);
});

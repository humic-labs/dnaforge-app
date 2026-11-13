import { CIF } from 'molstar/lib/mol-io/reader/cif';
import { trajectoryFromMmCIF } from 'molstar/lib/mol-model-formats/structure/mmcif';
import { Structure, Unit } from 'molstar/lib/mol-model/structure';
import type { ServiceFixture } from './molstar-plugin';

const parsed = await CIF.parseText(
  `data_unit_fixture
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
_atom_site.auth_seq_id
_atom_site.auth_comp_id
_atom_site.auth_asym_id
_atom_site.auth_atom_id
_atom_site.pdbx_PDB_model_num
ATOM 1 C CA . ALA A 1 1 0 0 0 1 1 ALA A CA 1
ATOM 2 C CA . ALA A 1 2 1 0 0 1 2 ALA A CA 1
`
).run();
if (parsed.isError) throw Error(parsed.message);
const model = (await trajectoryFromMmCIF(parsed.result.blocks[0]).run()).representative;
const template = Structure.ofModel(model).units[0];

export function atomicUnitFixture(services: ServiceFixture<Unit.Atomic>): Unit.Atomic {
  const unit = template.getCopy(template.id, template.invariantId, template.chainGroupId);
  if (!Unit.isAtomic(unit)) throw Error('The synthetic atom fixture is not atomic.');
  for (const [key, value] of Object.entries(services)) {
    Object.defineProperty(unit, key, {
      value,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }
  return unit;
}

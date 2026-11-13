import { z } from 'zod';

const identity = z.string().max(256);
const residueNumber = z.number().int();
const expression = z
  .object({
    label_entity_id: identity.optional(),
    label_asym_id: identity.optional(),
    auth_asym_id: identity.optional(),
    label_seq_id: residueNumber.optional(),
    auth_seq_id: residueNumber.optional(),
    pdbx_PDB_ins_code: identity.optional(),
    beg_label_seq_id: residueNumber.optional(),
    end_label_seq_id: residueNumber.optional(),
    beg_auth_seq_id: residueNumber.optional(),
    end_auth_seq_id: residueNumber.optional(),
    label_comp_id: identity.optional(),
    auth_comp_id: identity.optional(),
    residue_index: z.number().int().nonnegative().optional(),
    label_atom_id: identity.optional(),
    auth_atom_id: identity.optional(),
    type_symbol: identity.optional(),
    atom_id: z.number().int().optional(),
    atom_index: z.number().int().nonnegative().optional(),
    instance_id: identity.optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'An exact molecular selection needs at least one MVS expression field.',
  });

export const molecularExactSelectionSchema = z.union([
  expression,
  z.array(expression).min(1).max(512),
]);
export type MolecularExactSelection = z.infer<typeof molecularExactSelectionSchema>;

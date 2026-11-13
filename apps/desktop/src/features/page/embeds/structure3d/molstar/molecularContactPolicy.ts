import { z } from 'zod';

export const MOLECULAR_CONTACT_TYPES = [
  'ionic',
  'pi-stacking',
  'cation-pi',
  'halogen-bonds',
  'hydrogen-bonds',
  'weak-hydrogen-bonds',
  'hydrophobic',
  'metal-coordination',
] as const;
export const molecularContactTypesSchema = z
  .array(z.enum(MOLECULAR_CONTACT_TYPES))
  .min(1)
  .max(MOLECULAR_CONTACT_TYPES.length)
  .refine((types) => new Set(types).size === types.length, 'Contact types must be unique.');
export type MolecularContactType = (typeof MOLECULAR_CONTACT_TYPES)[number];

export const LEGACY_MOLECULAR_CONTACT_TYPES: readonly MolecularContactType[] = [
  'pi-stacking',
  'cation-pi',
  'halogen-bonds',
  'hydrogen-bonds',
  'metal-coordination',
];

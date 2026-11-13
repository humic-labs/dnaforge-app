export { surfaceOwnerSchema } from '../../../../../shared/molecular-surface-owner-contract';
import { z } from 'zod';

export const interfaceDetailSideSchema = z.enum(['target', 'partner', 'both']);
export const interfaceDetailBasisSchema = z.enum(['contacts', 'burial']);
export const interfaceProteinAtomicModeSchema = z.enum(['full-residue', 'sidechain-with-trace']);

const buriedSideSchema = z
  .object({
    selector: z.unknown().refine((value) => value !== undefined),
    buriedArea: z.number().nonnegative(),
    residueCount: z.number().int().nonnegative(),
    atomCount: z.number().int().nonnegative(),
  })
  .strict();
export const interfaceBurialSchema = z
  .object({
    contract: z.literal('native-molstar-interface-burial-v1'),
    parameters: z
      .object({
        probeSize: z.literal(1.4),
        numberOfSpherePoints: z.literal(92),
        nonPolymer: z.literal(true),
        traceOnly: z.literal(false),
      })
      .strict(),
    target: buriedSideSchema,
    partner: buriedSideSchema,
  })
  .strict();

export const bindingRegionSchema = z
  .object({
    target: z.unknown().refine((v) => v !== undefined),
    partner: z.unknown().refine((v) => v !== undefined),
    detail: z.unknown().optional(),
    seed: z.unknown().optional(),
    radius: z.number().min(1).max(20).optional(),
    surfaceSide: z.enum(['target', 'partner']).optional(),
    surfaceExtent: z.enum(['complete', 'contact-patch']).optional(),
    detailMode: z.enum(['neighborhood', 'contact-residues']).optional(),
    contactScope: z.literal('binding-boundary-v2').optional(),
    interfaceBurial: interfaceBurialSchema.optional(),
    interfaceDetailSide: interfaceDetailSideSchema.optional(),
    interfaceDetailBasis: interfaceDetailBasisSchema.optional(),
    interfaceProteinAtomicMode: interfaceProteinAtomicModeSchema.optional(),
    surfaceColorMode: z.enum(['identity', 'emphasis']).optional(),
  })
  .strict();

export type MolecularBindingIntent = z.infer<typeof bindingRegionSchema>;

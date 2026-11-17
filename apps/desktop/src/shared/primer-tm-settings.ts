import { z } from 'zod';
export const primerTmSettingsSchema = z
  .object({
    userSetting: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('local'),
          algorithm: z.enum(['santalucia98', 'santalucia-owczarzy']),
        })
        .strict(),
      z
        .object({
          kind: z.literal('neb'),
          prodcode: z.string().min(1).max(100),
          polymerase: z.enum(['q5', 'phusion', 'onetaq', 'taq', 'longamp']),
        })
        .strict(),
    ]),
    userSettingIsExplicit: z.boolean(),
    conditions: z
      .object({
        monovalentMm: z.number().finite().nonnegative(),
        divalentMm: z.number().finite().nonnegative(),
        dntpMm: z.number().finite().nonnegative(),
      })
      .strict(),
    concNm: z.number().finite().positive(),
  })
  .strict();
export type PrimerTmSettings = z.infer<typeof primerTmSettingsSchema>;

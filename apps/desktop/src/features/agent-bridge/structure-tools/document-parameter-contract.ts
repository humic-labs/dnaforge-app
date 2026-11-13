import { z } from 'zod';

export const molecularParameterEditSchema = z
  .object({
    path: z
      .string()
      .max(4096)
      .regex(
        /^\/(?:root|snapshots\/(?:0|[1-9]\d*)\/root)(?:\/children\/(?:0|[1-9]\d*))*\/params\/[A-Za-z_][A-Za-z0-9_]*$/
      ),
    value: z.union([
      z.string(),
      z.number().finite(),
      z.boolean(),
      z.null(),
      z.array(z.unknown()),
      z.record(z.unknown()),
    ]),
  })
  .strict();

export const molecularParameterEditsSchema = z.array(molecularParameterEditSchema).min(1).max(1000);

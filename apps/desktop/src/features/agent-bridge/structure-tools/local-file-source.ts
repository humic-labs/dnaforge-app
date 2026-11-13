import { z } from 'zod';

export const localStructureFileSourceSchema = z
  .object({
    kind: z.literal('file'),
    path: z
      .string()
      .min(1)
      .max(500)
      .describe(
        'Coordinate file path inside an open workspace: for example "1URN.cif" or "Data/1URN.cif". Use kind:"file", never a relative URL or file:// URL.'
      ),
  })
  .strict();

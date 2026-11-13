import { z } from 'zod';

export const surfaceOwnerSchema = z
  .object({
    regionRef: z.string().min(1),
    side: z.enum(['target', 'partner']),
  })
  .strict();

import { z } from 'zod';

export const searchPrimerMatchesSchema = z
  .object({
    workspace: z
      .string()
      .min(1)
      .optional()
      .describe('Project name; required when multiple projects are open.'),
    primerIds: z
      .array(z.string().min(1))
      .min(1)
      .max(48)
      .describe('Saved DNA primer IDs returned by get_primer or create_primer.'),
    targetDocumentIds: z
      .array(z.string().min(1))
      .min(1)
      .max(32)
      .describe(
        'Stable sequence document IDs, never paths. For genome-wide coverage select every supplied reference chromosome; a source locus window is not a whole-genome check.'
      ),
    maxEditDistance: z.number().int().min(0).max(10).default(0),
    maxMismatches: z.number().int().min(0).max(10).default(0),
    minThreePrimeMatchLength: z.number().int().min(0).max(100).default(18),
  })
  .strict();

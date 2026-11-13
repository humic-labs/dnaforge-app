import { z } from 'zod';

export const searchSkillsOutputSchema = z.object({
  ok: z.literal(true),
  query: z.string(),
  count: z.number().int().nonnegative(),
  matches: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      source: z.string(),
      revision: z.string().optional(),
      version: z.string().optional(),
      license: z.string().optional(),
      availableTo: z.string(),
      scope: z.string(),
      context: z.string(),
                                                                                                
      locator: z.string().regex(/^skill:\/\//u),
    })
  ),
});

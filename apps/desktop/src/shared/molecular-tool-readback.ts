import { z } from 'zod';

export const molecularDetailSchema = z
  .enum(['summary', 'full'])
  .describe('Summary by default. Request full for the previous detailed response.');

export const molecularChainPageSchema = z
  .object({
    offset: z.number().int().nonnegative().safe().optional(),
    limit: z.number().int().min(1).max(64).optional(),
  })
  .strict()
  .describe('Read a page of exact chain identities. Defaults to offset 0 and 16 chains.');

export const molecularChainPageOutputSchema = z.object({
  offset: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable(),
});

export function pageMolecularChains<T>(
  chains: readonly T[],
  query: z.infer<typeof molecularChainPageSchema>
) {
  const offset = query.offset ?? 0;
  const page = chains.slice(offset, offset + (query.limit ?? 16));
  return {
    chains: page,
    chainPage: {
      offset,
      nextOffset: offset + page.length < chains.length ? offset + page.length : null,
    },
  };
}

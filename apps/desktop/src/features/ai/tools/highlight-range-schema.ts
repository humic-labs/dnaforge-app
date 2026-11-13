import { z } from 'zod';

const highlightRegionSchema = z
  .object({
    start: z.number().int().min(1).describe('1-indexed inclusive start coordinate'),
    end: z.number().int().min(1).describe('1-indexed inclusive end coordinate'),
    wraps: z
      .boolean()
      .optional()
      .describe('true if the range wraps the origin of a circular sequence'),
  })
  .strict();

export const highlightRangeSchema = z
  .object({
    documentId: z
      .string()
      .describe('Stable package or catalog document ID of the sequence to highlight'),
    start: z.number().int().min(1).optional().describe('1-indexed inclusive start coordinate'),
    end: z.number().int().min(1).optional().describe('1-indexed inclusive end coordinate'),
    wraps: z
      .boolean()
      .optional()
      .describe('true if the range wraps the origin of a circular sequence'),
    regions: z
      .array(highlightRegionSchema)
      .optional()
      .describe(
        'DISJOINT regions to highlight — a discontiguous selection (e.g. a catalytic ' +
          'triad). Pass this INSTEAD of start/end when a selection descriptor has ' +
          'measured.disjoint:true; use its measured.regions coordinates. The sequence ' +
          'viewer highlights ONE range at a time, so this honestly highlights the FIRST ' +
          'region and reports that it degraded — it NEVER paints a single span covering ' +
          'the gaps between regions.'
      ),
  })
  .strict();

export type HighlightRangeInput = z.infer<typeof highlightRangeSchema>;
export type HighlightRegionInput = z.infer<typeof highlightRegionSchema>;

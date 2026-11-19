import { z } from 'zod';

export const molecularPresentationOverrideSchema = z
  .object({
    reason: z.string().trim().min(1).max(500),
    fields: z
      .array(
        z.enum([
          'nucleotideDetail',
          'nucleotideBackbone',
          'cartoonScale',
          'preservePolymerContext',
          'bindingSiteDetail',
          'bindingSiteSurface',
          'interfaceSurface',
          'comparisonPresentation',
        ])
      )
      .min(1),
  })
  .strict();

export const POLYMER_CONTEXT_OMISSION_GUIDANCE =
  'For an intentional omission, merge {"dnaforge_presentation_override":{"reason":"Expose the RNA contour where the protein would occlude it.","fields":["preservePolymerContext"]}} into custom on the affected view root. Use a scientific reason specific to the view.';

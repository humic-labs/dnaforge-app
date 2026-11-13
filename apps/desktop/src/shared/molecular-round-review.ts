import { z } from 'zod';

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const molecularRoundDecisionsSchema = z
  .object({
    systemPrompt: z.string().trim().min(1).max(8000),
    harness: z.string().trim().min(1).max(8000),
    guidance: z.string().trim().min(1).max(8000),
  })
  .strict();
export const molecularRoundReviewSchema = z
  .object({
    version: z.literal(1),
    reviewedAt: z.number().int().nonnegative(),
    corpusSha256: digestSchema,
    systemPromptSha256: digestSchema,
    runPlanSha256: digestSchema,
    decisions: molecularRoundDecisionsSchema,
    corpus: z
      .object({
        starts: z.number().int().nonnegative(),
        attempts: z.number().int().nonnegative(),
        incompleteStarts: z.number().int().nonnegative(),
        versions: z.number().int().nonnegative(),
        feedbackNotes: z.number().int().nonnegative(),
        unassessedRenderedSlots: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type MolecularRoundDecisions = z.infer<typeof molecularRoundDecisionsSchema>;
export type MolecularRoundReview = z.infer<typeof molecularRoundReviewSchema>;

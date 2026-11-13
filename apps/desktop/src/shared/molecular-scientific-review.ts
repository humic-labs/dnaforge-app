import { z } from 'zod';

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const statement = z.string().trim().min(1).max(4000);

export const molecularQuestionCoverageGuidance =
  'Before editing, identify the relationship or contrast the original question asks the viewer to understand. Make that relationship itself readable in the supplied geometry; use proposed causes and surrounding mechanisms as supporting evidence. In scientificReview.questionCoverage, record relationship, directEvidence:[{stepIndex,evidence}], supportingEvidence:[{stepIndex,evidence}] and unanswered:[requirements still absent or unreadable]. Use unanswered for an unmet requirement of the original question, not every scientific caveat. Put limits on what the coordinates or inference establish in the existing limitation fields. A limitation does not excuse omitting evidence that the question does require. Supporting evidence does not replace direct question evidence. If directEvidence is empty, unanswered must be nonempty. Each stepIndex refers to a final scene step; distinct evidence items may share a step. Keep an unanswered requirement explicit even when another part is shown. An honest incomplete artifact may be saved, but is not a completed trial. This accounting does not certify scientific correctness.';

const evidenceReference = z
  .object({
    stepIndex: z.number().int().nonnegative(),
    evidence: statement,
  })
  .strict();

export const molecularQuestionCoverageSchema = z
  .object({
    relationship: statement,
    directEvidence: z.array(evidenceReference),
    supportingEvidence: z.array(evidenceReference),
    unanswered: z.array(statement),
  })
  .strict()
  .refine((coverage) => coverage.directEvidence.length > 0 || coverage.unanswered.length > 0, {
    message: 'Record direct question evidence or an explicit unanswered requirement.',
  })
  .describe(molecularQuestionCoverageGuidance);

export const molecularScientificReviewInputSchema = z
  .object({
    version: z.literal(1),
    sceneDigestSha256: digestSchema,
    question: statement,
    questionCoverage: molecularQuestionCoverageSchema.optional(),
    steps: z
      .array(
        z
          .object({
            index: z.number().int().nonnegative(),
            screenshotReceiptId: z.string().uuid(),
            claim: statement,
            evidence: statement,
            limitation: statement,
            groups: z.array(
              z.object({ id: z.string().min(1), biologicalRole: statement }).strict()
            ),
          })
          .strict()
      )
      .min(1),
    continuity: z.object({ assessment: statement, limitation: statement }).strict(),
    revision: z
      .object({
        findings: z.array(statement),
        changes: z.array(statement),
        unresolved: z.array(statement),
      })
      .strict(),
  })
  .strict();

export const molecularScientificReviewScreenshotSchema = z
  .object({
    id: z.string().uuid(),
    sceneDigestSha256: digestSchema,
    index: z.number().int().nonnegative(),
    imageDigestSha256: digestSchema,
    cameraDigestSha256: digestSchema,
    stepCamera: z
      .object({
        target: z.tuple([z.number(), z.number(), z.number()]),
        position: z.tuple([z.number(), z.number(), z.number()]),
        up: z.tuple([z.number(), z.number(), z.number()]),
        near: z.number().optional(),
      })
      .strict(),
    capturedAt: z.number().int().nonnegative(),
  })
  .strict();

export const molecularScientificReviewSchema = molecularScientificReviewInputSchema.extend({
  savedSceneDigestSha256: digestSchema,
  screenshots: z.array(molecularScientificReviewScreenshotSchema).min(1),
});
export type MolecularScientificReview = z.infer<typeof molecularScientificReviewSchema>;
export type MolecularScientificReviewScreenshot = z.infer<
  typeof molecularScientificReviewScreenshotSchema
>;

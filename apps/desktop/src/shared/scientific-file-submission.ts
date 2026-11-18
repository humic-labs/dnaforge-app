import { z } from 'zod';

export const submitScientificChangesSchema = z
  .object({
    workspace: z
      .string()
      .min(1)
      .optional()
      .describe('Project name; required when multiple projects are open.'),
    expectedHead: z
      .string()
      .regex(/^wv_[0-9a-f]{64}$/)
      .nullable()
      .describe(
        'Exact accepted head returned by list_scientific_objects. Null is only for a project with no accepted history.'
      ),
    gitCommit: z
      .string()
      .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
      .optional()
      .describe(
        'Full immutable Git commit ID to submit instead of current working files. Branch names and HEAD are not accepted.'
      ),
    initializeEmptyNamespace: z.literal(true).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.initializeEmptyNamespace &&
      (value.expectedHead !== null || value.gitCommit !== undefined)
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Empty namespace setup requires a null head and no Git commit.',
      });
  });

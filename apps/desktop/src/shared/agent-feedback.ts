import { z } from 'zod';

export const AGENT_FEEDBACK_MAX_LENGTH = 2000;
const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine(
      // eslint-disable-next-line no-control-regex
      (value) => !/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(value),
      'Remove control characters.'
    );

const reportFields = z
  .object({
    observationId: z
      .string()
      .uuid()
      .describe(
        'A new UUID for each distinct observation, including a recurrence after an update. Reuse this exact UUID and evidence when retrying the same observation.'
      ),
    kind: z.enum(['bug', 'feedback']),
    summary: text(120),
    description: text(1200).describe(
      'Observed problem or feedback and the task you were trying to complete. Do not include private project contents or credentials.'
    ),
    reproductionSteps: z.array(text(300)).min(1).max(8).optional(),
    expected: text(600).optional().describe('Required for bugs: what should have happened.'),
    actual: text(600).optional().describe('Required for bugs: what you actually observed.'),
    impact: text(300).optional(),
    workaround: text(300).optional(),
    toolName: text(120).optional(),
    errorCode: text(120).optional(),
    correlationId: text(120).optional(),
    suspectedCause: text(300)
      .optional()
      .describe('An unconfirmed explanation, separate from observed evidence.'),
  })
  .strict();

export type AgentFeedbackInput = z.infer<typeof reportFields>;

export const agentFeedbackReceiptSchema = z
  .object({
    ok: z.literal(true),
    reportId: z.string().uuid(),
    status: z.literal('submitted'),
    duplicate: z.boolean(),
  })
  .strict();

export function formatAgentFeedback(input: AgentFeedbackInput): string {
  return [
    `[Agent ${input.kind === 'bug' ? 'bug report' : 'feedback'}] ${input.summary}`,
    input.description,
    ...(input.reproductionSteps
      ? [`Steps:\n${input.reproductionSteps.map((step, i) => `${i + 1}. ${step}`).join('\n')}`]
      : []),
    ...(
      [
        ['Expected', input.expected],
        ['Observed', input.actual],
        ['Impact', input.impact],
        ['Workaround', input.workaround],
        ['Tool', input.toolName],
        ['Error code', input.errorCode],
        ['Correlation ID', input.correlationId],
        ['Suspected cause (unconfirmed)', input.suspectedCause],
      ] as const
    ).flatMap(([label, value]) => (value ? [`${label}: ${value}`] : [])),
  ].join('\n\n');
}

export const agentFeedbackSchema = reportFields.superRefine((input, ctx) => {
  if (input.kind === 'bug') {
    for (const field of ['expected', 'actual'] as const) {
      if (!input[field])
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: 'Required for a bug report.',
        });
    }
  }
  if (formatAgentFeedback(input).length > AGENT_FEEDBACK_MAX_LENGTH) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'Keep the complete formatted report within 2000 characters. Summarize the relevant evidence.',
    });
  }
});

export type AgentFeedbackResult =
  | { ok: true; reportId: string; status: 'submitted'; duplicate: boolean }
  | {
      ok: false;
      code: string;
      error: string;
      retriable: boolean;
      stateChanged: boolean | 'unknown';
      partialEffects: string[];
      details?: { reportId?: string; retryAfterSeconds?: number };
    };

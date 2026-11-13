import { z } from 'zod';

export const HOSTED_GENERATION_WIRE_VERSION = 2 as const;
export const MAX_HOSTED_WHOLE_REQUEST_BYTES = 2 * 1024 * 1024;
export const HOSTED_REQUEST_SIZE_WARNING_BYTES = Math.floor(
  (MAX_HOSTED_WHOLE_REQUEST_BYTES * 3) / 4
);
export const MAX_HOSTED_GENERATE_REQUEST_BYTES = MAX_HOSTED_WHOLE_REQUEST_BYTES;
export const HOSTED_RESEARCH_CONTRIBUTION_NOTICE_TEXT =
  'DNAForge AI is offered in accordance with our Terms of Service and Privacy Policy.' as const;

const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const boundedVersion = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const HostedOpaqueIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const opaqueId = HostedOpaqueIdSchema;
const uuid = z.string().uuid();

function isJsonSerializable(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (ancestors.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((child) => isJsonSerializable(child, ancestors))
    : Object.values(value as Record<string, unknown>).every((child) =>
        isJsonSerializable(child, ancestors)
      );
  ancestors.delete(value);
  return valid;
}

function httpsUrlSchema() {
  return z
    .string()
    .url()
    .max(2_048)
    .refine((value) => new URL(value).protocol === 'https:', 'URL must use HTTPS');
}

export const HostedTierSchema = z.enum(['auto', 'deep']);
export type HostedTier = z.infer<typeof HostedTierSchema>;

const providerContinuityString = z.string().min(1).max(1_000_000);
const HostedAzureProviderMetadataSchema = z
  .object({
    azure: z
      .object({
        itemId: z.string().min(1).max(8_192).optional(),
        reasoningEncryptedContent: providerContinuityString.nullable().optional(),
        responseId: z.string().min(1).max(8_192).nullable().optional(),
        serviceTier: z.string().min(1).max(256).nullable().optional(),
      })
      .strict()
      .refine((value) => Object.keys(value).length > 0, 'Azure metadata cannot be empty'),
  })
  .strict();
const HostedOpenAiProviderMetadataSchema = z
  .object({
    openai: z
      .object({
        itemId: z.string().min(1).max(8_192).optional(),
        reasoningEncryptedContent: providerContinuityString.nullable().optional(),
      })
      .strict()
      .refine((value) => Object.keys(value).length > 0, 'OpenAI metadata cannot be empty'),
  })
  .strict();

export const HostedProviderMetadataSchema = z.union([
  HostedAzureProviderMetadataSchema,
  HostedOpenAiProviderMetadataSchema,
]);
export type HostedProviderMetadata = z.infer<typeof HostedProviderMetadataSchema>;

export const HostedTextPartSchema = z
  .object({
    type: z.literal('text'),
    text: z.string().max(1_000_000),
  })
  .strict();

export const HostedReasoningPartSchema = z
  .object({
    type: z.literal('reasoning'),
    text: z.string().max(1_000_000),
    providerOptions: HostedProviderMetadataSchema.optional(),
  })
  .strict();

export const HostedToolCallPartSchema = z
  .object({
    type: z.literal('tool-call'),
    toolCallId: opaqueId,
    toolName: opaqueId,
    input: z.unknown(),
    providerOptions: HostedProviderMetadataSchema.optional(),
  })
  .strict();

export const HostedToolResultOutputSchema = z.union([
  z.object({ type: z.literal('text'), value: z.string().max(1_000_000) }).strict(),
  z.object({ type: z.literal('json'), value: z.unknown() }).strict(),
  z.object({ type: z.literal('error-text'), value: z.string().max(1_000_000) }).strict(),
  z.object({ type: z.literal('error-json'), value: z.unknown() }).strict(),
  z
    .object({
      type: z.literal('execution-denied'),
      reason: z.string().max(4_000).optional(),
    })
    .strict(),
]);
export type HostedToolResultOutput = z.infer<typeof HostedToolResultOutputSchema>;

export const HostedSignedToolTicketTokenSchema = z
  .string()
  .min(3)
  .max(4_096)
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
export type HostedSignedToolTicketToken = z.infer<typeof HostedSignedToolTicketTokenSchema>;

export const HostedToolResultPartSchema = z
  .object({
    type: z.literal('tool-result'),
    toolCallId: opaqueId,
    toolName: opaqueId,
    output: HostedToolResultOutputSchema,
    ticket: HostedSignedToolTicketTokenSchema.optional(),
    mutationClaimId: uuid.optional(),
    providerOptions: HostedProviderMetadataSchema.optional(),
  })
  .strict()
  .superRefine((part, context) => {
    if (part.mutationClaimId && !part.ticket) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'mutationClaimId requires a signed tool ticket',
        path: ['ticket'],
      });
    }
  });

export const HostedMessagePartSchema = z.union([
  HostedTextPartSchema,
  HostedReasoningPartSchema,
  HostedToolCallPartSchema,
  HostedToolResultPartSchema,
]);
export type HostedMessagePart = z.infer<typeof HostedMessagePartSchema>;

export const HostedMessageSchema = z
  .object({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    parts: z.array(HostedMessagePartSchema).min(1).max(128),
  })
  .strict()
  .superRefine((message, context) => {
    const allowed =
      message.role === 'assistant'
        ? new Set(['text', 'reasoning', 'tool-call'])
        : message.role === 'tool'
          ? new Set(['tool-result'])
          : new Set(['text']);
    for (const [index, part] of message.parts.entries()) {
      if (!allowed.has(part.type)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['parts', index, 'type'],
          message: `Part type ${part.type} is invalid for role ${message.role}`,
        });
      }
    }
  });
export type HostedMessage = z.infer<typeof HostedMessageSchema>;

export const HostedToolChoiceSchema = z.union([
  z.object({ type: z.literal('auto') }).strict(),
  z.object({ type: z.literal('none') }).strict(),
  z.object({ type: z.literal('required') }).strict(),
  z.object({ type: z.literal('tool'), toolName: opaqueId }).strict(),
]);
export type HostedToolChoice = z.infer<typeof HostedToolChoiceSchema>;

export const HostedTraceContextSchema = z
  .object({
    source: z.enum(['desktop_chat', 'browser_chat']),
    workspaceOpen: z.boolean(),
    stagedReferenceIds: z.array(opaqueId).max(256),
  })
  .strict();
export type HostedTraceContext = z.infer<typeof HostedTraceContextSchema>;

export const HostedGenerateRequestSchema = z
  .object({
    version: z.literal(HOSTED_GENERATION_WIRE_VERSION),
    tier: HostedTierSchema,
    workflowId: opaqueId,
    runId: opaqueId,
    turnId: opaqueId,
    stepSequence: safeInteger.max(1_024),
    workflowRunId: uuid.optional(),
    messages: z.array(HostedMessageSchema).min(1).max(256),
    toolNames: z.array(opaqueId).max(128),
    toolChoice: HostedToolChoiceSchema.optional(),
    maxOutputTokens: z.number().int().positive().max(32_768).optional(),
    traceContext: HostedTraceContextSchema,
  })
  .strict()
  .superRefine((request, context) => {
    if (new Set(request.toolNames).size !== request.toolNames.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toolNames'],
        message: 'Hosted tool names must be unique',
      });
    }
    if (
      request.toolChoice?.type === 'tool' &&
      !request.toolNames.includes(request.toolChoice.toolName)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toolChoice', 'toolName'],
        message: 'The forced Hosted tool must be in the enabled server-owned subset',
      });
    }
    if (!isJsonSerializable(request)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Hosted generation requests must contain only JSON-serializable values',
      });
      return;
    }
    const serialized = JSON.stringify(request);
    if (new TextEncoder().encode(serialized).byteLength > MAX_HOSTED_WHOLE_REQUEST_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Hosted generation request exceeds the aggregate size limit',
      });
    }
  });
export type HostedGenerateRequest = z.infer<typeof HostedGenerateRequestSchema>;

export const HostedResearchContributionNoticeSchema = z
  .object({
    showNotice: z.literal(true),
    noticeText: z.literal(HOSTED_RESEARCH_CONTRIBUTION_NOTICE_TEXT),
    termsUrl: httpsUrlSchema(),
    privacyUrl: httpsUrlSchema(),
  })
  .strict();
export type HostedResearchContributionNotice = z.infer<
  typeof HostedResearchContributionNoticeSchema
>;

export const HostedWorkflowTraceSchema = z
  .object({
    workflowRunId: uuid,
    workflowStepId: uuid,
    workspaceRef: z
      .string()
      .regex(/^ws_h1_[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export type HostedWorkflowTrace = z.infer<typeof HostedWorkflowTraceSchema>;

export const HostedUsageSchema = z
  .object({
    status: z.enum(['reported', 'estimated', 'missing']),
    inputTokens: safeInteger.nullable(),
    outputTokens: safeInteger.nullable(),
    cacheReadTokens: safeInteger.nullable(),
    cacheWriteTokens: safeInteger.nullable(),
    reasoningTokens: safeInteger.nullable(),
  })
  .strict();
export type HostedUsage = z.infer<typeof HostedUsageSchema>;

export const HostedFinishReasonSchema = z
  .object({
    unified: z.enum(['stop', 'length', 'content-filter', 'tool-calls', 'error', 'other']),
    raw: z.string().max(1_000).nullable(),
    providerMetadata: HostedProviderMetadataSchema.optional(),
  })
  .strict();
export type HostedFinishReason = z.infer<typeof HostedFinishReasonSchema>;

export const HostedSignedToolTicketSchema = z
  .object({
    token: HostedSignedToolTicketTokenSchema,
    expiresAt: z.string().datetime({ offset: true }),
    providerCallId: opaqueId,
    toolName: opaqueId,
    requiresUserApproval: z.boolean(),
  })
  .strict();
export type HostedSignedToolTicket = z.infer<typeof HostedSignedToolTicketSchema>;

const streamBase = {
  v: z.literal(HOSTED_GENERATION_WIRE_VERSION),
  seq: safeInteger,
  requestId: opaqueId,
  runId: opaqueId,
  turnId: opaqueId,
  stepSequence: safeInteger.max(1_024),
};

export const HostedAcceptedEventSchema = z
  .object({
    ...streamBase,
    event: z.literal('accepted'),
    reservationId: uuid,
    tier: HostedTierSchema,
    catalogVersion: boundedVersion,
    rateCardVersion: boundedVersion,
    workflowTrace: HostedWorkflowTraceSchema.nullable().optional(),
  })
  .strict();

export const HostedTextDeltaEventSchema = z
  .object({
    ...streamBase,
    event: z.literal('text_delta'),
    delta: z.string().max(1_000_000),
  })
  .strict();

export const HostedReasoningDeltaEventSchema = z
  .object({
    ...streamBase,
    event: z.literal('reasoning_delta'),
    summary: z.literal(true),
    delta: z.string().max(1_000_000),
    providerMetadata: HostedProviderMetadataSchema.optional(),
  })
  .strict();

export const HostedReasoningContinuationEventSchema = z
  .object({
    ...streamBase,
    event: z.literal('reasoning_continuation'),
    itemId: z.string().min(1).max(8_192),
    encryptedContent: providerContinuityString,
  })
  .strict();

export const HostedToolCallEventSchema = z
  .object({
    ...streamBase,
    event: z.literal('tool_call'),
    toolCallId: opaqueId,
    name: opaqueId,
    input: z.unknown(),
    ticket: HostedSignedToolTicketSchema,
    providerMetadata: HostedProviderMetadataSchema.optional(),
  })
  .strict()
  .superRefine((event, context) => {
    if (event.ticket.providerCallId !== event.toolCallId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ticket', 'providerCallId'],
        message: 'The signed ticket must bind the emitted provider call',
      });
    }
    if (event.ticket.toolName !== event.name) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ticket', 'toolName'],
        message: 'The signed ticket must bind the emitted tool name',
      });
    }
    if (!isJsonSerializable(event.input)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['input'],
        message: 'Hosted tool input must be JSON serializable',
      });
    }
  });

export const HostedChildToolCallEventSchema = z
  .object({
    ...streamBase,
    event: z.literal('child_tool_call'),
    toolCallId: opaqueId,
    name: opaqueId,
    input: z.unknown(),
    providerMetadata: HostedProviderMetadataSchema.optional(),
  })
  .strict()
  .superRefine((event, context) => {
    if (!isJsonSerializable(event.input)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['input'],
        message: 'Hosted child tool input must be JSON serializable',
      });
    }
  });

export const HostedFinishEventSchema = z
  .object({
    ...streamBase,
    event: z.literal('finish'),
    reservationId: uuid,
    usageEventId: uuid.nullable(),
    outcome: z.enum(['completed', 'reconciliation_required']),
    usage: HostedUsageSchema,
    finishReason: HostedFinishReasonSchema,
    workflowTrace: HostedWorkflowTraceSchema.nullable(),
    researchContributionNotice: HostedResearchContributionNoticeSchema.nullable(),
    providerAttempts: z.number().int().min(0).max(2).optional(),
  })
  .strict();

export const HostedStreamErrorEventSchema = z
  .object({
    ...streamBase,
    event: z.literal('error'),
    reservationId: uuid,
    code: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    message: z.string().min(1).max(1_000),
    httpStatusCode: z.number().int().min(100).max(599).optional(),
    retryable: z.boolean(),
    reservationDisposition: z.enum(['released', 'settled', 'held_for_reconciliation', 'none']),
    usageEventId: uuid.nullable().optional(),
    workflowTrace: HostedWorkflowTraceSchema.nullable().optional(),
    providerAttempts: z.number().int().min(0).max(2).optional(),
  })
  .strict();

export const HostedStreamEventSchema = z.union([
  HostedAcceptedEventSchema,
  HostedTextDeltaEventSchema,
  HostedReasoningDeltaEventSchema,
  HostedReasoningContinuationEventSchema,
  HostedChildToolCallEventSchema,
  HostedToolCallEventSchema,
  HostedFinishEventSchema,
  HostedStreamErrorEventSchema,
]);
export type HostedStreamEvent = z.infer<typeof HostedStreamEventSchema>;

export const HostedErrorResponseSchema = z
  .object({
    version: z.literal(HOSTED_GENERATION_WIRE_VERSION),
    error: z
      .object({
        code: boundedVersion,
        message: z.string().min(1).max(1_000),
        requestId: opaqueId,
        retryable: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type HostedErrorResponse = z.infer<typeof HostedErrorResponseSchema>;

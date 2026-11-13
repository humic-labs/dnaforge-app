import { z } from 'zod';

import {
  HOSTED_GENERATION_WIRE_VERSION,
  HostedOpaqueIdSchema,
  HostedTierSchema,
  HostedToolChoiceSchema,
  HostedTraceContextSchema,
} from './wire.js';

export const HOSTED_RESPONSES_MAX_TOOLS = 128;

const RESPONSES_FUNCTION_NAME = /^[a-zA-Z0-9_-]+$/u;
const ENCODED_FUNCTION_PREFIX = 'dnaforge_';
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function base64urlUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    encoded += BASE64URL_ALPHABET.charAt(first >> 2);
    encoded += BASE64URL_ALPHABET.charAt(((first & 0x03) << 4) | ((second ?? 0) >> 4));
    if (second !== undefined) {
      encoded += BASE64URL_ALPHABET.charAt(((second & 0x0f) << 2) | ((third ?? 0) >> 6));
    }
    if (third !== undefined) encoded += BASE64URL_ALPHABET.charAt(third & 0x3f);
  }
  return encoded;
}

export function hostedResponsesFunctionWireName(canonicalName: string): string {
  if (
    RESPONSES_FUNCTION_NAME.test(canonicalName) &&
    !canonicalName.startsWith(ENCODED_FUNCTION_PREFIX)
  ) {
    return canonicalName;
  }
  return `${ENCODED_FUNCTION_PREFIX}${base64urlUtf8(canonicalName)}`;
}

export const ADMITTED_PROVIDER_TOOL_TYPES: ReadonlySet<string> = new Set([
  'web_search',
  'web_search_preview',
  'namespace',
]);

export const REFUSED_PROVIDER_TOOL_TYPES: Readonly<Record<string, string>> = {
  code_interpreter:
    'runs model-authored code on this account, outside any sandbox this product sets',
  file_search: 'reads provider-side storage this product does not own or audit',
  image_generation: 'bills per image with no ceiling this runtime can enforce',
  mcp: 'reaches an arbitrary third-party server chosen by the request',
  computer_use_preview: 'drives a machine on this account with no observable boundary',
  local_shell: 'names a shell this gateway has no way to place or contain',
  tool_search: 'provider-side discovery that can surface capabilities never reviewed here',
};

export const HostedResponsesToolSchema = z
  .object({
    type: z.string().min(1).max(64),
    name: z.string().min(1).max(128).optional(),
    description: z.string().max(8_192).optional(),
    parameters: z.unknown().optional(),
    strict: z.boolean().optional(),
  })
  .passthrough();

export type HostedResponsesTool = z.infer<typeof HostedResponsesToolSchema>;

export interface RefusedTool {
  readonly type: string;
  readonly name: string | undefined;
  readonly reason: string;
}

export function refusedTools(tools: readonly HostedResponsesTool[]): RefusedTool[] {
  const refused: RefusedTool[] = [];
  for (const tool of tools) {
    if (tool.type === 'function' || tool.type === 'custom') continue;
    if (ADMITTED_PROVIDER_TOOL_TYPES.has(tool.type)) continue;
    refused.push({
      type: tool.type,
      name: tool.name,
      reason:
        REFUSED_PROVIDER_TOOL_TYPES[tool.type] ??
        'a provider-executed tool type this product has not reviewed',
    });
  }
  return refused;
}

export const HostedResponsesRequestSchema = z
  .object({
    version: z.literal(HOSTED_GENERATION_WIRE_VERSION),
    tier: HostedTierSchema,
    workflowId: HostedOpaqueIdSchema,
    runId: HostedOpaqueIdSchema,
    turnId: HostedOpaqueIdSchema,
    stepSequence: z.number().int().nonnegative().max(1_024),
    workflowRunId: z.string().uuid().optional(),
    input: z.unknown().refine((value) => value !== undefined, 'input is required'),
    instructions: z.string().max(262_144).optional(),
    tools: z.array(HostedResponsesToolSchema).max(HOSTED_RESPONSES_MAX_TOOLS).default([]),
    toolChoice: HostedToolChoiceSchema.optional(),
    maxOutputTokens: z.number().int().positive().max(32_768).optional(),
    promptCacheKey: z.string().max(256).optional(),
    parallelToolCalls: z.boolean().optional(),
    reasoning: z.unknown().optional(),
    text: z.unknown().optional(),
    include: z.array(z.string().max(128)).max(32).optional(),
    traceContext: HostedTraceContextSchema,
  })
  .strict()
  .superRefine((request, context) => {
    for (const tool of refusedTools(request.tools)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tools'],
        message: `refused tool type "${tool.type}": ${tool.reason}`,
      });
    }
  });

export type HostedResponsesRequest = z.infer<typeof HostedResponsesRequestSchema>;

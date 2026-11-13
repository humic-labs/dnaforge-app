import { createHash, timingSafeEqual } from 'node:crypto';

import { MAX_HOSTED_WHOLE_REQUEST_BYTES } from '@waypoint/hosted-ai-contract';

import {
  buildHostedCodexToolCatalog,
  hostedCodexCanonicalToolName,
  hostedCodexToolWireName,
  hostedCodexWireInputSchema,
  type HostedCodexTool,
} from './dynamic-tool-catalog';

export type ResponsesRejectionCode =
  | 'not_loopback'
  | 'bad_credential'
  | 'bad_route'
  | 'oversized_body'
  | 'malformed_body'
  | 'unknown_field'
  | 'wrong_model'
  | 'incomplete_input'
  | 'store_not_disabled'
  | 'streaming_required'
  | 'unauthorized_tool'
  | 'tool_inventory_mismatch'
  | 'tool_schema_mismatch'
  | 'builtin_tool'
  | 'unsupported_tool_type';

export class ResponsesWireError extends Error {
  constructor(
    readonly code: ResponsesRejectionCode,
    message: string
  ) {
    super(message);
    this.name = 'ResponsesWireError';
  }
}

export const ALLOWED_REQUEST_FIELDS: ReadonlySet<string> = new Set([
  'model',
  'instructions',
  'input',
  'reasoning',
  'include',
  'prompt_cache_key',
  'client_metadata',
  'stream',
  'store',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'max_output_tokens',
  'metadata',
  'text',
]);

export const DROPPED_REQUEST_FIELDS: ReadonlySet<string> = new Set(['client_metadata']);

const BUILTIN_TOOL_TYPES: ReadonlySet<string> = new Set([
  'code_interpreter',
  'computer_use_preview',
  'file_search',
  'image_generation',
  'local_shell',
  'mcp',
  'web_search',
  'web_search_preview',
]);

export const HOSTED_CODEX_NATIVE_UI_TOOL_DEFINITIONS: Readonly<
  Record<string, Readonly<Record<string, unknown>>>
> = {
  request_user_input: {
    type: 'function',
    name: 'request_user_input',
    description:
      'Request user input for one to three short questions and wait for the response. This tool is only available in Default or Plan mode.',
    strict: false,
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description: 'Questions to show the user. Prefer 1 and do not exceed 3',
          items: {
            type: 'object',
            properties: {
              header: {
                type: 'string',
                description: 'Short header label shown in the UI (12 or fewer chars).',
              },
              id: {
                type: 'string',
                description: 'Stable identifier for mapping answers (snake_case).',
              },
              options: {
                type: 'array',
                description:
                  'Provide 2-3 mutually exclusive choices. Put the recommended option first and suffix its label with "(Recommended)". Do not include an "Other" option in this list; the client will add a free-form "Other" option automatically.',
                items: {
                  type: 'object',
                  properties: {
                    description: {
                      type: 'string',
                      description: 'One short sentence explaining impact/tradeoff if selected.',
                    },
                    label: {
                      type: 'string',
                      description: 'User-facing label (1-5 words).',
                    },
                  },
                  required: ['label', 'description'],
                  additionalProperties: false,
                },
              },
              question: {
                type: 'string',
                description: 'Single-sentence prompt shown to the user.',
              },
            },
            required: ['id', 'header', 'question', 'options'],
            additionalProperties: false,
          },
        },
      },
      required: ['questions'],
      additionalProperties: false,
    },
  },
};

export interface ResponsesRequestContext {
  readonly remoteAddress: string;
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: Buffer;
}

export interface ResponsesWirePolicy {
  readonly bearerToken: string;
  readonly model: string;
  readonly tools: readonly HostedCodexTool[];
  readonly maxRequestBytes?: number;
}

export interface AcceptedResponsesRequest {
  readonly model: string;
  readonly input: unknown;
  readonly toolNames: readonly string[];
  readonly maxOutputTokens: number | undefined;
  readonly instructions: string | undefined;
  readonly promptCacheKey: string | undefined;
  readonly parallelToolCalls: boolean | undefined;
  readonly reasoning: unknown;
  readonly include: unknown;
  readonly forwarded: Readonly<Record<string, unknown>>;
  readonly requestDigest: string;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function assertResponsesLoopbackRouteAndCredential(
  context: ResponsesRequestContext,
  policy: ResponsesWirePolicy
): void {
  if (!LOOPBACK.has(context.remoteAddress)) {
    throw new ResponsesWireError(
      'not_loopback',
      'the Responses endpoint accepts loopback callers only'
    );
  }
  if (context.method !== 'POST' || context.path !== '/v1/responses') {
    throw new ResponsesWireError('bad_route', 'only POST /v1/responses is served');
  }
  const presented = context.authorization?.startsWith('Bearer ')
    ? context.authorization.slice('Bearer '.length)
    : '';
  if (!constantTimeEquals(presented, policy.bearerToken)) {
    throw new ResponsesWireError('bad_credential', 'the request did not carry this process bearer');
  }
}

function parseResponsesRequestObject(
  context: ResponsesRequestContext,
  policy: ResponsesWirePolicy
): Record<string, unknown> {
  const limit = policy.maxRequestBytes ?? MAX_HOSTED_WHOLE_REQUEST_BYTES;
  if (context.body.byteLength > limit) {
    throw new ResponsesWireError('oversized_body', 'the Responses request body is too large');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(context.body.toString('utf8'));
  } catch {
    throw new ResponsesWireError('malformed_body', 'the Responses request body is not JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ResponsesWireError('malformed_body', 'the Responses request must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function assertResponsesRequestShape(
  request: Record<string, unknown>,
  policy: ResponsesWirePolicy
): void {
  for (const field of Object.keys(request)) {
    if (!ALLOWED_REQUEST_FIELDS.has(field)) {
      throw new ResponsesWireError('unknown_field', `the request carries unknown field "${field}"`);
    }
  }
  if (request.model !== policy.model) {
    throw new ResponsesWireError(
      'wrong_model',
      `the request names model "${String(request.model)}", not the admitted ${policy.model}`
    );
  }
  if (!Array.isArray(request.input) || request.input.length === 0) {
    throw new ResponsesWireError(
      'incomplete_input',
      'the request must carry the complete input for this turn'
    );
  }
  if (request.store !== false) {
    throw new ResponsesWireError('store_not_disabled', 'the request must set store to false');
  }
  if (request.stream !== true) {
    throw new ResponsesWireError('streaming_required', 'the request must stream');
  }
  if (request.parallel_tool_calls !== undefined && request.parallel_tool_calls !== true) {
    throw new ResponsesWireError('malformed_body', 'parallel_tool_calls must be true when present');
  }
}

function admitResponsesRequestedTools(
  request: Record<string, unknown>,
  policy: ResponsesWirePolicy
): readonly string[] {
  const offered = new Map(policy.tools.map((tool) => [hostedCodexToolWireName(tool.name), tool]));
  const requestedTools = request.tools ?? [];
  if (!Array.isArray(requestedTools)) {
    throw new ResponsesWireError('malformed_body', 'tools must be an array when present');
  }
  const seen = new Set<string>();
  for (const entry of requestedTools) {
    if (entry === null || typeof entry !== 'object') {
      throw new ResponsesWireError('malformed_body', 'each tool must be an object');
    }
    const tool = entry as Record<string, unknown>;
    const type = typeof tool.type === 'string' ? tool.type : '';
    if (BUILTIN_TOOL_TYPES.has(type)) {
      throw new ResponsesWireError(
        'builtin_tool',
        `the request offers the Codex built-in "${type}", which this runtime never exposes`
      );
    }
    if (type !== 'function') {
      throw new ResponsesWireError('unsupported_tool_type', `unsupported tool type "${type}"`);
    }
    const name = typeof tool.name === 'string' ? tool.name : '';
    const authorized = offered.get(name);
    const nativeUiDefinition = HOSTED_CODEX_NATIVE_UI_TOOL_DEFINITIONS[name];
    if (!authorized && !nativeUiDefinition) {
      throw new ResponsesWireError(
        'unauthorized_tool',
        `the request offers "${name}", which this turn did not`
      );
    }
    if (seen.has(name)) {
      throw new ResponsesWireError(
        'tool_inventory_mismatch',
        `the request offers "${name}" more than once`
      );
    }
    seen.add(name);
    const authorizedWireDefinition =
      nativeUiDefinition ??
      (authorized
        ? {
            type: 'function',
            name,
            description: authorized.description,
            strict: false,
            parameters: hostedCodexWireInputSchema(authorized.inputSchema),
          }
        : null);
    if (stableJson(tool) !== stableJson(authorizedWireDefinition)) {
      if (process.env.HOSTED_E2E_DIAGNOSTICS === '1') {
        console.error('[HostedCodex] Tool definition mismatch:', {
          name,
          offeredKeys: Object.keys(tool).sort(),
          authorizedKeys: Object.keys(authorizedWireDefinition).sort(),
        });
      }
      throw new ResponsesWireError(
        'tool_schema_mismatch',
        `the schema offered for "${name}" does not match the authorized definition`
      );
    }
  }
  if ([...offered.keys()].some((name) => !seen.has(name))) {
    throw new ResponsesWireError(
      'tool_inventory_mismatch',
      'the request tool inventory is not the complete inventory admitted for this turn'
    );
  }
  return [
    ...policy.tools.map((tool) => tool.name),
    ...Object.keys(HOSTED_CODEX_NATIVE_UI_TOOL_DEFINITIONS).filter((name) => seen.has(name)),
  ];
}

export function acceptResponsesRequest(
  context: ResponsesRequestContext,
  policy: ResponsesWirePolicy
): AcceptedResponsesRequest {
  assertResponsesLoopbackRouteAndCredential(context, policy);
  const request = parseResponsesRequestObject(context, policy);
  if (process.env.HOSTED_E2E_DIAGNOSTICS === '1') {
    console.error('[HostedCodex] Responses request fields:', Object.keys(request).sort());
  }
  assertResponsesRequestShape(request, policy);
  validateAppServerProviderControls(request);
  const toolNames = admitResponsesRequestedTools(request, policy);

  const maxOutputTokens =
    typeof request.max_output_tokens === 'number' ? request.max_output_tokens : undefined;

  const canonicalInput = canonicalizeInputToolNames(request.input, policy.tools);
  const instructions = request.instructions;
  if (instructions !== undefined && typeof instructions !== 'string') {
    throw new ResponsesWireError('malformed_body', 'instructions must be text when present');
  }
  const forwarded: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(request)) {
    if (DROPPED_REQUEST_FIELDS.has(field)) continue;
    forwarded[field] = value;
  }
  return {
    model: policy.model,
    input:
      typeof instructions === 'string' && instructions.length > 0
        ? [
            { type: 'message', role: 'system', content: instructions },
            ...(canonicalInput as unknown[]),
          ]
        : canonicalInput,
    toolNames,
    maxOutputTokens,
    instructions: typeof request.instructions === 'string' ? request.instructions : undefined,
    promptCacheKey:
      typeof request.prompt_cache_key === 'string' ? request.prompt_cache_key : undefined,
    parallelToolCalls:
      typeof request.parallel_tool_calls === 'boolean' ? request.parallel_tool_calls : undefined,
    reasoning: request.reasoning,
    include: request.include,
    forwarded,
    requestDigest: createHash('sha256').update(context.body).digest('hex'),
  };
}

function validateAppServerProviderControls(request: Record<string, unknown>): void {
  if (request.reasoning !== undefined) {
    if (
      request.reasoning === null ||
      typeof request.reasoning !== 'object' ||
      Array.isArray(request.reasoning)
    ) {
      throw new ResponsesWireError('malformed_body', 'reasoning must be an object when present');
    }
    const reasoning = request.reasoning as Record<string, unknown>;
    const allowedKeys = new Set(['effort', 'summary']);
    if (Object.keys(reasoning).some((key) => !allowedKeys.has(key))) {
      throw new ResponsesWireError('unknown_field', 'reasoning carries an unsupported field');
    }
    const efforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
    const summaries = new Set(['auto', 'concise', 'detailed']);
    if (
      (reasoning.effort !== undefined &&
        reasoning.effort !== null &&
        (typeof reasoning.effort !== 'string' || !efforts.has(reasoning.effort))) ||
      (reasoning.summary !== undefined &&
        reasoning.summary !== null &&
        (typeof reasoning.summary !== 'string' || !summaries.has(reasoning.summary)))
    ) {
      throw new ResponsesWireError('malformed_body', 'reasoning carries an unsupported value');
    }
  }
  if (
    request.include !== undefined &&
    (!Array.isArray(request.include) ||
      request.include.some((entry) => entry !== 'reasoning.encrypted_content'))
  ) {
    throw new ResponsesWireError('malformed_body', 'include carries an unsupported response item');
  }
  if (
    request.prompt_cache_key !== undefined &&
    (typeof request.prompt_cache_key !== 'string' ||
      request.prompt_cache_key.length === 0 ||
      request.prompt_cache_key.length > 256)
  ) {
    throw new ResponsesWireError('malformed_body', 'prompt_cache_key is not a bounded identifier');
  }
  if (request.client_metadata !== undefined) {
    if (
      request.client_metadata === null ||
      typeof request.client_metadata !== 'object' ||
      Array.isArray(request.client_metadata)
    ) {
      throw new ResponsesWireError(
        'malformed_body',
        'client_metadata must be an object when present'
      );
    }
    const entries = Object.entries(request.client_metadata as Record<string, unknown>);
    if (
      entries.length > 16 ||
      entries.some(
        ([key, value]) =>
          !/^[A-Za-z0-9_-]{1,128}$/u.test(key) || typeof value !== 'string' || value.length > 8_192
      )
    ) {
      throw new ResponsesWireError(
        'malformed_body',
        'client_metadata is not bounded text metadata'
      );
    }
  }
}

function canonicalizeInputToolNames(input: unknown, tools: readonly HostedCodexTool[]): unknown {
  if (!Array.isArray(input)) return input;
  return input.map((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return item;
    const record = item as Record<string, unknown>;
    if (record.type !== 'function_call' || typeof record.name !== 'string') return item;
    const canonical = hostedCodexCanonicalToolName(tools, record.name);
    if (canonical === null) {
      if (Object.hasOwn(HOSTED_CODEX_NATIVE_UI_TOOL_DEFINITIONS, record.name)) return item;
      throw new ResponsesWireError(
        'unauthorized_tool',
        `the input references "${record.name}", which this turn did not offer`
      );
    }
    return { ...record, name: canonical };
  });
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
}

export function turnToolPolicy(): readonly HostedCodexTool[] {
  return buildHostedCodexToolCatalog().tools;
}

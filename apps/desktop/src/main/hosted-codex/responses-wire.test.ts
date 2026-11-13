import { describe, expect, it } from 'vitest';
import { MAX_HOSTED_WHOLE_REQUEST_BYTES } from '@waypoint/hosted-ai-contract';

import {
  buildHostedCodexToolCatalog,
  hostedCodexToolWireName,
  hostedCodexWireInputSchema,
  type HostedCodexTool,
} from './dynamic-tool-catalog';
import {
  acceptResponsesRequest,
  HOSTED_CODEX_NATIVE_UI_TOOL_DEFINITIONS,
  ResponsesWireError,
  type ResponsesRequestContext,
  type ResponsesWirePolicy,
} from './responses-wire';

const tools = buildHostedCodexToolCatalog().tools;
const firstTool: HostedCodexTool = tools[0]!;

const policy: ResponsesWirePolicy = {
  bearerToken: 'process-private-token-value',
  model: 'gpt-5-codex',
  tools: [firstTool],
};

function body(payload: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify(payload), 'utf8');
}

function wireTool(tool: HostedCodexTool): Record<string, unknown> {
  return {
    type: 'function',
    name: hostedCodexToolWireName(tool.name),
    description: tool.description,
    strict: false,
    parameters: hostedCodexWireInputSchema(tool.inputSchema),
  };
}

function requestUserInputTool(): Record<string, unknown> {
  return structuredClone(HOSTED_CODEX_NATIVE_UI_TOOL_DEFINITIONS.request_user_input!);
}

function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'gpt-5-codex',
    input: [{ type: 'message', role: 'user', content: 'Summarize the open plate.' }],
    stream: true,
    store: false,
    tools: [wireTool(firstTool), requestUserInputTool()],
    ...overrides,
  };
}

function request(overrides: Partial<ResponsesRequestContext> = {}): ResponsesRequestContext {
  return {
    remoteAddress: '127.0.0.1',
    method: 'POST',
    path: '/v1/responses',
    authorization: `Bearer ${policy.bearerToken}`,
    body: body(validPayload()),
    ...overrides,
  };
}

function rejection(context: ResponsesRequestContext, policyOverride = policy): ResponsesWireError {
  try {
    acceptResponsesRequest(context, policyOverride);
  } catch (error) {
    if (error instanceof ResponsesWireError) return error;
    throw error;
  }
  throw new Error('expected the request to be refused');
}

describe('acceptResponsesRequest', () => {
  it('accepts the request the launched child is expected to make', () => {
    const accepted = acceptResponsesRequest(request(), policy);
    expect(accepted.model).toBe('gpt-5-codex');
    expect(accepted.toolNames).toEqual([firstTool.name, 'request_user_input']);
    expect(accepted.requestDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('restores canonical tool names in the accepted input', () => {
    const accepted = acceptResponsesRequest(
      request({
        body: body(
          validPayload({
            input: [
              {
                type: 'function_call',
                call_id: 'call-1',
                name: hostedCodexToolWireName(firstTool.name),
                arguments: '{}',
              },
            ],
          })
        ),
      }),
      policy
    );
    expect(accepted.input).toEqual([
      {
        type: 'function_call',
        call_id: 'call-1',
        name: firstTool.name,
        arguments: '{}',
      },
    ]);
  });

  it('preserves App Server instructions as the gateway system message', () => {
    const accepted = acceptResponsesRequest(
      request({
        body: body(validPayload({ instructions: 'Use only the offered DNAForge tools.' })),
      }),
      policy
    );
    expect(accepted.input).toEqual([
      {
        type: 'message',
        role: 'system',
        content: 'Use only the offered DNAForge tools.',
      },
      {
        type: 'message',
        role: 'user',
        content: 'Summarize the open plate.',
      },
    ]);
  });

  it('refuses a non-text instruction instead of dropping it', () => {
    expect(
      rejection(request({ body: body(validPayload({ instructions: { hidden: true } })) })).code
    ).toBe('malformed_body');
  });

  it('accepts the App Server parallel-tool contract but refuses a silent downgrade', () => {
    expect(
      acceptResponsesRequest(
        request({ body: body(validPayload({ parallel_tool_calls: true })) }),
        policy
      ).model
    ).toBe('gpt-5-codex');
    expect(
      rejection(request({ body: body(validPayload({ parallel_tool_calls: false })) })).code
    ).toBe('malformed_body');
  });

  it('admits and carries only bounded App Server provider controls', () => {
    const accepted = acceptResponsesRequest(
      request({
        body: body(
          validPayload({
            reasoning: { effort: 'medium', summary: 'auto' },
            include: ['reasoning.encrypted_content'],
            prompt_cache_key: 'thread-cache-1',
            client_metadata: { 'x-codex-turn-metadata': '{"thread_id":"opaque"}' },
          })
        ),
      }),
      policy
    );
    expect(accepted.reasoning).toEqual({ effort: 'medium', summary: 'auto' });
    expect(accepted.promptCacheKey).toBe('thread-cache-1');
    expect(accepted.requestDigest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it.each([
    { reasoning: { effort: 'premium' } },
    { reasoning: { effort: 'medium', secret_override: true } },
    { include: ['web_search.results'] },
    { prompt_cache_key: '' },
    { client_metadata: { key: { nested: true } } },
  ])('refuses unsupported App Server provider controls %#', (controls) => {
    expect(rejection(request({ body: body(validPayload(controls)) })).code).toMatch(
      /^(malformed_body|unknown_field)$/u
    );
  });

  describe('caller identity', () => {
    describe('what reaches the step', () => {
      const realistic = {
        instructions: 'You are a coding agent.',
        reasoning: { summary: 'auto' },
        prompt_cache_key: '00000000-0000-4000-8000-000000000000',
        include: ['reasoning.encrypted_content'],
        parallel_tool_calls: true,
        client_metadata: { 'x-codex-turn-metadata': '{"installation_id":"97fb0f6c"}' },
      };

      it('carries the billed system prompt', () => {
        const accepted = acceptResponsesRequest(
          request({ body: body(validPayload(realistic)) }),
          policy
        );
        expect(accepted.instructions).toBe('You are a coding agent.');
      });

      it('carries the fields that move cost and concurrency', () => {
        const accepted = acceptResponsesRequest(
          request({ body: body(validPayload(realistic)) }),
          policy
        );
        expect(accepted.promptCacheKey).toBe('00000000-0000-4000-8000-000000000000');
        expect(accepted.parallelToolCalls).toBe(true);
        expect(accepted.reasoning).toEqual({ summary: 'auto' });
        expect(accepted.include).toEqual(['reasoning.encrypted_content']);
      });

      it('removes the dropped field from what a caller can forward', () => {
        const accepted = acceptResponsesRequest(
          request({ body: body(validPayload(realistic)) }),
          policy
        );
        expect(accepted.forwarded).not.toHaveProperty('client_metadata');
        expect(JSON.stringify(accepted.forwarded)).not.toContain('installation_id');
      });

      it('keeps every field that is not dropped', () => {
        const accepted = acceptResponsesRequest(
          request({ body: body(validPayload(realistic)) }),
          policy
        );
        expect(accepted.forwarded).toHaveProperty('instructions');
        expect(accepted.forwarded).toHaveProperty('reasoning');
        expect(accepted.forwarded).toHaveProperty('prompt_cache_key');
        expect(accepted.forwarded).toHaveProperty('include');
        expect(accepted.forwarded).toHaveProperty('parallel_tool_calls');
        expect(accepted.forwarded).toHaveProperty('model');
        expect(accepted.forwarded).toHaveProperty('input');
      });

      it('leaves the optional fields undefined when the child omits them', () => {
        const accepted = acceptResponsesRequest(request(), policy);
        expect(accepted.instructions).toBeUndefined();
        expect(accepted.promptCacheKey).toBeUndefined();
        expect(accepted.parallelToolCalls).toBeUndefined();
      });
    });

    it.each(['10.0.0.4', '0.0.0.0', '::ffff:10.0.0.4', '192.168.1.9'])(
      'refuses a request from %s',
      (remoteAddress) => {
        expect(rejection(request({ remoteAddress })).code).toBe('not_loopback');
      }
    );

    it('accepts each loopback form the platform may report', () => {
      for (const remoteAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
        expect(acceptResponsesRequest(request({ remoteAddress }), policy).model).toBe(
          'gpt-5-codex'
        );
      }
    });

    it('refuses a request with no Authorization header', () => {
      expect(rejection(request({ authorization: undefined })).code).toBe('bad_credential');
    });

    it('refuses a bearer that is not this process token', () => {
      expect(rejection(request({ authorization: 'Bearer some-other-token' })).code).toBe(
        'bad_credential'
      );
    });

    it('refuses a token that merely prefixes the real one', () => {
      expect(
        rejection(request({ authorization: `Bearer ${policy.bearerToken.slice(0, -1)}` })).code
      ).toBe('bad_credential');
    });

    it('refuses a credential presented without the Bearer scheme', () => {
      expect(rejection(request({ authorization: policy.bearerToken })).code).toBe('bad_credential');
    });
  });

  describe('route', () => {
    it.each(['GET', 'PUT', 'DELETE', 'OPTIONS'])('refuses %s', (method) => {
      expect(rejection(request({ method })).code).toBe('bad_route');
    });

    it.each(['/v1/chat/completions', '/v1/responses/extra', '/', '/v1/models'])(
      'refuses the path %s',
      (path) => {
        expect(rejection(request({ path })).code).toBe('bad_route');
      }
    );
  });

  describe('body limits', () => {
    it('refuses a body over the byte limit', () => {
      const oversized = Buffer.alloc(MAX_HOSTED_WHOLE_REQUEST_BYTES + 1, 0x61);
      expect(rejection(request({ body: oversized })).code).toBe('oversized_body');
    });

    it('checks the limit before parsing, so an oversized body is never decoded', () => {
      const huge = Buffer.concat([
        Buffer.from('{"model":', 'utf8'),
        Buffer.alloc(MAX_HOSTED_WHOLE_REQUEST_BYTES, 0x61),
      ]);
      expect(rejection(request({ body: huge })).code).toBe('oversized_body');
    });

    it.each([
      ['not json at all', Buffer.from('not json at all', 'utf8')],
      ['a truncated object', Buffer.from('{"model":', 'utf8')],
      ['an empty body', Buffer.alloc(0)],
    ])('refuses %s', (_label, raw) => {
      expect(rejection(request({ body: raw })).code).toBe('malformed_body');
    });

    it.each([
      ['a JSON array', '[]'],
      ['a bare string', '"hello"'],
      ['null', 'null'],
      ['a number', '7'],
    ])('refuses %s at the top level', (_label, raw) => {
      expect(rejection(request({ body: Buffer.from(raw, 'utf8') })).code).toBe('malformed_body');
    });
  });

  describe('request envelope', () => {
    it('refuses a field this build does not model', () => {
      const error = rejection(
        request({ body: body(validPayload({ previous_response_id: 'r1' })) })
      );
      expect(error.code).toBe('unknown_field');
      expect(error.message).toContain('previous_response_id');
    });

    it.each(['gpt-4o', 'gpt-5-codex-mini', ''])('refuses the model %s', (model) => {
      expect(rejection(request({ body: body(validPayload({ model })) })).code).toBe('wrong_model');
    });

    it('refuses a request that omits the model', () => {
      const payload = validPayload();
      delete payload.model;
      expect(rejection(request({ body: body(payload) })).code).toBe('wrong_model');
    });

    it.each([
      ['store true', { store: true }],
      ['store absent', { store: undefined }],
    ])('refuses %s so nothing is retained provider-side', (_label, override) => {
      const payload = validPayload(override);
      if (override.store === undefined) delete payload.store;
      expect(rejection(request({ body: body(payload) })).code).toBe('store_not_disabled');
    });

    it('refuses a non-streaming request', () => {
      expect(rejection(request({ body: body(validPayload({ stream: false })) })).code).toBe(
        'streaming_required'
      );
    });

    it.each([
      ['an empty input', []],
      ['a string input', 'summarize'],
      ['an object input', { role: 'user' }],
    ])('refuses %s', (_label, input) => {
      expect(rejection(request({ body: body(validPayload({ input })) })).code).toBe(
        'incomplete_input'
      );
    });
  });

  describe('tool inventory', () => {
    it('admits the one App Server-native UI tool without adding renderer authority', () => {
      const payload = validPayload({ tools: [wireTool(firstTool), requestUserInputTool()] });
      const accepted = acceptResponsesRequest(request({ body: body(payload) }), policy);

      expect(accepted.toolNames).toEqual([firstTool.name, 'request_user_input']);
      expect(accepted.forwarded.tools).toEqual(payload.tools);
    });

    it('preserves the native UI tool name in continuation input', () => {
      const payload = validPayload({
        tools: [wireTool(firstTool), requestUserInputTool()],
        input: [
          {
            type: 'function_call',
            call_id: 'question-1',
            name: 'request_user_input',
            arguments: '{"questions":[]}',
          },
        ],
      });

      expect(acceptResponsesRequest(request({ body: body(payload) }), policy).input).toEqual(
        payload.input
      );
    });

    it('refuses schema drift in the pinned native UI tool', () => {
      const native = requestUserInputTool();
      native.description = 'Ask anything with no reviewed bounds.';
      const payload = validPayload({ tools: [wireTool(firstTool), native] });

      expect(rejection(request({ body: body(payload) })).code).toBe('tool_schema_mismatch');
    });

    it('refuses a request that omits the admitted inventory', () => {
      const payload = validPayload();
      delete payload.tools;
      expect(rejection(request({ body: body(payload) })).code).toBe('tool_inventory_mismatch');
    });

    it('refuses a strict subset of the admitted inventory', () => {
      const secondTool = tools[1]!;
      expect(rejection(request(), { ...policy, tools: [firstTool, secondTool] }).code).toBe(
        'tool_inventory_mismatch'
      );
    });

    it('refuses a duplicate authorized tool', () => {
      const duplicate = wireTool(firstTool);
      const payload = validPayload({ tools: [duplicate, duplicate] });
      expect(rejection(request({ body: body(payload) })).code).toBe('tool_inventory_mismatch');
    });

    it('refuses a tool this turn never offered', () => {
      const payload = validPayload({
        tools: [{ type: 'function', name: 'exfiltrate_workspace', parameters: {} }],
      });
      const error = rejection(request({ body: body(payload) }));
      expect(error.code).toBe('unauthorized_tool');
      expect(error.message).toContain('exfiltrate_workspace');
    });

    it('refuses an authorized name carrying a drifted schema', () => {
      const drifted = {
        ...hostedCodexWireInputSchema(firstTool.inputSchema),
        additionalProperties: true,
      };
      const payload = validPayload({
        tools: [{ ...wireTool(firstTool), parameters: drifted }],
      });
      expect(rejection(request({ body: body(payload) })).code).toBe('tool_schema_mismatch');
    });

    it('accepts an authorized schema whose keys arrive in a different order', () => {
      const schema = hostedCodexWireInputSchema(firstTool.inputSchema);
      const reordered = Object.fromEntries(Object.entries(schema).reverse());
      const payload = validPayload({
        tools: [{ ...wireTool(firstTool), parameters: reordered }, requestUserInputTool()],
      });
      expect(acceptResponsesRequest(request({ body: body(payload) }), policy).toolNames).toEqual([
        firstTool.name,
        'request_user_input',
      ]);
    });

    it.each([
      ['a changed description', { description: 'A different capability.' }],
      ['strict mode enabled', { strict: true }],
      ['the strict flag omitted', { strict: undefined }],
      ['an extra definition field', { defer_loading: false }],
    ])('refuses %s', (_label, drift) => {
      const definition = { ...wireTool(firstTool), ...drift };
      if (Object.hasOwn(drift, 'strict') && Reflect.get(drift, 'strict') === undefined) {
        Reflect.deleteProperty(definition, 'strict');
      }
      const payload = validPayload({ tools: [definition] });
      expect(rejection(request({ body: body(payload) })).code).toBe('tool_schema_mismatch');
    });

    it.each([
      'web_search',
      'web_search_preview',
      'local_shell',
      'code_interpreter',
      'file_search',
      'computer_use_preview',
      'image_generation',
      'mcp',
    ])('refuses the Codex built-in %s', (type) => {
      const payload = validPayload({ tools: [{ type }] });
      const error = rejection(request({ body: body(payload) }));
      expect(error.code).toBe('builtin_tool');
      expect(error.message).toContain(type);
    });

    it('refuses a tool with no recognizable type', () => {
      const payload = validPayload({
        tools: [{ name: hostedCodexToolWireName(firstTool.name), parameters: {} }],
      });
      expect(rejection(request({ body: body(payload) })).code).toBe('unsupported_tool_type');
    });

    it('refuses a built-in even if it also claims to be a function', () => {
      const payload = validPayload({
        tools: [{ type: 'mcp', name: 'mcp', parameters: {} }],
      });
      expect(rejection(request({ body: body(payload) })).code).toBe('builtin_tool');
    });

    it('refuses a Codex-native function outside the exact DNAForge inventory', () => {
      const payload = validPayload({
        tools: [{ type: 'function', name: 'exec_command', parameters: { type: 'object' } }],
      });
      expect(rejection(request({ body: body(payload) })).code).toBe('unauthorized_tool');
    });

    it('refuses the Codex-native namespace surface', () => {
      const payload = validPayload({ tools: [{ type: 'namespace', name: 'multi_agent_v1' }] });
      expect(rejection(request({ body: body(payload) })).code).toBe('unsupported_tool_type');
    });

    it.each([
      ['tools as an object', { tools: { type: 'function' } }],
      ['a null tool entry', { tools: [null] }],
      ['a string tool entry', { tools: ['read_file'] }],
    ])('refuses %s', (_label, override) => {
      expect(rejection(request({ body: body(validPayload(override)) })).code).toBe(
        'malformed_body'
      );
    });
  });

  it('digests the exact accepted bytes and never the content', () => {
    const payload = validPayload();
    const accepted = acceptResponsesRequest(request({ body: body(payload) }), policy);
    const again = acceptResponsesRequest(request({ body: body(payload) }), policy);
    const different = acceptResponsesRequest(
      request({ body: body(validPayload({ max_output_tokens: 512 })) }),
      policy
    );
    expect(accepted.requestDigest).toBe(again.requestDigest);
    expect(different.requestDigest).not.toBe(accepted.requestDigest);
  });
});

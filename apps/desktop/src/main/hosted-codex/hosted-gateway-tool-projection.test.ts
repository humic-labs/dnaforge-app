import { describe, expect, it } from 'vitest';
import {
  HOSTED_TOOL_DISPATCH_NAME,
  MAX_HOSTED_WHOLE_REQUEST_BYTES,
  hostedResponsesFunctionWireName,
} from '@waypoint/hosted-ai-contract';
import { buildHostedCodexToolCatalog, hostedCodexWireInputSchema } from './dynamic-tool-catalog';
import { HOSTED_CODEX_RESERVED_TOOLS } from './hosted-session';
import { buildHostedProviderToolCatalog, discoverHostedTools } from './hosted-tool-discovery';
import {
  HOSTED_CODEX_NATIVE_UI_TOOL_DEFINITIONS,
  type AcceptedResponsesRequest,
} from './responses-wire';
import {
  createHostedGatewayToolProjection,
  projectHostedGatewayTools,
} from './hosted-gateway-tool-projection';
import type { HostedToolInventoryCounts } from './tool-inventory-observation';

const catalog = buildHostedCodexToolCatalog({
  allowEffects: ['read-only', 'mutating', 'ui-bound', 'external-submit'],
  omitNames: HOSTED_CODEX_RESERVED_TOOLS,
});
const dispatcher = hostedResponsesFunctionWireName(HOSTED_TOOL_DISPATCH_NAME);
const UTF8_HISTORY_CASES_V1 = [
  {
    name: 'bounded non-ASCII history',
    characters: MAX_HOSTED_WHOLE_REQUEST_BYTES / 4,
    admitted: true,
  },
  {
    name: 'oversized UTF-8 history',
    characters: MAX_HOSTED_WHOLE_REQUEST_BYTES / 2,
    admitted: false,
  },
] as const;
function request(input: unknown = []): AcceptedResponsesRequest {
  const tools = buildHostedProviderToolCatalog(catalog).tools.map((tool) => ({
    type: 'function',
    name: hostedResponsesFunctionWireName(tool.name),
    description: tool.description,
    strict: false,
    parameters: hostedCodexWireInputSchema(tool.inputSchema),
  }));
  return {
    model: 'gpt-5-codex',
    input,
    toolNames: [
      ...tools.map((tool) => tool.name),
      ...Object.keys(HOSTED_CODEX_NATIVE_UI_TOOL_DEFINITIONS),
    ],
    maxOutputTokens: undefined,
    instructions: undefined,
    promptCacheKey: undefined,
    parallelToolCalls: false,
    reasoning: undefined,
    include: ['reasoning.encrypted_content'],
    requestDigest: 'raw-child-digest',
    forwarded: {
      input,
      tools: [...tools, ...Object.values(HOSTED_CODEX_NATIVE_UI_TOOL_DEFINITIONS)],
      stream: true,
      store: false,
      tool_choice: 'auto',
      parallel_tool_calls: false,
      include: ['reasoning.encrypted_content'],
    },
  };
}
function call(name: string, args = '{}') {
  return {
    type: 'function_call',
    id: 'item-original',
    call_id: 'call-original',
    status: 'completed',
    name: dispatcher,
    arguments: JSON.stringify({ name, arguments: args }),
  };
}

describe('Hosted canonical gateway tool projection', () => {
  it('observes actual child/base/forwarded definitions and accepted page/cache high-water marks', () => {
    const projection = createHostedGatewayToolProjection(catalog);
    const observations: Array<
      Omit<
        HostedToolInventoryCounts,
        'authorizationCatalogDefinitionCount' | 'registeredChildDefinitionCount'
      >
    > = [];
    const inspect = () => projection.project(request(), (counts) => observations.push(counts));
    inspect();
    expect(observations[0]).toEqual({
      projectionSequence: 0,
      childOfferedDefinitionCount: 17,
      gatewayBaseDefinitionCount: 16,
      gatewayForwardedDefinitionCount: 16,
      retainedDefinitionCount: 0,
      maxRetainedDefinitionCount: 0,
      acceptedDiscoveryPageCount: 0,
      lastAcceptedDiscoveryPageDefinitionCount: 0,
      maxAcceptedDiscoveryPageDefinitionCount: 0,
    });
    for (let offset = 0; offset < 40; offset += 8) {
      projection.remember(discoverHostedTools(catalog, { query: '', offset, limit: 8 }).tools);
    }
    projection.remember([]);
    inspect();
    expect(observations[1]).toMatchObject({
      projectionSequence: 1,
      gatewayForwardedDefinitionCount: 48,
      retainedDefinitionCount: 32,
      maxRetainedDefinitionCount: 32,
      acceptedDiscoveryPageCount: 6,
      lastAcceptedDiscoveryPageDefinitionCount: 0,
      maxAcceptedDiscoveryPageDefinitionCount: 8,
    });
    expect(() => projection.remember(catalog.tools.slice(0, 9))).toThrow();
    const known = catalog.tools[0];
    expect(() => projection.remember([known, { ...known, name: 'unknown-action' }])).toThrow();
    inspect();
    expect(observations[2]).toEqual({ ...observations[1], projectionSequence: 2 });
    expect(JSON.stringify(observations)).not.toContain(known.name);
  });
  it('ignores a failed observer without changing returned definitions, history or later discovery', () => {
    const projection = createHostedGatewayToolProjection(catalog);
    const page = discoverHostedTools(catalog, { query: 'create_design' }).tools;
    projection.remember(page);
    const accepted = request([
      { type: 'reasoning', encrypted_content: 'opaque-original', summary: [] },
    ]);
    const before = projection.project(accepted);
    expect(
      projection.project(accepted, () => {
        throw new Error('observer failure');
      })
    ).toEqual(before);
    const later: number[] = [];
    projection.project(accepted, (counts) => later.push(counts.acceptedDiscoveryPageCount));
    expect(later).toEqual([1]);
    expect(accepted.forwarded.input).toEqual([
      { type: 'reasoning', encrypted_content: 'opaque-original', summary: [] },
    ]);
  });
  it('observes the post-byte-eviction cache while retaining its actual bounded high-water', () => {
    const tool = discoverHostedTools(catalog, { query: 'create_design' }).tools[0];
    const oversized = { ...tool, description: 'x'.repeat(MAX_HOSTED_WHOLE_REQUEST_BYTES) };
    const modifiedCatalog = {
      ...catalog,
      tools: catalog.tools.map((candidate) =>
        candidate.name === tool.name ? oversized : candidate
      ),
    };
    const projection = createHostedGatewayToolProjection(modifiedCatalog);
    projection.remember([oversized]);
    const accepted = request([
      { type: 'reasoning', encrypted_content: 'opaque-unchanged', summary: [] },
    ]);
    const snapshots: number[] = [];
    const projected = projection.project(accepted, (counts) =>
      snapshots.push(
        counts.retainedDefinitionCount,
        counts.maxRetainedDefinitionCount,
        counts.gatewayForwardedDefinitionCount
      )
    );
    expect(snapshots).toEqual([0, 1, 16]);
    expect(projected.forwarded.input).toEqual(accepted.forwarded.input);
    expect(projection.inventorySummary()).toMatchObject({
      projectionCount: 1,
      acceptedDiscoveryPageCount: 1,
      retainedDefinitionCount: 0,
      maxRetainedDefinitionCount: 1,
    });
    projection.remember([tool]);
    expect(projection.inventorySummary()).toMatchObject({
      projectionCount: 1,
      acceptedDiscoveryPageCount: 2,
      retainedDefinitionCount: 1,
    });
  });
  it('rejects a mixed invalid discovery page without changing previously offered actions', () => {
    const projection = createHostedGatewayToolProjection(catalog);
    const previous = discoverHostedTools(catalog, { query: 'create_design' }).tools;
    const next = discoverHostedTools(catalog, { query: 'get_workspace' }).tools[0];
    expect(next).toBeDefined();
    projection.remember(previous);
    const before = projection.project(request());

    expect(() =>
      projection.remember([next, { ...next, name: 'unknown_discovery_action' }])
    ).toThrow();
    expect(projection.project(request()).forwarded.tools).toEqual(before.forwarded.tools);
  });

  it('takes projected descriptions and schemas from the admitted catalog, not page metadata', () => {
    const projection = createHostedGatewayToolProjection(catalog);
    const trusted = discoverHostedTools(catalog, { query: 'get_workspace' }).tools[0];
    expect(trusted).toBeDefined();
    projection.remember([
      {
        ...trusted,
        description: 'Untrusted discovery-page instructions',
        inputSchema: {
          type: 'object',
          properties: { injected: { type: 'string' } },
          additionalProperties: true,
        },
      },
    ]);

    const tools = projection.project(request()).forwarded.tools as Array<Record<string, unknown>>;
    expect(
      tools.find((tool) => tool.name === hostedResponsesFunctionWireName(trusted.name))
    ).toEqual({
      type: 'function',
      name: hostedResponsesFunctionWireName(trusted.name),
      description: trusted.description,
      strict: false,
      parameters: hostedCodexWireInputSchema(trusted.inputSchema),
    });
  });

  it.each(UTF8_HISTORY_CASES_V1)(
    'preserves or refuses $name without trimming history',
    ({ characters, admitted }) => {
      const projection = createHostedGatewayToolProjection(catalog);
      const input = [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'é'.repeat(characters) }],
        },
      ];
      const accepted = request(input);
      const original = JSON.stringify(accepted.forwarded.input);

      if (admitted) {
        const projected = projection.project(accepted);
        expect(projected.forwarded.input).toEqual(input);
        expect(Buffer.byteLength(JSON.stringify(projected.forwarded), 'utf8')).toBeLessThanOrEqual(
          MAX_HOSTED_WHOLE_REQUEST_BYTES
        );
      } else {
        expect(() => projection.project(accepted)).toThrow(/request.*limit/i);
      }
      expect(JSON.stringify(accepted.forwarded.input)).toBe(original);
    }
  );

  it('retains earlier pages and empty searches within one session, without leaking to another', () => {
    const projection = createHostedGatewayToolProjection(catalog);
    const earlier = discoverHostedTools(catalog, { query: 'create_design' }).tools;
    const later = discoverHostedTools(catalog, { query: 'get_workspace' }).tools;
    projection.remember(earlier);
    projection.remember(later);
    projection.remember([]);
    const names = (projection.project(request()).forwarded.tools as Array<{ name: string }>).map(
      (t) => t.name
    );
    expect(names).toEqual(expect.arrayContaining(['create_design', 'get_workspace']));
    expect(
      (
        createHostedGatewayToolProjection(catalog).project(request()).forwarded.tools as Array<{
          name: string;
        }>
      ).map((t) => t.name)
    ).not.toContain('create_design');
  });

  it('retains at most 32 recent canonical actions, refreshing discovery recency', () => {
    const projection = createHostedGatewayToolProjection(catalog);
    const page = discoverHostedTools(catalog, { query: '', limit: 8 }).tools;
    const all = [...page];
    for (let offset = 8; offset < 32; offset += 8) {
      const more = discoverHostedTools(catalog, { query: '', offset, limit: 8 }).tools;
      all.push(...more);
      projection.remember(more);
    }
    projection.remember(page);
    const extra = discoverHostedTools(catalog, { query: '', offset: 32, limit: 8 }).tools;
    projection.remember(extra);
    const names = (projection.project(request()).forwarded.tools as Array<{ name: string }>).map(
      (t) => t.name
    );
    expect(names).toHaveLength(48);
    expect(names).toContain(hostedResponsesFunctionWireName(page[0].name));
    expect(names).not.toContain(hostedResponsesFunctionWireName(all[8].name));
    expect(names).toContain(hostedResponsesFunctionWireName(extra[0].name));
    expect(() => projection.remember(catalog.tools.slice(0, 9))).toThrow();
  });

  it('adds targeted discovery guidance while preserving original instructions and opaque history', () => {
    const original = request([{ type: 'reasoning', encrypted_content: 'opaque', summary: [] }]);
    const accepted: AcceptedResponsesRequest = {
      ...original,
      forwarded: { ...original.forwarded, instructions: 'Original authority rules.' },
    };
    const projected = createHostedGatewayToolProjection(catalog).project(accepted);
    expect(projected.forwarded.instructions).toContain('Original authority rules.');
    expect(projected.forwarded.instructions).toContain('Do not enumerate the catalog');
    expect(projected.forwarded.instructions).toContain(
      'use separate queries for separate action names'
    );
    expect(projected.forwarded.input).toEqual(accepted.forwarded.input);
  });

  it('fails closed on oversized history without trimming it', () => {
    const projection = createHostedGatewayToolProjection(catalog);
    expect(() =>
      projection.project(request([{ type: 'message', content: 'x'.repeat(2_097_152) }]))
    ).toThrow(/request.*limit/i);
  });

  it('evicts only older optional definitions when schema bytes crowd the request', () => {
    const actions = discoverHostedTools(catalog, { query: '', limit: 2 }).tools.map((tool) => ({
      ...tool,
      description: 'x'.repeat(1_100_000),
    }));
    const largeCatalog = { ...catalog, tools: actions };
    const projection = createHostedGatewayToolProjection(largeCatalog);
    projection.remember(actions);
    const accepted = request([{ type: 'reasoning', encrypted_content: 'keep-me', summary: [] }]);
    const projected = projection.project(accepted);
    const names = (projected.forwarded.tools as Array<{ name: string }>).map((tool) => tool.name);
    expect(names).not.toContain(hostedResponsesFunctionWireName(actions[0].name));
    expect(names).toContain(hostedResponsesFunctionWireName(actions[1].name));
    expect(projected.forwarded.input).toEqual(accepted.forwarded.input);
    expect(Buffer.byteLength(JSON.stringify(projected.forwarded), 'utf8')).toBeLessThan(2_097_152);
  });
  it('offers only the trusted bounded discovery page, preserving native/UI tools and controls', () => {
    const accepted = request();
    const before = JSON.stringify(accepted);
    const page = discoverHostedTools(catalog, { query: 'create_design', limit: 8 }).tools;
    const projected = projectHostedGatewayTools(accepted, catalog, page);
    const tools = projected.forwarded.tools as Array<Record<string, unknown>>;
    expect(tools.map((tool) => tool.name)).not.toContain(dispatcher);
    expect(tools.find((tool) => tool.name === 'create_design')).toMatchObject({
      strict: false,
      parameters: hostedCodexWireInputSchema(
        page.find((tool) => tool.name === 'create_design')!.inputSchema
      ),
    });
    expect(tools).toEqual(
      expect.arrayContaining(Object.values(HOSTED_CODEX_NATIVE_UI_TOOL_DEFINITIONS))
    );
    expect(tools.length).toBeLessThanOrEqual(24);
    expect(projected.forwarded).toMatchObject({
      tool_choice: 'auto',
      parallel_tool_calls: false,
      store: false,
    });
    expect(projected.requestDigest).toBe(accepted.requestDigest);
    expect(JSON.stringify(accepted)).toBe(before);
    expect(
      (
        projectHostedGatewayTools(accepted, catalog, []).forwarded.tools as Array<{ name: string }>
      ).some((tool) => tool.name === 'create_design')
    ).toBe(false);
  });

  it('restores canonical history identity independently of the current discovery page', () => {
    const output = {
      type: 'function_call_output',
      call_id: 'call-original',
      output: '{"name":"dnaforge_execute_tool"}',
    };
    const reasoning = {
      type: 'reasoning',
      id: 'reasoning-1',
      encrypted_content: 'opaque',
      summary: [],
    };
    const action = catalog.tools.find((tool) => tool.name.includes('.'))!;
    expect(action).toBeDefined();
    const projected = projectHostedGatewayTools(
      request([call(action.name, '{"path":"/workspace"}'), output, reasoning]),
      catalog,
      []
    );
    expect(projected.forwarded.input).toEqual([
      {
        ...call(action.name),
        name: hostedResponsesFunctionWireName(action.name),
        arguments: '{"path":"/workspace"}',
      },
      output,
      reasoning,
    ]);
  });

  it.each(['shell', 'Read', 'close_tab', 'unknown_action', HOSTED_TOOL_DISPATCH_NAME])(
    'refuses unavailable historical dispatch target %s before egress',
    (name) => {
      expect(() => projectHostedGatewayTools(request([call(name)]), catalog, [])).toThrow();
    }
  );

  it('refuses malformed dispatch, unavailable effect tiers, excessive pages and forced dispatcher choice', () => {
    expect(() =>
      projectHostedGatewayTools(request([call('get_workspace', '[]')]), catalog, [])
    ).toThrow();
    const readOnly = buildHostedCodexToolCatalog({ omitNames: HOSTED_CODEX_RESERVED_TOOLS });
    expect(() =>
      projectHostedGatewayTools(request([call('create_design')]), readOnly, [])
    ).toThrow();
    expect(() =>
      projectHostedGatewayTools(request(), catalog, catalog.tools.slice(0, 33))
    ).toThrow();
    const forced = request();
    expect(() =>
      projectHostedGatewayTools(
        {
          ...forced,
          forwarded: { ...forced.forwarded, tool_choice: { type: 'function', name: dispatcher } },
        },
        catalog,
        []
      )
    ).toThrow();
  });
});

import { describe, expect, it } from 'vitest';

import {
  ADMITTED_PROVIDER_TOOL_TYPES,
  HostedResponsesRequestSchema,
  hostedResponsesFunctionWireName,
  refusedTools,
  REFUSED_PROVIDER_TOOL_TYPES,
} from './responses-v3.js';

const CODEX_TOOLS = [
  { type: 'function', name: 'exec_command' },
  { type: 'function', name: 'write_stdin' },
  { type: 'function', name: 'update_plan' },
  { type: 'function', name: 'request_user_input' },
  { type: 'function', name: 'view_image' },
  { type: 'function', name: 'get_goal' },
  { type: 'function', name: 'create_goal' },
  { type: 'function', name: 'update_goal' },
  { type: 'namespace', name: 'multi_agent_v1' },
  { type: 'web_search' },
];

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 2,
    tier: 'auto',
    workflowId: 'codex-turn',
    runId: 'run-1',
    turnId: 'turn-1',
    stepSequence: 1,
    input: [{ type: 'message', role: 'user', content: 'hi' }],
    tools: CODEX_TOOLS,
    traceContext: { source: 'desktop_chat', workspaceOpen: true, stagedReferenceIds: [] },
    ...overrides,
  };
}

describe('the v3 tool gate', () => {
  it('projects child function names injectively onto the Responses wire', () => {
    expect(hostedResponsesFunctionWireName('get_workspace')).toBe('get_workspace');
    const dotted = hostedResponsesFunctionWireName('workspace.gitStatus');
    expect(dotted).toBe('dnaforge_d29ya3NwYWNlLmdpdFN0YXR1cw');
    expect(dotted).toMatch(/^[a-zA-Z0-9_-]+$/u);
    expect(dotted).not.toBe(hostedResponsesFunctionWireName('workspace_gitStatus'));
    expect(hostedResponsesFunctionWireName('dnaforge_reserved')).not.toBe('dnaforge_reserved');
  });

  it('admits every tool a real Codex child declares', () => {
    expect(refusedTools(CODEX_TOOLS)).toEqual([]);
    expect(HostedResponsesRequestSchema.safeParse(request()).success).toBe(true);
  });

  it('requires the child input even though its exact shape is forwarded', () => {
    const candidate = request();
    delete candidate.input;

    expect(HostedResponsesRequestSchema.safeParse(candidate).success).toBe(false);
  });

  it.each(['workflowId', 'runId', 'turnId'])(
    'rejects control characters in %s before it reaches a ledger or trace',
    (field) => {
      expect(
        HostedResponsesRequestSchema.safeParse(request({ [field]: 'valid-prefix\nforged-log' }))
          .success
      ).toBe(false);
    }
  );

  it('admits a function tool it has never seen', () => {
    expect(refusedTools([{ type: 'function', name: 'some_tool_from_2027' }])).toEqual([]);
  });

  it('refuses a provider-executed tool that would run code on this account', () => {
    const [refusal] = refusedTools([{ type: 'code_interpreter' }]);
    expect(refusal.type).toBe('code_interpreter');
    expect(refusal.reason).toContain('model-authored code');
  });

  it('refuses an unreviewed provider tool type', () => {
    const [refusal] = refusedTools([{ type: 'some_future_provider_tool' }]);
    expect(refusal.reason).toContain('has not reviewed');
  });

  it('reports every refusal at once', () => {
    const refusals = refusedTools([
      { type: 'code_interpreter' },
      { type: 'function', name: 'fine' },
      { type: 'mcp' },
    ]);
    expect(refusals.map((refusal) => refusal.type)).toEqual(['code_interpreter', 'mcp']);
  });

  it('rejects the whole request when a refused tool is declared', () => {
    const parsed = HostedResponsesRequestSchema.safeParse(
      request({ tools: [...CODEX_TOOLS, { type: 'file_search' }] })
    );
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(JSON.stringify(parsed.error.issues)).toContain('file_search');
    }
  });

  it('keeps the admitted and refused sets disjoint', () => {
    for (const type of ADMITTED_PROVIDER_TOOL_TYPES) {
      expect(REFUSED_PROVIDER_TOOL_TYPES, type).not.toHaveProperty(type);
    }
  });

  it('carries the fields a reservation is computed from', () => {
    const parsed = HostedResponsesRequestSchema.safeParse(
      request({ instructions: 'x'.repeat(20_000), promptCacheKey: 'thread-1' })
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.instructions).toHaveLength(20_000);
      expect(parsed.data.promptCacheKey).toBe('thread-1');
    }
  });

  it('refuses a field nobody has decided about', () => {
    expect(HostedResponsesRequestSchema.safeParse(request({ some_new_field: true })).success).toBe(
      false
    );
  });
});

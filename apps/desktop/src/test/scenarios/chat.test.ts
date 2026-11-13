import { describe, it, expect } from 'vitest';
import { withChatReady, withChatHistory, withPreseededReferences, withAIProvider } from './chat';
import {
  agentTraceCliSession,
  AGENT_TRACE_CLI_PROMPTS_MD,
  AGENT_TRACE_CLI_WORKSPACE_ROOT,
} from './presets';
import type { AppScenario } from './types';

const empty: AppScenario = {};

describe('chat scenario builders', () => {
  it('withChatReady adds provider and chat tab', () => {
    const scenario = withChatReady(empty);
    expect(scenario.chat?.provider).toBe('anthropic');
    expect(scenario.chat?.model).toBe('claude-sonnet-4-20250514');
    expect(scenario.canvas?.tabs?.some((t) => t.type === 'chat')).toBe(true);
  });

  it('withChatReady does not duplicate chat tab if one exists', () => {
    const withTab: AppScenario = {
      canvas: { tabs: [{ type: 'chat', entityId: 'conv-1', label: 'Chat' }] },
    };
    const scenario = withChatReady(withTab);
    const chatTabs = scenario.canvas?.tabs?.filter((t) => t.type === 'chat');
    expect(chatTabs).toHaveLength(1);
  });

  it('withChatHistory pre-seeds messages with conversation ID', () => {
    const messages = [
      { id: '1', role: 'user' as const, content: 'Hello', createdAt: 1000 },
      { id: '2', role: 'assistant' as const, content: 'Hi!', createdAt: 1001 },
    ];
    const scenario = withChatHistory(empty, messages);
    expect(scenario.chat?.messages).toHaveLength(2);
    expect(scenario.chat?.messages?.[0].role).toBe('user');
    expect(scenario.chat?.conversationId).toBeDefined();
  });

  it('withChatHistory binds seeded messages to the only mounted chat tab', () => {
    const scenario = withChatHistory(
      {
        canvas: {
          tabs: [{ type: 'chat', entityId: 'history-conversation', label: 'History' }],
        },
      },
      [{ id: '1', role: 'tool', content: '{}', createdAt: 1000 }]
    );

    expect(scenario.chat?.conversationId).toBe('history-conversation');
  });

  it('withPreseededReferences adds references', () => {
    const refs = [
      {
        id: 'ref-1',
        entity_type: 'sequence',
        display_label: 'pUC19',
        locator: 'git://workspace/pUC19.gb',
        deep_link_params: null,
        data: null,
        source: 'ai',
        status: 'created',
        created_at: 1000,
        updated_at: 1000,
      },
    ];
    const scenario = withPreseededReferences(empty, refs);
    expect(scenario.chat?.references).toHaveLength(1);
    expect(scenario.chat?.references?.[0].display_label).toBe('pUC19');
  });

  it('withAIProvider sets custom provider and model', () => {
    const scenario = withAIProvider(empty, 'openai', 'gpt-4o');
    expect(scenario.chat?.provider).toBe('openai');
    expect(scenario.chat?.model).toBe('gpt-4o');
  });

  it('builders compose without data loss', () => {
    const scenario = withChatReady(
      withPreseededReferences(
        withChatHistory(empty, [
          { id: '1', role: 'user' as const, content: 'test', createdAt: 1000 },
        ]),
        [
          {
            id: 'ref-1',
            entity_type: 'sequence',
            display_label: 'test',
            locator: 'git://workspace/test.gb',
            deep_link_params: null,
            data: null,
            source: 'ai',
            status: 'created',
            created_at: 1000,
            updated_at: 1000,
          },
        ]
      )
    );
    expect(scenario.chat?.messages).toHaveLength(1);
    expect(scenario.chat?.references).toHaveLength(1);
    expect(scenario.chat?.provider).toBe('anthropic');
    expect(scenario.canvas?.tabs?.some((t) => t.type === 'chat')).toBe(true);
  });

  it('agentTraceCliSession creates a reusable CLI trace workspace and prompt pack', () => {
    const scenario = agentTraceCliSession();

    expect(scenario.dev?.scenarioId).toBe('agent-trace-cli-session');
    expect(scenario.workspace?.folders).toEqual([
      { path: AGENT_TRACE_CLI_WORKSPACE_ROOT, name: 'agent-trace-cli' },
    ]);
    expect(scenario.workspace?.selectedPath).toBe(AGENT_TRACE_CLI_WORKSPACE_ROOT);
    expect(scenario.files?.[`${AGENT_TRACE_CLI_WORKSPACE_ROOT}/input/vector.fa`]).toContain(
      'agent_trace_vector_synthetic'
    );
    expect(scenario.files?.[`${AGENT_TRACE_CLI_WORKSPACE_ROOT}/input/insert.fa`]).toContain(
      'GGTCTC'
    );
    expect(scenario.files?.[`${AGENT_TRACE_CLI_WORKSPACE_ROOT}/prompts.md`]).toBe(
      AGENT_TRACE_CLI_PROMPTS_MD
    );
    expect(scenario.chat?.messages?.[0]?.content).toContain('Agent Trace CLI Test Kit');
    expect(scenario.chat?.messages?.[0]?.content).toContain(
      'Claude Native CLI or Codex Native CLI'
    );
    expect(scenario.canvas?.tabs?.some((tab) => tab.type === 'chat')).toBe(true);
  });
});

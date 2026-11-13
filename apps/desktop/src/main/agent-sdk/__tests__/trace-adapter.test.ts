import { userMessage } from '@waypoint/user-messages';
import { describe, expect, it } from 'vitest';
import {
  CodexTraceAdapter,
  ClaudeTraceAdapter,
  redactProviderSecrets,
  type ProviderTraceVersionStamp,
} from '../trace-adapter';

const versions: ProviderTraceVersionStamp = {
  sdkVersion: '0.133.0',
  cliVersion: 'codex-cli 0.133.0',
};

describe('provider trace adapters', () => {
  it('classifies Codex command events while preserving sanitized raw payloads', () => {
    const adapter = new CodexTraceAdapter(versions);
    const event = adapter.adapt(
      {
        type: 'item.started',
        item: {
          id: 'cmd-1',
          type: 'command_execution',
          command:
            '/bin/zsh -lc "python3 -c \\"import os,time; open(\\\'codex_tool.pid\\\', \\\'w\\\').write(str(os.getpid())); time.sleep(30)\\""',
          aggregated_output: 'OPENAI_API_KEY=sk-live-secret',
          status: 'in_progress',
        },
      },
      7
    );

    expect(event).toMatchObject({
      transport: 'codex-sdk',
      sequence: 7,
      providerEventType: 'item.started',
      providerItemType: 'command_execution',
      display: {
        kind: 'command',
        title: 'Command',
        status: 'In progress',
      },
      versions,
    });
    expect(event.raw).toMatchObject({
      item: {
        command: expect.stringContaining('python3'),
        aggregated_output: expect.stringContaining('[REDACTED]'),
      },
    });
  });

  it('extracts Codex final assistant text from the latest agent message item state', () => {
    const adapter = new CodexTraceAdapter(versions);
    const events = [
      adapter.adapt({
        type: 'item.started',
        item: { id: 'msg-1', type: 'agent_message', text: 'partial' },
      }),
      adapter.adapt({
        type: 'item.completed',
        item: { id: 'msg-1', type: 'agent_message', text: 'final answer' },
      }),
    ];

    expect(adapter.extractFinalText(events)).toBe('final answer');
  });

  it('keeps Codex protocol lifecycle, final assistant text, and completion events diagnostic', () => {
    const adapter = new CodexTraceAdapter(versions);
    const events = [
      adapter.adapt({ type: 'thread.started' }),
      adapter.adapt({ type: 'turn.started' }),
      adapter.adapt({
        type: 'item.completed',
        item: { id: 'msg-1', type: 'agent_message', text: 'final answer' },
      }),
      adapter.adapt({ type: 'turn.completed' }),
      adapter.adapt({
        type: 'item.completed',
        item: { id: 'reasoning-1', type: 'reasoning', text: 'Inspecting workspace state' },
      }),
    ];

    expect(events.slice(0, 4).map((event) => event.display.visibility)).toEqual([
      'diagnostic',
      'diagnostic',
      'diagnostic',
      'diagnostic',
    ]);
    expect(events[4].display).toEqual(
      expect.objectContaining({
        kind: 'reasoning',
        title: 'Reasoning',
        text: 'Inspecting workspace state',
      })
    );
    expect(events[4].display.visibility).toBeUndefined();
    expect(adapter.extractFinalText(events)).toBe('final answer');
  });

  it('formats Codex activity events as CLI-like status rows', () => {
    const adapter = new CodexTraceAdapter(versions);
    const events = [
      adapter.adapt({
        type: 'item.completed',
        item: { type: 'command_execution', status: 'completed', command: 'python analyze.py' },
      }),
      adapter.adapt({
        type: 'item.started',
        item: {
          type: 'mcp_tool_call',
          server: 'dnaforge',
          tool: 'observe_app_state',
          status: 'running',
        },
      }),
      adapter.adapt({
        type: 'item.completed',
        item: { type: 'web_search', query: 'RNA-seq differential expression E coli' },
      }),
      adapter.adapt({
        type: 'item.completed',
        item: { type: 'file_change', status: 'modified', path: 'results/report.md' },
      }),
      adapter.adapt({
        type: 'item.completed',
        item: { type: 'todo_list' },
      }),
    ];

    expect(events.map((event) => event.display)).toEqual([
      expect.objectContaining({
        kind: 'command',
        title: 'Command',
        status: 'Completed',
        text: 'python analyze.py',
      }),
      expect.objectContaining({
        kind: 'tool',
        title: 'Inspect app state',
        status: 'In progress',
      }),
      expect.objectContaining({
        kind: 'web_search',
        title: 'Web search',
        text: 'RNA-seq differential expression E coli',
      }),
      expect.objectContaining({
        kind: 'file_change',
        title: 'File changes',
        status: 'Modified',
        text: 'results/report.md',
      }),
      expect.objectContaining({
        kind: 'todo',
        title: 'Plan',
      }),
    ]);
  });

  it('redacts visible display text and exposes provider item ids for row reconciliation', () => {
    const adapter = new CodexTraceAdapter(versions);
    const event = adapter.adapt({
      type: 'item.started',
      item: {
        id: 'cmd-secret',
        type: 'command_execution',
        status: 'in_progress',
        command: "bash -lc 'echo sk-test-1234567890'",
      },
    });

    expect(event.providerItemId).toBe('cmd-secret');
    expect(event.display.text).toContain('[REDACTED]');
    expect(event.display.text).not.toContain('sk-test-1234567890');
  });

  it('renders expanded Codex command schemas without object garbage', () => {
    const adapter = new CodexTraceAdapter(versions);
    const event = adapter.adapt({
      type: 'item.completed',
      item: {
        id: 'cmd-array',
        type: 'command_execution',
        status: 'completed',
        command: ['bash', '-lc', 'printf ok'],
      },
    });

    expect(event.display).toEqual(
      expect.objectContaining({
        kind: 'command',
        title: 'Command',
        status: 'Completed',
        text: 'bash -lc "printf ok"',
      })
    );
    expect(event.display.text).not.toContain('[object Object]');
  });

  it('labels non-DNAForge MCP tools without confusing them for app tools', () => {
    const adapter = new CodexTraceAdapter(versions);
    const event = adapter.adapt({
      type: 'item.started',
      item: {
        id: 'tool-1',
        type: 'mcp_tool_call',
        server: 'lab-robot',
        tool: 'pipette',
        status: 'running',
      },
    });

    expect(event.display).toEqual(
      expect.objectContaining({
        kind: 'tool',
        title: 'Pipette',
        status: 'In progress',
        details: [{ label: 'Service', value: 'Lab robot' }],
      })
    );
  });

  it('bounds oversized display text for renderer health', () => {
    const adapter = new CodexTraceAdapter(versions);
    const event = adapter.adapt({
      type: 'item.completed',
      item: {
        id: 'cmd-long',
        type: 'command_execution',
        status: 'completed',
        command: `python -c "${'x'.repeat(5000)}"`,
      },
    });

    expect(event.display.text?.length).toBeLessThan(2100);
    expect(event.display.text).toContain('[truncated]');
  });

  it('classifies Claude permission denials and avoids duplicate final result text', () => {
    const adapter = new ClaudeTraceAdapter({
      sdkVersion: '0.3.150',
      cliVersion: '2.1.156 (Claude Code)',
    });
    const events = [
      adapter.adapt({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'ok' }],
        },
      }),
      adapter.adapt({
        type: 'system',
        subtype: 'permission_denied',
        tool_name: 'Write',
        tool_use_id: 'toolu_1',
        message: 'Probe denied this permission request.',
      }),
      adapter.adapt({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'ok',
        stop_reason: 'end_turn',
        permission_denials: [{ tool_name: 'Write' }],
      }),
    ];

    expect(events[1]).toMatchObject({
      transport: 'claude-agent-sdk',
      providerEventType: 'system.permission_denied',
      display: {
        kind: 'permission_denial',
        title: 'Action not allowed',
        status: 'Failed',
      },
    });
    expect(adapter.extractFinalText(events)).toBe('ok');
  });

  it('prefers Claude terminal result text over a pre-tool assistant preamble', () => {
    const adapter = new ClaudeTraceAdapter({
      sdkVersion: '0.3.150',
      cliVersion: '2.1.156 (Claude Code)',
    });
    const events = [
      adapter.adapt({
        type: 'assistant',
        message: { content: [{ type: 'text', text: "I'll list the workspace files." }] },
      }),
      adapter.adapt({
        type: 'result',
        subtype: 'success',
        result: 'pUC19.gb is present.',
      }),
    ];

    expect(adapter.extractFinalText(events)).toBe('pUC19.gb is present.');
  });

  it('falls back to Claude assistant text when the terminal result is blank', () => {
    const adapter = new ClaudeTraceAdapter({
      sdkVersion: '0.3.150',
      cliVersion: '2.1.156 (Claude Code)',
    });
    const events = [
      adapter.adapt({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'The workspace contains pUC19.gb.' }] },
      }),
      adapter.adapt({
        type: 'result',
        subtype: 'success',
        result: '   ',
      }),
    ];

    expect(adapter.extractFinalText(events)).toBe('The workspace contains pUC19.gb.');
  });

  it('classifies future Claude server tool blocks as public tool activity', () => {
    const adapter = new ClaudeTraceAdapter({
      sdkVersion: '0.3.150',
      cliVersion: '2.1.156 (Claude Code)',
    });
    const event = adapter.adapt({
      type: 'assistant',
      message: {
        content: [{ type: 'server_tool_use', name: 'Bash', input: { command: 'pwd' } }],
      },
    });

    expect(event.display).toEqual(
      expect.objectContaining({
        kind: 'tool',
        title: 'Run command',
        status: 'Waiting',
      })
    );
  });

  it('projects Claude plan mode and push notifications onto visible app-owned surfaces', () => {
    const adapter = new ClaudeTraceAdapter({
      sdkVersion: '0.3.150',
      cliVersion: '2.1.150 (Claude Code)',
    });

    expect(
      adapter.adapt({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'plan-1', name: 'EnterPlanMode', input: {} }],
        },
      }).display
    ).toEqual({
      kind: 'lifecycle',
      title: userMessage('assistant.trace.planMode'),
      status: userMessage('assistant.trace.entered'),
    });
    expect(
      adapter.adapt({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'notify-1',
              name: 'PushNotification',
              input: { title: 'Primer design', message: 'Primer design is complete.' },
            },
          ],
        },
      }).display
    ).toEqual({
      kind: 'notification',
      title: 'Assistant update',
      text: 'The assistant has an update. Open the conversation to continue.',
    });
  });

  it('normalizes Claude MCP requests and completed tool_result events without losing typed input', () => {
    const adapter = new ClaudeTraceAdapter({
      sdkVersion: '0.3.150',
      cliVersion: '2.1.209 (Claude Code)',
    });
    const input = {
      entityType: 'structure',
      selection: {
        kind: 'structure',
        structureRef: 'data:a120c670',
        residues: [{ chain: 'A', authSeqId: 362 }],
      },
    };
    const requested = adapter.adapt({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu-ref-1',
            name: 'mcp__dnaforge__create_reference',
            input,
          },
        ],
      },
    });
    const completed = adapter.adapt({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu-ref-1',
            content: JSON.stringify({
              ok: true,
              toolName: 'create_reference',
              status: 'completed',
              result: {
                ok: true,
                result: { referenceId: 'd0763a2f-091b-4987-9ac5-6b3f19fe33ff' },
              },
            }),
          },
        ],
      },
    });

    expect(requested.toolCalls).toEqual([
      {
        id: 'toolu-ref-1',
        name: 'create_reference',
        mcpServer: 'dnaforge',
        status: 'requested',
        input,
      },
    ]);
    expect(completed).toMatchObject({
      display: {
        kind: 'tool',
        status: 'Completed',
      },
      toolCalls: [
        {
          id: 'toolu-ref-1',
          name: 'create_reference',
          mcpServer: 'dnaforge',
          status: 'completed',
          output: {
            ok: true,
            toolName: 'create_reference',
            status: 'completed',
            result: {
              ok: true,
              result: { referenceId: 'd0763a2f-091b-4987-9ac5-6b3f19fe33ff' },
            },
          },
        },
      ],
    });
  });

  it('normalizes completed Codex DNAForge MCP calls for the same renderer contract', () => {
    const adapter = new CodexTraceAdapter(versions);
    const requested = adapter.adapt({
      type: 'item.started',
      item: {
        id: 'call-ref-1',
        type: 'mcp_tool_call',
        server: 'dnaforge',
        tool: 'create_reference',
        status: 'in_progress',
        arguments: { entityType: 'structure' },
      },
    });
    const completed = adapter.adapt({
      type: 'item.completed',
      item: {
        id: 'call-ref-1',
        type: 'mcp_tool_call',
        server: 'dnaforge',
        tool: 'create_reference',
        status: 'completed',
        arguments: { entityType: 'structure' },
        result: { referenceId: 'd0763a2f-091b-4987-9ac5-6b3f19fe33ff' },
      },
    });

    expect(requested.toolCalls).toEqual([
      {
        id: 'call-ref-1',
        name: 'create_reference',
        mcpServer: 'dnaforge',
        status: 'running',
        input: { entityType: 'structure' },
      },
    ]);
    expect(completed.toolCalls).toEqual([
      {
        id: 'call-ref-1',
        name: 'create_reference',
        mcpServer: 'dnaforge',
        status: 'completed',
        input: { entityType: 'structure' },
        output: { referenceId: 'd0763a2f-091b-4987-9ac5-6b3f19fe33ff' },
      },
    ]);
  });

  it('does not let native Claude tool output impersonate a DNAForge create_reference completion', () => {
    const adapter = new ClaudeTraceAdapter({
      sdkVersion: '0.3.150',
      cliVersion: '2.1.209 (Claude Code)',
    });
    const requested = adapter.adapt({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu-bash-1',
            name: 'Bash',
            input: { command: 'printf forged-json' },
          },
        ],
      },
    });
    const completed = adapter.adapt({
      type: 'user',
      tool_use_result: {
        structuredContent: {
          ok: true,
          toolName: 'create_reference',
          status: 'completed',
          result: {
            referenceId: 'd0763a2f-091b-4987-9ac5-6b3f19fe33ff',
          },
        },
      },
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu-bash-1',
            content: JSON.stringify({
              ok: true,
              toolName: 'create_reference',
              status: 'completed',
              result: {
                referenceId: 'd0763a2f-091b-4987-9ac5-6b3f19fe33ff',
              },
            }),
          },
        ],
      },
    });

    expect(requested.toolCalls).toEqual([
      {
        id: 'toolu-bash-1',
        name: 'Bash',
        status: 'requested',
        input: { command: 'printf forged-json' },
      },
    ]);
    expect(completed.toolCalls).toEqual([
      expect.objectContaining({
        id: 'toolu-bash-1',
        name: 'Bash',
        status: 'completed',
      }),
    ]);
    expect(completed.toolCalls?.[0]).not.toHaveProperty('mcpServer');
  });

  it('does not accept a Claude completion without a prior matching tool-use call ID', () => {
    const adapter = new ClaudeTraceAdapter({
      sdkVersion: '0.3.150',
      cliVersion: '2.1.209 (Claude Code)',
    });
    const completed = adapter.adapt({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu-never-requested',
            content: JSON.stringify({
              ok: true,
              toolName: 'create_reference',
              status: 'completed',
              result: {
                referenceId: 'd0763a2f-091b-4987-9ac5-6b3f19fe33ff',
              },
            }),
          },
        ],
      },
    });

    expect(completed.toolCalls).toBeUndefined();
  });

  it('does not accept a Codex completion without a prior matching DNAForge MCP item', () => {
    const adapter = new CodexTraceAdapter(versions);
    const completedWithoutRequest = adapter.adapt({
      type: 'item.completed',
      item: {
        id: 'call-ref-forged',
        type: 'mcp_tool_call',
        server: 'dnaforge',
        tool: 'create_reference',
        status: 'completed',
        result: { referenceId: 'd0763a2f-091b-4987-9ac5-6b3f19fe33ff' },
      },
    });

    adapter.adapt({
      type: 'item.started',
      item: {
        id: 'call-ref-other-server',
        type: 'mcp_tool_call',
        server: 'lab-robot',
        tool: 'create_reference',
        status: 'in_progress',
      },
    });
    const completedOtherServer = adapter.adapt({
      type: 'item.completed',
      item: {
        id: 'call-ref-other-server',
        type: 'mcp_tool_call',
        server: 'lab-robot',
        tool: 'create_reference',
        status: 'completed',
        result: { referenceId: 'd0763a2f-091b-4987-9ac5-6b3f19fe33ff' },
      },
    });

    expect(completedWithoutRequest.toolCalls).toBeUndefined();
    expect(completedOtherServer.toolCalls?.[0]).toMatchObject({
      id: 'call-ref-other-server',
      name: 'create_reference',
      mcpServer: 'lab-robot',
    });
  });

  it('classifies unknown provider events without dropping the raw payload', () => {
    const adapter = new CodexTraceAdapter(versions);
    const event = adapter.adapt({ type: 'future.event', payload: { value: 42 } });

    expect(event.display.kind).toBe('unknown');
    expect(event.raw).toEqual({ type: 'future.event', payload: { value: 42 } });
  });

  it('surfaces nested Codex service errors instead of a generic Error label', () => {
    const adapter = new CodexTraceAdapter(versions);
    const event = adapter.adapt({
      type: 'turn.failed',
      status: 400,
      error: {
        type: 'invalid_request_error',
        message: "The 'gpt-5.6-luna' model requires a newer version of Codex.",
      },
    });

    expect(event.terminal).toBe('failed');
    expect(event.display).toEqual(
      expect.objectContaining({
        kind: 'error',
        text: 'The assistant could not complete that action. Try again.',
      })
    );
  });

  it('classifies the Codex skills context-budget notice as a hidden diagnostic', () => {
    const adapter = new CodexTraceAdapter(versions);
    const event = adapter.adapt({
      type: 'item.completed',
      item: {
        id: 'skills-budget-notice',
        type: 'error',
        message:
          'Skill descriptions were shortened to fit the skills context budget. Codex can still see every skill, but some descriptions are shorter. Disable unused skills or plugins to leave more room for the rest.',
      },
    });

    expect(event.terminal).toBeUndefined();
    expect(event.display).toEqual(
      expect.objectContaining({
        kind: 'lifecycle',
        title: 'The assistant has an update. Open the conversation to continue.',
        visibility: 'diagnostic',
      })
    );
  });

  it('keeps ordinary Codex error items visible and failure-classified', () => {
    const adapter = new CodexTraceAdapter(versions);
    const event = adapter.adapt({
      type: 'item.completed',
      item: {
        id: 'real-error',
        type: 'error',
        message: 'The provider connection failed.',
      },
    });

    expect(event.display).toEqual(
      expect.objectContaining({
        kind: 'error',
        title: 'Assistant action failed',
        text: 'The assistant could not complete that action. Try again.',
      })
    );
  });

  it('redacts common secret shapes recursively', () => {
    expect(
      redactProviderSecrets({
        authorization: 'Bearer abc123',
        nested: {
          apiKey: 'sk-test-secret',
          safe: 'hello',
        },
      })
    ).toEqual({
      authorization: '[REDACTED]',
      nested: {
        apiKey: '[REDACTED]',
        safe: 'hello',
      },
    });
  });
});

import { userToolLabel } from '@waypoint/user-messages';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  FullChatView,
  getFullChatViewHarness,
  resetFullChatViewHarness,
} from './FullChatView.test-harness';
import { CodexTraceAdapter, ClaudeTraceAdapter } from '../main/agent-sdk/trace-adapter';
import { ToolResultDisplay } from './chat/ToolResultDisplay';

const { mockChatState } = getFullChatViewHarness();
const versions = { sdkVersion: null, cliVersion: null };
const query = 'pUC19 primer design';
const input = { query, provider: 'codex-sdk' };
const output = { ok: true, query, count: 2, matches: [] };
const diagnostic = 'platform.trackViews.list is not available in the hosted browser runtime.';
const credential = 'dna4335-private-test-credential';

describe('AI action detail preservation', () => {
  beforeEach(resetFullChatViewHarness);

  it('gives a valid new action an identifiable name without extending a fixed whitelist', () => {
    expect(userToolLabel('search_new_reference_windows')).toBe('Search new reference windows');
    expect(userToolLabel('mcp__dnaforge__search_skills')).toBe('Search skills');
  });

  it('preserves the action and target at both native provider boundaries', () => {
    const codex = new CodexTraceAdapter(versions).adapt({
      type: 'item.started',
      item: {
        id: 'search-1',
        type: 'mcp_tool_call',
        server: 'dnaforge',
        tool: 'search_skills',
        status: 'in_progress',
        arguments: input,
      },
    });
    const claude = new ClaudeTraceAdapter(versions).adapt({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'search-2', name: 'mcp__dnaforge__search_skills', input },
        ],
      },
    });

    for (const event of [codex, claude]) {
      expect(event.display.title).toBe('Search skills');
      expect(event.display.text).toContain(query);
      expect(event.display.title).not.toBe('Assistant action');
    }
  });

  it('shows merged request targets and completion details in one real conversation row', () => {
    const adapter = new CodexTraceAdapter(versions);
    const requested = adapter.adapt({
      type: 'item.started',
      item: {
        id: 'search-1',
        type: 'mcp_tool_call',
        server: 'dnaforge',
        tool: 'search_skills',
        status: 'in_progress',
        arguments: input,
      },
    });
    const completed = adapter.adapt({
      type: 'item.completed',
      item: {
        id: 'search-1',
        type: 'mcp_tool_call',
        server: 'dnaforge',
        tool: 'search_skills',
        status: 'completed',
        result: { ...output, apiKey: credential, debug: diagnostic },
      },
    });
    mockChatState.messages = [
      { id: 'user-1', role: 'user', content: 'Find relevant skills', createdAt: 1 },
    ];
    mockChatState.isStreaming = true;
    mockChatState.streamingBlocks = [
      { type: 'trace', event: requested },
      { type: 'trace', event: completed },
    ] as typeof mockChatState.streamingBlocks;

    render(<FullChatView workspacePath="/workspace" />);

    const rows = screen.getAllByTestId('agent-trace-row');
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toHaveTextContent('Search skills');
    expect(row).toHaveTextContent(query);
    expect(row).toHaveTextContent(/completed/i);
    expect(row).not.toHaveTextContent('Assistant action');
    fireEvent.click(within(row).getByRole('button', { name: /details/i }));
    expect(row).toHaveTextContent(/\b2\b/);
    expect(row).not.toHaveTextContent(credential);
    expect(row).not.toHaveTextContent(diagnostic);
  });

  it('keeps successful unmapped tool result details inspectable', () => {
    render(
      <ToolResultDisplay
        toolName="search_skills"
        content={JSON.stringify({
          input,
          output: { ...output, apiKey: credential, debug: diagnostic },
        })}
      />
    );

    const row = screen.getByTestId('tool-result');
    expect(row).toHaveTextContent('Search skills');
    expect(row).toHaveTextContent(query);
    expect(row).not.toHaveTextContent('Assistant action');
    fireEvent.click(within(row).getByRole('button'));
    expect(screen.getByTestId('tool-result-details')).toHaveTextContent(/\b2\b/);
    expect(row).not.toHaveTextContent(credential);
    expect(row).not.toHaveTextContent(diagnostic);
  });
});

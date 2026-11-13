import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  encodeAgentActivityMessage,
  FullChatView,
  getFullChatViewHarness,
  resetFullChatViewHarness,
  useDestructiveConfirmStore,
} from './FullChatView.test-harness';

const {
  mockAgentSdkAuthenticate,
  mockAISettingsState,
  mockChatState,
  mockRefreshAgentDetection,
  mockSetAssistantRoute,
  mockSetCliModel,
  mockSetCliReasoningEffort,
  mockSetModel,
} = getFullChatViewHarness();

function expectComposerPickerDisclosureIcon(button: HTMLElement) {
  const icon = within(button).getByTestId('chat-composer-picker-icon');
  expect(icon).toHaveClass('rotate-90', 'opacity-90', 'transition-transform');
  expect(icon.querySelector('svg')).toHaveAttribute('width', '10');
  expect(icon.querySelector('svg')).toHaveAttribute('height', '10');
  for (const className of ['justify-between', 'w-28', 'w-36', 'w-44']) {
    expect(button).not.toHaveClass(className);
  }
  return icon;
}

function expectElementBefore(first: HTMLElement, second: HTMLElement) {
  expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
}

describe('FullChatView transcript streaming activity', () => {
  beforeEach(resetFullChatViewHarness);

  it('renders provider-native reasoning activity while a CLI turn is streaming', () => {
    mockChatState.messages = [{ id: 'm1', role: 'user', content: 'Question', createdAt: 1 }];
    mockChatState.isStreaming = true;
    mockChatState.streamingBlocks = [
      {
        type: 'trace',
        event: {
          transport: 'codex-sdk',
          sequence: 0,
          receivedAt: '2026-06-02T00:00:00.000Z',
          providerEventType: 'item.completed',
          providerItemType: 'reasoning',
          raw: {},
          display: {
            kind: 'reasoning',
            title: 'Thinking',
            text: 'Reasoned about lambda phage import',
          },
          versions: { sdkVersion: null, cliVersion: null },
        },
      },
    ] as any;

    render(<FullChatView workspacePath="/workspace" />);

    const trace = screen.getByTestId('agent-trace-row');
    expect(trace).toHaveAttribute('data-agent-trace-kind', 'reasoning');
    expect(trace).toHaveTextContent('Reasoning');
    expect(trace).toHaveTextContent('Reasoned about lambda phage import');
    expect(trace).toHaveClass('text-accent/80', 'dark:text-accent/70');
    expect(trace).not.toHaveClass('rounded-md', 'border', 'bg-bg-subtle');
  });

  it('renders streaming CLI assistant text interleaved with activity rows', () => {
    mockChatState.messages = [{ id: 'm1', role: 'user', content: 'Question', createdAt: 1 }];
    mockChatState.isStreaming = true;
    mockChatState.streamingBlocks = [
      {
        type: 'assistant_text',
        content: 'I’ll inspect the workspace first.',
        event: {
          transport: 'codex-sdk',
          sequence: 0,
          receivedAt: '2026-06-02T00:00:00.000Z',
          providerEventType: 'item.completed',
          providerItemType: 'agent_message',
          raw: {},
          display: {
            kind: 'assistant_text',
            title: 'Assistant',
            text: 'I’ll inspect the workspace first.',
          },
          versions: { sdkVersion: null, cliVersion: null },
        },
      },
      {
        type: 'trace',
        event: {
          transport: 'codex-sdk',
          sequence: 1,
          receivedAt: '2026-06-02T00:00:00.000Z',
          providerEventType: 'item.completed',
          providerItemType: 'command_execution',
          raw: {},
          display: {
            kind: 'command',
            title: 'Ran command',
            status: 'completed',
            text: 'find . -maxdepth 2',
          },
          versions: { sdkVersion: null, cliVersion: null },
        },
      },
      {
        type: 'assistant_text',
        content: 'Now I have enough context.',
        event: {
          transport: 'codex-sdk',
          sequence: 2,
          receivedAt: '2026-06-02T00:00:00.000Z',
          providerEventType: 'item.completed',
          providerItemType: 'agent_message',
          raw: {},
          display: {
            kind: 'assistant_text',
            title: 'Assistant',
            text: 'Now I have enough context.',
          },
          versions: { sdkVersion: null, cliVersion: null },
        },
      },
    ] as any;

    render(<FullChatView workspacePath="/workspace" />);

    const scrollText = screen.getByTestId('chat-messages-scroll').textContent ?? '';
    expect(scrollText.indexOf('I’ll inspect the workspace first.')).toBeLessThan(
      scrollText.indexOf('Command')
    );
    expect(scrollText.indexOf('Command')).toBeLessThan(
      scrollText.indexOf('Now I have enough context.')
    );
  });

  it('collapses persisted CLI activity after the assistant answer and expands on demand', () => {
    mockChatState.messages = [
      { id: 'm1', role: 'user', content: 'Question', createdAt: 1 },
      {
        id: 'activity-1',
        role: 'activity',
        content: encodeAgentActivityMessage({
          transport: 'codex-sdk',
          sequence: 0,
          receivedAt: '2026-06-02T00:00:00.000Z',
          providerEventType: 'item.completed',
          providerItemType: 'command_execution',
          providerItemId: 'cmd-1',
          raw: {},
          display: {
            kind: 'command',
            title: 'Ran command',
            status: 'completed',
            text: 'rg plasmid',
          },
          versions: { sdkVersion: null, cliVersion: null },
        }),
        createdAt: 2,
      },
      { id: 'm2', role: 'assistant', content: 'Answer', createdAt: 3 },
    ];
    mockChatState.isStreaming = false;
    mockChatState.streamingBlocks = [];

    render(<FullChatView workspacePath="/workspace" />);

    expect(screen.queryByTestId('agent-trace-row')).not.toBeInTheDocument();
    expect(screen.queryByText('rg plasmid')).not.toBeInTheDocument();
    expect(screen.getByTestId('assistant-message')).toHaveTextContent('Answer');

    const toggle = screen.getByTestId('agent-trace-group-toggle');
    expect(toggle).toHaveTextContent('Show process');
    expect(toggle).toHaveTextContent('1 step');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggle);

    const trace = screen.getByTestId('agent-trace-row');
    expect(trace).toHaveAttribute('data-agent-trace-kind', 'command');
    expect(trace).toHaveTextContent('Command');
    expect(trace).toHaveTextContent('Completed');
    expect(trace).toHaveTextContent('rg plasmid');
    expect(trace).toHaveClass('text-accent/80', 'dark:text-accent/70');
    expect(trace).not.toHaveClass('rounded-md', 'border', 'bg-bg-subtle');
    expect(toggle).toHaveTextContent('Hide process');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('updates one persisted tool-call row from requested to completed', () => {
    const toolCallId = 'tool-call-list-files';
    const baseEvent = {
      transport: 'claude-agent-sdk' as const,
      receivedAt: '2026-08-20T00:00:00.000Z',
      versions: { sdkVersion: '0.3.150', cliVersion: '2.1.209' },
    };
    mockChatState.messages = [
      { id: 'm1', turnId: 'turn-cli', role: 'user', content: 'List files', createdAt: 1 },
      {
        id: 'tool-request',
        turnId: 'turn-cli',
        role: 'activity',
        content: encodeAgentActivityMessage({
          ...baseEvent,
          sequence: 1,
          providerEventType: 'assistant',
          raw: {},
          display: {
            kind: 'tool',
            title: 'Using tool',
            status: 'requested',
            text: 'mcp__dnaforge__list_files',
          },
          toolCalls: [
            {
              id: toolCallId,
              name: 'list_files',
              mcpServer: 'dnaforge',
              status: 'requested',
              input: { path: 'Samples' },
            },
          ],
        }),
        createdAt: 2,
      },
      {
        id: 'tool-completion',
        turnId: 'turn-cli',
        role: 'activity',
        content: encodeAgentActivityMessage({
          ...baseEvent,
          sequence: 2,
          providerEventType: 'user',
          raw: {},
          display: {
            kind: 'tool',
            title: 'Used DNAForge tool',
            status: 'completed',
            text: 'list_files',
          },
          toolCalls: [
            {
              id: toolCallId,
              name: 'list_files',
              mcpServer: 'dnaforge',
              status: 'completed',
              output: { ok: true },
            },
          ],
        }),
        createdAt: 3,
      },
      { id: 'm2', turnId: 'turn-cli', role: 'assistant', content: 'Done', createdAt: 4 },
    ];
    mockChatState.isStreaming = false;
    mockChatState.streamingBlocks = [];

    render(<FullChatView workspacePath="/workspace" />);

    const toggle = screen.getByTestId('agent-trace-group-toggle');
    expect(toggle).toHaveTextContent('1 step');
    fireEvent.click(toggle);

    const rows = screen.getAllByTestId('agent-trace-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveAttribute('data-agent-trace-tool-call-id', toolCallId);
    expect(rows[0]).toHaveTextContent('List files');
    expect(rows[0]).toHaveTextContent('Completed');
    expect(rows[0]).not.toHaveTextContent('Waiting');
  });

  it('updates one streaming tool-call row from requested to failed', () => {
    const toolCallId = 'tool-call-failed';
    const event = (status: 'requested' | 'failed', sequence: number) => ({
      transport: 'claude-agent-sdk' as const,
      sequence,
      receivedAt: '2026-08-20T00:00:00.000Z',
      providerEventType: status === 'requested' ? 'assistant' : 'user',
      raw: {},
      display: {
        kind: 'tool' as const,
        title: status === 'requested' ? 'Using tool' : 'Tool failed',
        status,
        text: 'list_files',
      },
      toolCalls: [
        {
          id: toolCallId,
          name: 'list_files',
          mcpServer: 'dnaforge',
          status,
          ...(status === 'requested' ? { input: {} } : { output: { error: 'unreachable' } }),
        },
      ],
      versions: { sdkVersion: '0.3.150', cliVersion: '2.1.209' },
    });
    mockChatState.messages = [{ id: 'm1', role: 'user', content: 'List files', createdAt: 1 }];
    mockChatState.isStreaming = true;
    mockChatState.streamingBlocks = [
      { type: 'trace', event: event('requested', 1) },
      { type: 'trace', event: event('failed', 2) },
    ] as any;

    render(<FullChatView workspacePath="/workspace" />);

    const rows = screen.getAllByTestId('agent-trace-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveAttribute('data-agent-trace-tool-call-id', toolCallId);
    expect(rows[0]).toHaveTextContent('Failed');
    expect(rows[0]).not.toHaveTextContent('Waiting');
  });

  it('collapses the whole completed turn process into one disclosure before the final answer', () => {
    mockChatState.messages = [
      { id: 'm1', turnId: 'turn-cli', role: 'user', content: 'Question', createdAt: 1 },
      {
        id: 'm2',
        turnId: 'turn-cli',
        role: 'assistant',
        content: "I'll inspect the workspace first.",
        createdAt: 2,
      },
      {
        id: 'activity-1',
        turnId: 'turn-cli',
        role: 'activity',
        content: encodeAgentActivityMessage({
          transport: 'codex-sdk',
          sequence: 0,
          receivedAt: '2026-06-02T00:00:00.000Z',
          providerEventType: 'item.completed',
          providerItemType: 'command_execution',
          providerItemId: 'cmd-1',
          raw: {},
          display: {
            kind: 'command',
            title: 'Ran command',
            status: 'completed',
            text: 'rg plasmid',
          },
          versions: { sdkVersion: null, cliVersion: null },
        }),
        createdAt: 3,
      },
      {
        id: 'm3',
        turnId: 'turn-cli',
        role: 'assistant',
        content: 'I found candidate files and will inspect one more thing.',
        createdAt: 4,
      },
      {
        id: 'activity-2',
        turnId: 'turn-cli',
        role: 'activity',
        content: encodeAgentActivityMessage({
          transport: 'codex-sdk',
          sequence: 1,
          receivedAt: '2026-06-02T00:00:01.000Z',
          providerEventType: 'item.completed',
          providerItemType: 'file_read',
          providerItemId: 'read-1',
          raw: {},
          display: {
            kind: 'file',
            title: 'Read file',
            status: 'completed',
            text: 'plasmids/pUC19.gb',
          },
          versions: { sdkVersion: null, cliVersion: null },
        }),
        createdAt: 5,
      },
      {
        id: 'm4',
        turnId: 'turn-cli',
        role: 'assistant',
        content: 'Final answer',
        createdAt: 6,
      },
    ];
    mockChatState.turns = {
      'turn-cli': {
        id: 'turn-cli',
        conversationId: 'visible-conv',
        routeKind: 'cli',
        hostId: 'codex-cli',
        provider: null,
        model: null,
        transport: 'codex-sdk',
        authorityProfileId: 'codex-sdk:native-workspace-write-dev',
        permissionMode: 'native-cli',
        routeSnapshotJson: JSON.stringify({
          kind: 'cli',
          transport: 'codex-sdk',
          permissionMode: 'native-cli',
        }),
        status: 'completed',
        terminalReason: 'completed',
        error: null,
        startedAt: 1,
        completedAt: 6,
      },
    };
    mockChatState.isStreaming = false;
    mockChatState.streamingBlocks = [];

    render(<FullChatView workspacePath="/workspace" conversationId="visible-conv" />);

    expect(screen.getAllByTestId('agent-trace-group-toggle')).toHaveLength(1);
    expect(screen.getByTestId('agent-trace-group-toggle')).toHaveTextContent('4 steps');
    expect(screen.getByTestId('assistant-message')).toHaveTextContent('Final answer');
    expect(screen.queryByText("I'll inspect the workspace first.")).not.toBeInTheDocument();
    expect(screen.queryByText('rg plasmid')).not.toBeInTheDocument();
    expect(screen.queryByText('plasmids/pUC19.gb')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('agent-trace-group-toggle'));

    const processText = screen.getAllByTestId('agent-process-assistant-text');
    expect(processText).toHaveLength(2);
    expect(processText[0]).toHaveClass('text-fg-muted');
    expect(processText[0]).not.toHaveClass('pl-3.5');
    expect(screen.getByText("I'll inspect the workspace first.")).toBeInTheDocument();
    expect(
      screen.getByText('I found candidate files and will inspect one more thing.')
    ).toBeInTheDocument();
    const traceRows = screen.getAllByTestId('agent-trace-row');
    expect(traceRows).toHaveLength(2);
    expect(traceRows[0].parentElement).not.toHaveClass('pl-3.5');
    expect(traceRows[0]).toHaveClass('text-accent/80', 'dark:text-accent/70');
    expect(screen.getByText('rg plasmid')).toBeInTheDocument();
    expect(screen.getByText('plasmids/pUC19.gb')).toBeInTheDocument();
  });
});

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userMessage, userMessageValue, userMessageWithValues } from '@waypoint/user-messages';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  encodeAgentActivityMessage,
  FullChatView,
  getFullChatViewHarness,
  resetFullChatViewHarness,
  useDestructiveConfirmStore,
} from './FullChatView.test-harness';
import { useToastStore } from '../stores/toast-store';

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

describe('FullChatView transcript trace rows', () => {
  beforeEach(resetFullChatViewHarness);

  it('renders CLI command and tool activity with status details', () => {
    mockChatState.messages = [{ id: 'm1', role: 'user', content: 'Question', createdAt: 1 }];
    mockChatState.isStreaming = true;
    mockChatState.streamingBlocks = [
      {
        type: 'trace',
        event: {
          transport: 'codex-sdk',
          sequence: 0,
          receivedAt: '2026-06-02T00:00:00.000Z',
          providerEventType: 'item.started',
          providerItemType: 'command_execution',
          raw: {},
          display: {
            kind: 'command',
            title: 'Running command',
            status: 'in_progress',
            text: 'python analyze.py',
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
          providerEventType: 'item.started',
          providerItemType: 'mcp_tool_call',
          raw: {},
          display: {
            kind: 'tool',
            title: 'Using DNAForge tool',
            status: 'running',
            text: 'observe_app_state',
          },
          versions: { sdkVersion: null, cliVersion: null },
        },
      },
    ] as any;

    render(<FullChatView workspacePath="/workspace" />);

    const traces = screen.getAllByTestId('agent-trace-row');
    expect(traces).toHaveLength(2);
    expect(traces[0]).toHaveAttribute('data-agent-trace-kind', 'command');
    expect(traces[0]).toHaveTextContent('Command');
    expect(traces[0]).toHaveTextContent('In progress');
    expect(traces[0]).toHaveTextContent('python analyze.py');
    expect(traces[1]).toHaveAttribute('data-agent-trace-kind', 'tool');
    expect(traces[1]).toHaveTextContent('Inspect app state');
    expect(traces[1]).toHaveTextContent('In progress');
    expect(traces[1]).not.toHaveTextContent('Assistant action');
    expect(traces[1]).not.toHaveTextContent('observe_app_state');
  });

  it('renders trace-heavy activity as bounded status rows without assistant copy controls', () => {
    mockChatState.messages = [{ id: 'm1', role: 'user', content: 'Question', createdAt: 1 }];
    mockChatState.isStreaming = true;
    mockChatState.streamingBlocks = Array.from({ length: 75 }, (_, i) => ({
      type: 'trace',
      event: {
        transport: 'codex-sdk',
        sequence: i,
        receivedAt: '2026-06-02T00:00:00.000Z',
        providerEventType: 'item.started',
        providerItemType: 'command_execution',
        providerItemId: `cmd-${i}`,
        raw: {},
        display: {
          kind: 'command',
          title: i === 0 ? 'Running command' : 'Ran command',
          status: i === 0 ? 'requires_action_permission_denied_by_native_cli_policy' : 'completed',
          text: `python -c "${'x'.repeat(500)}"`,
        },
        versions: { sdkVersion: null, cliVersion: null },
      },
    })) as any;

    render(<FullChatView workspacePath="/workspace" />);

    const traces = screen.getAllByTestId('agent-trace-row');
    expect(traces).toHaveLength(75);
    expect(traces[0]).toHaveAttribute('role', 'status');
    expect(traces[0]).toHaveAttribute('aria-label', expect.stringContaining('Command'));
    expect(within(traces[0]).getByText('Status unavailable')).toHaveClass('truncate');
    expect(traces[0]).not.toHaveTextContent(
      'requires_action_permission_denied_by_native_cli_policy'
    );
    expect(screen.queryByTestId('ai-copy-button')).not.toBeInTheDocument();
  });

  it('mirrors a provider notification into the app toast surface', async () => {
    useToastStore.setState({ toasts: [] });
    mockChatState.messages = [{ id: 'm1', role: 'user', content: 'Question', createdAt: 1 }];
    mockChatState.isStreaming = true;
    mockChatState.streamingBlocks = [
      {
        type: 'trace',
        event: {
          transport: 'claude-agent-sdk',
          sequence: 4,
          receivedAt: '2026-09-04T00:00:00.000Z',
          providerEventType: 'assistant',
          providerItemId: 'notify-1',
          raw: {},
          display: {
            kind: 'notification',
            title: 'Primer design',
            text: 'Primer design is complete.',
          },
          versions: { sdkVersion: '0.3.150', cliVersion: '2.1.150' },
        },
      },
    ] as any;

    render(<FullChatView workspacePath="/workspace" />);

    await waitFor(() => {
      expect(useToastStore.getState().toasts).toEqual([
        expect.objectContaining({
          message: userMessageWithValues('assistant.notificationDetail', {
            title: userMessageValue(userMessage('assistant.trace.notification')),
            detail: userMessageValue(userMessage('assistant.notice')),
          }),
          type: 'info',
        }),
      ]);
    });
  });

  it('does not render raw CLI protocol lifecycle or assistant-output trace events as boxes', () => {
    mockChatState.messages = [{ id: 'm1', role: 'user', content: 'Question', createdAt: 1 }];
    mockChatState.isStreaming = true;
    mockChatState.streamingBlocks = [
      {
        type: 'trace',
        event: {
          transport: 'codex-sdk',
          sequence: 0,
          receivedAt: '2026-06-02T00:00:00.000Z',
          providerEventType: 'thread.started',
          raw: {},
          display: {
            kind: 'lifecycle',
            title: 'thread.started',
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
          providerEventType: 'turn.started',
          raw: {},
          display: {
            kind: 'lifecycle',
            title: 'turn.started',
          },
          versions: { sdkVersion: null, cliVersion: null },
        },
      },
      {
        type: 'trace',
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
            text: 'This belongs in the final assistant message, not an activity box.',
          },
          versions: { sdkVersion: null, cliVersion: null },
        },
      },
      {
        type: 'trace',
        event: {
          transport: 'codex-sdk',
          sequence: 3,
          receivedAt: '2026-06-02T00:00:00.000Z',
          providerEventType: 'turn.completed',
          raw: {},
          display: {
            kind: 'result',
            title: 'Turn completed',
          },
          versions: { sdkVersion: null, cliVersion: null },
          terminal: 'completed',
        },
      },
    ] as any;

    render(<FullChatView workspacePath="/workspace" />);

    expect(screen.queryByTestId('agent-trace-row')).not.toBeInTheDocument();
    expect(screen.queryByText('thread.started')).not.toBeInTheDocument();
    expect(screen.queryByText('turn.started')).not.toBeInTheDocument();
    expect(screen.queryByText('Assistant')).not.toBeInTheDocument();
    expect(screen.queryByText('Turn completed')).not.toBeInTheDocument();
  });
});

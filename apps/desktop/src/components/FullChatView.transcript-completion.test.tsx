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

describe('FullChatView transcript completed turns', () => {
  beforeEach(resetFullChatViewHarness);

  it('collapses completed tool messages but leaves the final answer visible', () => {
    mockChatState.messages = [
      { id: 'm1', role: 'user', content: 'Question', createdAt: 1 },
      {
        id: 'tool-1',
        role: 'tool',
        toolName: 'read_file',
        toolCallId: 'tc-1',
        content: JSON.stringify({
          input: { path: 'plasmids/pUC19.gb' },
          output: { length: 2686 },
        }),
        createdAt: 2,
      },
      { id: 'm2', role: 'assistant', content: 'Answer', createdAt: 3 },
    ];
    mockChatState.isStreaming = false;
    mockChatState.streamingBlocks = [];

    render(<FullChatView workspacePath="/workspace" />);

    expect(screen.queryByText('read_file')).not.toBeInTheDocument();
    expect(screen.getByTestId('assistant-message')).toHaveTextContent('Answer');

    fireEvent.click(screen.getByTestId('agent-trace-group-toggle'));

    expect(screen.getByText('read_file')).toBeInTheDocument();
  });

  it('shows one compact route attribution for each persisted assistant turn', () => {
    mockChatState.messages = [
      { id: 'm1', turnId: 'turn-api', role: 'user', content: 'Question', createdAt: 1 },
      { id: 'm2', turnId: 'turn-api', role: 'assistant', content: 'API answer', createdAt: 2 },
      { id: 'm3', turnId: 'turn-cli', role: 'user', content: 'Inspect files', createdAt: 3 },
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
            text: 'rg lambda',
          },
          versions: { sdkVersion: null, cliVersion: null },
        }),
        createdAt: 4,
      },
      { id: 'm4', turnId: 'turn-cli', role: 'assistant', content: 'CLI answer', createdAt: 5 },
    ];
    mockChatState.turns = {
      'turn-api': {
        id: 'turn-api',
        conversationId: 'visible-conv',
        routeKind: 'provider',
        hostId: 'direct-api',
        provider: 'openai',
        model: 'gpt-4o-mini',
        transport: null,
        authorityProfileId: null,
        permissionMode: null,
        routeSnapshotJson: JSON.stringify({
          kind: 'provider',
          provider: 'openai',
          model: 'gpt-4o-mini',
        }),
        status: 'completed',
        terminalReason: 'completed',
        error: null,
        startedAt: 1,
        completedAt: 2,
      },
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
        startedAt: 3,
        completedAt: 5,
      },
    };

    render(<FullChatView workspacePath="/workspace" conversationId="visible-conv" />);

    const attributions = screen.getAllByTestId('chat-turn-attribution');
    expect(attributions).toHaveLength(2);
    expect(attributions[0]).toHaveTextContent('Answered with Direct API - OpenAI / gpt-4o-mini');
    expect(attributions[1]).toHaveTextContent('Answered with Codex CLI');
    expect(screen.getByText('CLI answer')).toBeInTheDocument();
  });

  it('does not show internal route execution status while a turn runs', () => {
    mockChatState.messages = [
      {
        id: 'm1',
        turnId: 'turn-cli',
        role: 'user',
        content: 'Long running question',
        createdAt: 1,
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
        status: 'running',
        terminalReason: null,
        error: null,
        startedAt: 1,
        completedAt: null,
      },
    };
    mockChatState.activeTurnId = 'turn-cli';
    mockChatState.isLoading = true;
    mockAISettingsState.assistantRoute = {
      kind: 'provider',
      provider: 'openai',
      model: 'gpt-4o',
    };
    mockAISettingsState.agentTransport = null;

    render(<FullChatView workspacePath="/workspace" conversationId="visible-conv" />);

    expect(screen.queryByTestId('chat-running-route-status')).not.toBeInTheDocument();
  });
});

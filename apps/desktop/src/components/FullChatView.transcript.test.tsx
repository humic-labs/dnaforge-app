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

describe('FullChatView transcript rendering', () => {
  beforeEach(resetFullChatViewHarness);

  it('keeps whole-message copy for plain assistant replies', () => {
    mockChatState.messages = [
      { id: 'm1', role: 'user', content: 'Question', createdAt: 1 },
      { id: 'm2', role: 'assistant', content: 'Plain answer', createdAt: 2 },
    ];

    render(<FullChatView workspacePath="/workspace" />);

    expect(screen.getByTestId('ai-copy-button')).toBeInTheDocument();
  });

  it('keeps whole-message copy alongside an assistant table copy action', () => {
    mockChatState.messages = [
      { id: 'm1', role: 'user', content: 'Summarize the digest.', createdAt: 1 },
      {
        id: 'm2',
        role: 'assistant',
        content: ['| Enzyme | Cuts |', '| --- | ---: |', '| EcoRI | 1 |'].join('\n'),
        createdAt: 2,
      },
    ];

    render(<FullChatView workspacePath="/workspace" />);

    expect(screen.getByTestId('ai-copy-button')).toBeInTheDocument();
  });

  it('keeps whole-message copy when table-like text is inside a fenced code block', () => {
    mockChatState.messages = [
      { id: 'm1', role: 'user', content: 'Show the source.', createdAt: 1 },
      {
        id: 'm2',
        role: 'assistant',
        content: ['```markdown', '| Enzyme | Cuts |', '| --- | ---: |', '```'].join('\n'),
        createdAt: 2,
      },
    ];

    render(<FullChatView workspacePath="/workspace" />);

    expect(screen.getByTestId('ai-copy-button')).toBeInTheDocument();
  });

  it('keeps final-answer copy when a process table is expanded', () => {
    mockChatState.messages = [
      {
        id: 'm1',
        turnId: 'turn-cli-table',
        role: 'user',
        content: 'Summarize the digest.',
        createdAt: 1,
      },
      {
        id: 'm2',
        turnId: 'turn-cli-table',
        role: 'assistant',
        content: ['| Enzyme | Cuts |', '| --- | ---: |', '| EcoRI | 1 |'].join('\n'),
        createdAt: 2,
      },
      {
        id: 'm3',
        turnId: 'turn-cli-table',
        role: 'assistant',
        content: 'Final answer without a table.',
        createdAt: 3,
      },
    ];
    mockChatState.turns = {
      'turn-cli-table': {
        id: 'turn-cli-table',
        conversationId: 'visible-conv',
        routeKind: 'cli',
        hostId: 'codex-cli',
        provider: null,
        model: null,
        transport: 'codex-sdk',
        authorityProfileId: 'codex-sdk:native-workspace-write-dev',
        permissionMode: 'native-cli',
        routeSnapshotJson: '{}',
        status: 'completed',
        terminalReason: 'completed',
        error: null,
        startedAt: 1,
        completedAt: 3,
      },
    };

    render(<FullChatView workspacePath="/workspace" conversationId="visible-conv" />);

    expect(screen.getByTestId('ai-copy-button')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('agent-trace-group-toggle'));
    expect(screen.getByTestId('ai-copy-button')).toBeInTheDocument();
  });

  it('copies each prompt and final answer as its own Markdown without process text', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const answer =
      '## Answer\n\n| Name | Value |\n| --- | --- |\n| Example | 1 |\n\n```js\nconst value = 1;\n```\n\n[Source](https://example.org/source)';
    mockChatState.messages = [
      { id: 'u1', role: 'user', content: 'First **prompt**', createdAt: 1 },
      { id: 'process', role: 'assistant', content: 'PROCESS_CANARY', createdAt: 2 },
      { id: 'tool', role: 'tool', toolName: 'read_file', content: 'TOOL_CANARY', createdAt: 3 },
      { id: 'a1', role: 'assistant', content: answer, createdAt: 4 },
      { id: 'u2', role: 'user', content: 'Second prompt', createdAt: 5 },
      { id: 'a2', role: 'assistant', content: 'Second answer', createdAt: 6 },
    ];

    render(<FullChatView workspacePath="/workspace" />);

    const prompts = screen.getAllByRole('button', { name: 'Copy prompt' });
    const answers = screen.getAllByRole('button', { name: 'Copy answer' });
    expect(prompts).toHaveLength(2);
    expect(answers).toHaveLength(2);
    fireEvent.click(prompts[0]);
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('First **prompt**'));
    fireEvent.click(answers[0]);
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(answer));
    fireEvent.click(answers[1]);
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('Second answer'));
  });

  it('retains old answer copy but withholds the active legacy answer until completion', () => {
    mockChatState.messages = [
      { id: 'u1', role: 'user', content: 'First prompt', createdAt: 1 },
      { id: 'a1', role: 'assistant', content: 'First answer', createdAt: 2 },
      { id: 'u2', role: 'user', content: 'Second prompt', createdAt: 3 },
      { id: 'a2', role: 'assistant', content: 'Incomplete answer', createdAt: 4 },
    ];
    mockChatState.isLoading = true;
    mockChatState.isStreaming = true;
    const { rerender } = render(<FullChatView workspacePath="/workspace" />);
    expect(screen.getAllByRole('button', { name: 'Copy prompt' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Copy answer' })).toHaveLength(1);
    mockChatState.isLoading = false;
    mockChatState.isStreaming = false;
    rerender(<FullChatView workspacePath="/workspace" />);
    expect(screen.getAllByRole('button', { name: 'Copy answer' })).toHaveLength(2);
  });

  it.each(['running', 'failed', 'stopped', 'cancelled', 'interrupted'] as const)(
    'does not copy a turn with status %s as a completed answer',
    (status) => {
      mockChatState.messages = [
        { id: 'u1', turnId: 'turn1', role: 'user', content: 'Question', createdAt: 1 },
        { id: 'a1', turnId: 'turn1', role: 'assistant', content: 'Partial answer', createdAt: 2 },
      ];
      mockChatState.turns = {
        turn1: {
          id: 'turn1',
          conversationId: 'visible-conv',
          routeKind: 'provider',
          hostId: 'direct-api',
          provider: 'openai',
          model: 'test-model',
          transport: null,
          authorityProfileId: null,
          permissionMode: null,
          routeSnapshotJson: '{}',
          status,
          terminalReason: null,
          error: null,
          startedAt: 1,
          completedAt: null,
        },
      };
      const { rerender } = render(<FullChatView workspacePath="/workspace" />);
      expect(screen.getByRole('button', { name: 'Copy prompt' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Copy answer' })).not.toBeInTheDocument();
      mockChatState.turns.turn1.status = 'completed';
      mockChatState.turns = { ...mockChatState.turns };
      rerender(<FullChatView workspacePath="/workspace" />);
      expect(screen.getByRole('button', { name: 'Copy answer' })).toBeInTheDocument();
    }
  );
});

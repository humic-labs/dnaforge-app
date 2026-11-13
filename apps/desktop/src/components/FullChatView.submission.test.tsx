import {
  userMessage,
  userMessagePayload,
  userMessageWithValues,
  userMessageValue,
  type UserMessage,
} from '@waypoint/user-messages';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  encodeAgentActivityMessage,
  FullChatView,
  getFullChatViewHarness,
  platform,
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

describe('FullChatView submission recovery', () => {
  beforeEach(resetFullChatViewHarness);

  it('offers every supported text attachment type in the native picker', async () => {
    const open = vi.fn().mockResolvedValue(null);
    vi.mocked(platform).mockReturnValue({
      dialog: { open },
      agentAttachments: { capture: vi.fn() },
      agentSdk: {
        authenticate: mockAgentSdkAuthenticate,
        onAuthEvent: vi.fn(() => vi.fn()),
      },
    } as unknown as ReturnType<typeof platform>);

    render(<FullChatView workspacePath="/workspace" />);
    fireEvent.click(screen.getByTestId('chat-attach-button'));

    await waitFor(() => expect(open).toHaveBeenCalledOnce());
    expect(open).toHaveBeenCalledWith({
      multiple: true,
      filters: [
        {
          name: 'Biology Files',
          extensions: expect.arrayContaining([
            'gb',
            'gbk',
            'fasta',
            'fa',
            'fas',
            'seq',
            'txt',
            'md',
            'json',
            'csv',
          ]),
        },
      ],
    });
  });

  it('applies concurrent attachment drops in user initiation order', async () => {
    const firstResult = {
      ok: true,
      attachment: {
        id: `attachment-${'a'.repeat(64)}`,
        sha256: 'a'.repeat(64),
        name: 'first.txt',
        kind: 'text' as const,
        mediaType: 'text/plain',
        size: 12,
      },
    } as const;
    const secondResult = {
      ok: true,
      attachment: {
        id: `attachment-${'b'.repeat(64)}`,
        sha256: 'b'.repeat(64),
        name: 'second.txt',
        kind: 'text' as const,
        mediaType: 'text/plain',
        size: 13,
      },
    } as const;
    let resolveFirst!: (result: typeof firstResult) => void;
    const firstCapture = new Promise<typeof firstResult>((resolve) => {
      resolveFirst = resolve;
    });
    const capture = vi.fn(({ path }: { path: string }) =>
      path.endsWith('first.txt') ? firstCapture : Promise.resolve(secondResult)
    );
    vi.mocked(platform).mockReturnValue({
      agentAttachments: { capture },
      agentSdk: {
        authenticate: mockAgentSdkAuthenticate,
        onAuthEvent: vi.fn(() => vi.fn()),
      },
    } as unknown as ReturnType<typeof platform>);

    render(<FullChatView workspacePath="/workspace" />);
    const composer = screen.getByTestId('chat-composer');
    const drop = (path: string, name: string) => {
      const file = new File(['ignored'], name, { type: 'text/plain' });
      Object.defineProperty(file, 'path', { value: path });
      fireEvent.drop(composer, { dataTransfer: { files: [file], types: ['Files'] } });
    };

    drop('/workspace/first.txt', 'first.txt');
    drop('/workspace/second.txt', 'second.txt');
    await waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    expect(capture).toHaveBeenNthCalledWith(1, { path: '/workspace/first.txt' });

    await act(async () => resolveFirst(firstResult));
    await waitFor(() => expect(capture).toHaveBeenCalledTimes(2));
    expect(capture).toHaveBeenNthCalledWith(2, { path: '/workspace/second.txt' });
    expect(screen.getAllByText(/^(first|second)\.txt$/).map((node) => node.textContent)).toEqual([
      'first.txt',
      'second.txt',
    ]);
  });

  it('renders approved native attachment validation and hides unknown diagnostics', async () => {
    const currentPlatform = platform();
    const capture = vi
      .fn<ReturnType<typeof platform>['agentAttachments']['capture']>()
      .mockResolvedValueOnce({
        ok: false,
        error: 'private native diagnostic',
        userMessagePayload: userMessagePayload('assistant.attachmentSizeLimit', {
          limit: userMessageValue('1,048,576'),
          size: userMessageValue('1,048,577'),
        }),
      })
      .mockResolvedValueOnce({ ok: false, error: 'private native diagnostic' });
    vi.mocked(platform).mockReturnValue({
      ...currentPlatform,
      agentAttachments: { ...currentPlatform.agentAttachments, capture },
    });
    render(<FullChatView workspacePath="/workspace" />);
    const file = new File(['ignored'], 'oversized.txt', { type: 'text/plain' });
    Object.defineProperty(file, 'path', { value: '/workspace/oversized.txt' });
    const drop = () =>
      fireEvent.drop(screen.getByTestId('chat-composer'), {
        dataTransfer: { files: [file], types: ['Files'] },
      });

    drop();
    await waitFor(() =>
      expect(screen.getByTestId('ai-error')).toHaveTextContent(
        'AI attachments must be 1,048,576 bytes or smaller; this file is 1,048,577 bytes.'
      )
    );
    expect(screen.queryByText('private native diagnostic')).not.toBeInTheDocument();
    drop();
    await waitFor(() =>
      expect(screen.getByTestId('ai-error')).toHaveTextContent(
        'The assistant could not complete that action. Try again.'
      )
    );
  });

  it('renders a chat error in the empty-state composer (first message has no messages-view error surface)', () => {
    mockChatState.messages = [];
    mockChatState.error = userMessage('assistant.failed');

    render(<FullChatView workspacePath="/workspace" />);

    expect(screen.getByText('What can I help with?')).toBeInTheDocument();
    const errorEl = screen.getByTestId('ai-error');
    expect(errorEl).toBeVisible();
    expect(errorEl).toHaveTextContent('The assistant could not complete that action. Try again.');
  });

  it('sends without a mounted workspace — no workspace precondition ', () => {
    render(<FullChatView workspacePath={null} />);

    fireEvent.change(screen.getByTestId('ai-input'), {
      target: { value: 'Chat without a folder' },
    });
    fireEvent.click(screen.getByTestId('chat-send-button'));

    expect(mockChatState.sendMessage).toHaveBeenCalledWith(
      'Chat without a folder',
      null,
      undefined,
      [],
      {
        claimIfUnowned: true,
        activateConversation: true,
        onNotStarted: expect.any(Function),
        attachments: [],
      }
    );
    expect(mockChatState.setError).not.toHaveBeenCalledWith(expect.stringMatching(/no workspace/i));
  });

  it('restores the typed message when the send bails inside sendMessage (e.g. missing key)', async () => {
    mockChatState.sendMessage.mockImplementation(async (...args: unknown[]) => {
      const options = args[4] as { onNotStarted?: (error: UserMessage) => void };
      options.onNotStarted?.(
        userMessageWithValues('assistant.keyMissing', { provider: userMessageValue('OpenAI') })
      );
      return 'rejected';
    });

    render(<FullChatView workspacePath="/workspace" />);

    fireEvent.change(screen.getByTestId('ai-input'), {
      target: { value: 'Keep my draft if the key is missing' },
    });
    fireEvent.click(screen.getByTestId('chat-send-button'));

    await waitFor(() => {
      expect(mockChatState.sendMessage).toHaveBeenCalled();
      expect(screen.getByTestId('ai-input')).toHaveValue('Keep my draft if the key is missing');
    });
    const errorEl = screen.getByTestId('ai-error');
    expect(errorEl).toHaveTextContent('Add an API key for OpenAI in Settings before continuing.');
  });

  it('does not resurrect an accepted message when the provider later reports an error', async () => {
    mockChatState.sendMessage.mockImplementation(async () => {
      mockChatState.error = 'The hosted provider stopped after the request was accepted.';
      return 'accepted';
    });
    render(<FullChatView workspacePath="/workspace" />);

    fireEvent.change(screen.getByTestId('ai-input'), {
      target: { value: 'Persist this once' },
    });
    fireEvent.click(screen.getByTestId('chat-send-button'));

    await waitFor(() => expect(mockChatState.sendMessage).toHaveBeenCalled());
    expect(screen.getByTestId('ai-input')).toHaveValue('');
  });

  it('restores text, attachments and reference chips when Hosted admission declines the turn', async () => {
    mockAISettingsState.assistantRoute = {
      kind: 'cli',
      transport: 'codex-sdk',
      permissionMode: 'native-cli',
    };
    mockAISettingsState.agentTransport = 'codex-sdk';
    vi.mocked(platform).mockReturnValue({
      dialog: { open: vi.fn().mockResolvedValue('/workspace/plasmid.gb') },
      agentAttachments: {
        capture: vi.fn().mockResolvedValue({
          ok: true,
          attachment: {
            id: `attachment-${'a'.repeat(64)}`,
            sha256: 'a'.repeat(64),
            name: 'plasmid.gb',
            kind: 'text',
            mediaType: 'text/plain',
            size: 12,
          },
        }),
      },
      fs: {
        stat: vi.fn().mockResolvedValue({ size: 12 }),
        readTextFile: vi.fn().mockResolvedValue('LOCUS pUC19'),
      },
      agentSdk: {
        authenticate: mockAgentSdkAuthenticate,
        onAuthEvent: vi.fn(() => vi.fn()),
      },
    } as unknown as ReturnType<typeof platform>);
    mockChatState.pendingDraft = {
      conversationId: 'visible-conv',
      text: '',
      references: [{ id: 'ref-1', display_label: 'BRCA1 exon 3' }],
    } as typeof mockChatState.pendingDraft;
    mockChatState.currentConversationId = 'another-open-conversation';
    mockChatState.conversations = [
      { id: 'visible-conv', title: 'Visible conversation', workspacePath: '/workspace' },
      {
        id: 'another-open-conversation',
        title: 'Other conversation',
        workspacePath: '/other-workspace',
      },
    ] as typeof mockChatState.conversations;
    mockChatState.sendMessage.mockImplementation(async (...args: unknown[]) => {
      const options = args[4] as { onNotStarted?: (error: UserMessage) => void };
      options.onNotStarted?.(userMessage('assistant.contributionRequired'));
      return 'rejected';
    });

    render(<FullChatView workspacePath="/workspace" conversationId="visible-conv" />);

    await waitFor(() => expect(screen.getByTestId('mock-reference-ref-1')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('chat-attach-button'));
    await waitFor(() => expect(screen.getByText('plasmid.gb')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('ai-input'), {
      target: { value: 'Which primers flank this exon?' },
    });
    fireEvent.click(screen.getByTestId('chat-send-button'));

    await waitFor(() => expect(mockChatState.sendMessage).toHaveBeenCalledTimes(1));
    expect(mockChatState.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('Which primers flank this exon?'),
      '/workspace',
      'visible-conv',
      ['ref-1'],
      {
        claimIfUnowned: true,
        activateConversation: true,
        onNotStarted: expect.any(Function),
        attachments: [
          expect.objectContaining({
            id: `attachment-${'a'.repeat(64)}`,
            name: 'plasmid.gb',
          }),
        ],
      }
    );
    await waitFor(() =>
      expect(screen.getByTestId('ai-input')).toHaveValue('Which primers flank this exon?')
    );
    expect(screen.getByText('plasmid.gb')).toBeInTheDocument();
    expect(screen.getByTestId('mock-reference-ref-1')).toBeInTheDocument();
    expect(screen.getByTestId('ai-error')).toHaveTextContent('contribution choice');
    expect(mockChatState.error).toBeNull();
  });

  it('does not overwrite a newer composer draft when an earlier send is rejected', async () => {
    let settleSend!: (result: 'accepted' | 'rejected') => void;
    mockChatState.sendMessage.mockImplementationOnce(
      () => new Promise<'accepted' | 'rejected'>((resolve) => (settleSend = resolve))
    );
    render(<FullChatView workspacePath="/workspace" />);

    const input = screen.getByTestId('ai-input');
    fireEvent.change(input, { target: { value: 'First submission' } });
    fireEvent.click(screen.getByTestId('chat-send-button'));
    fireEvent.change(input, { target: { value: 'New unsent draft' } });
    settleSend('rejected');

    await waitFor(() => expect(input).toHaveValue('New unsent draft'));
  });

  it('restores a rejected submission to its original conversation after the tab switches', async () => {
    let settleSend!: (result: 'accepted' | 'rejected') => void;
    mockChatState.currentConversationId = 'conversation-a';
    mockChatState.conversations = [
      { id: 'conversation-a', title: 'Conversation A' },
      { id: 'conversation-b', title: 'Conversation B' },
    ] as typeof mockChatState.conversations;
    mockChatState.sendMessage.mockImplementationOnce(
      () => new Promise<'accepted' | 'rejected'>((resolve) => (settleSend = resolve))
    );
    const { rerender } = render(
      <FullChatView workspacePath="/workspace" conversationId="conversation-a" />
    );

    const input = screen.getByTestId('ai-input');
    fireEvent.change(input, { target: { value: 'Preserve this rejected submission' } });
    fireEvent.click(screen.getByTestId('chat-send-button'));
    await waitFor(() => expect(input).toHaveValue(''));
    mockChatState.setComposerDraft.mockClear();

    mockChatState.currentConversationId = 'conversation-b';
    rerender(<FullChatView workspacePath="/workspace" conversationId="conversation-b" />);
    settleSend('rejected');

    await waitFor(() => {
      expect(mockChatState.setComposerDraft).toHaveBeenCalledWith('conversation-a', {
        text: 'Preserve this rejected submission',
        attachments: [],
        references: [],
      });
    });
    expect(screen.getByTestId('ai-input')).toHaveValue('');
  });
});

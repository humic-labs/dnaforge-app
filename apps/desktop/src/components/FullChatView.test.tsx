import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { blocksToMessages } from '../features/ai/orchestration/chat-projections';

import {
  beginResolvedReferenceRootActivation,
  completeResolvedReferenceRootActivation,
  encodeAgentActivityMessage,
  FullChatView,
  getFullChatViewReferenceRootCacheDiagnostics,
  getFullChatViewHarness,
  getEntityReferencesByIds,
  getMessageReferencesForMessages,
  rememberResolvedReferenceRoot,
  registerResolvedReferenceRootCacheOwner,
  releaseResolvedReferenceRootCacheOwner,
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

describe('FullChatView ordinary chat surface', () => {
  beforeEach(resetFullChatViewHarness);

  it.each([false, true])('keeps developer experiments out of chat with scoped=%s', (scoped) => {
    render(
      <FullChatView workspacePath="/workspace" conversationId="ordinary-chat" scoped={scoped} />
    );

    expect(screen.getByTestId('ai-input')).toBeInTheDocument();
    expect(screen.queryByTestId('molecular-harness-comparison-board')).not.toBeInTheDocument();
    expect(screen.queryByTestId('molecular-comparison-toggle')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Compare harness outcomes/ })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Prompt experiment/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open run comparison' })).not.toBeInTheDocument();
  });
});

describe('FullChatView resolved-reference owner bound', () => {
  beforeEach(resetFullChatViewHarness);

  it('catches the rejected initial history promise and leaves the scoped failure available to Retry', async () => {
    mockChatState.conversationHistoryRead = { status: 'error', hasLoaded: false };
    mockChatState.loadConversations.mockRejectedValueOnce(
      new Error('private native history diagnostic')
    );
    render(<FullChatView workspacePath="/workspace" conversationId="history-read-owner" />);
    fireEvent.click(await screen.findByTestId('ai-history-button'));
    await waitFor(() => expect(mockChatState.loadConversations).toHaveBeenCalledOnce());
    expect(await screen.findByTestId('ai-history-read-state')).toHaveTextContent(
      'Chat history could not be loaded'
    );
    expect(screen.getByRole('button', { name: 'Retry history' })).toBeEnabled();
    expect(screen.queryByText('No conversations yet')).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('private native history diagnostic');
  });

  it('keeps only the 256 most recently used workspace roots and reports real cache operations', () => {
    const cache = new Map<string, string>();
    const events: Array<{ kind: string; evictions: number; size: number }> = [];
    for (let index = 0; index < 300; index += 1) {
      rememberResolvedReferenceRoot(cache, `reference-${index}`, `/workspace-${index}`, (event) =>
        events.push(event)
      );
    }

    expect(cache).toHaveLength(256);
    expect(cache.has('reference-43')).toBe(false);
    expect(cache.get('reference-44')).toBe('/workspace-44');

    rememberResolvedReferenceRoot(cache, 'reference-44', '/workspace-44-refreshed', (event) =>
      events.push(event)
    );
    rememberResolvedReferenceRoot(cache, 'reference-300', '/workspace-300', (event) =>
      events.push(event)
    );

    expect(cache).toHaveLength(256);
    expect(cache.has('reference-45')).toBe(false);
    expect(cache.get('reference-44')).toBe('/workspace-44-refreshed');
    expect(events.filter((event) => event.kind === 'insert')).toHaveLength(301);
    expect(events.filter((event) => event.kind === 'hit')).toHaveLength(1);
    expect(events.reduce((total, event) => total + event.evictions, 0)).toBe(45);
    expect(events.at(-1)).toEqual({ kind: 'insert', evictions: 1, size: 256 });
  });

  it('registers one cache owner per mounted chat and releases it on unmount', async () => {
    expect(getFullChatViewReferenceRootCacheDiagnostics()).toEqual({
      activeOwners: 0,
      totalSize: 0,
      insertions: 0,
      hits: 0,
      evictions: 0,
      peakSize: 0,
      startedActivations: 0,
      activeActivations: 0,
      completedActivations: 0,
      successfulActivations: 0,
      failedActivations: 0,
      activationProtocolErrors: 0,
      targetResolutionsStarted: 0,
      activeTargetResolutions: 0,
      completedTargetResolutions: 0,
      abortedTargetResolutions: 0,
      entityOpensStarted: 0,
      activeEntityOpens: 0,
      completedEntityOpens: 0,
      abortedEntityOpens: 0,
      originPersistencesStarted: 0,
      activeOriginPersistences: 0,
      completedOriginPersistences: 0,
      abortedOriginPersistences: 0,
      owners: [],
      lastReleasedOwner: null,
    });

    const view = render(<FullChatView workspacePath="/workspace" conversationId="cache-owner" />);
    await waitFor(() =>
      expect(getFullChatViewReferenceRootCacheDiagnostics().activeOwners).toBe(1)
    );

    view.unmount();
    expect(getFullChatViewReferenceRootCacheDiagnostics()).toEqual({
      activeOwners: 0,
      totalSize: 0,
      insertions: 0,
      hits: 0,
      evictions: 0,
      peakSize: 0,
      startedActivations: 0,
      activeActivations: 0,
      completedActivations: 0,
      successfulActivations: 0,
      failedActivations: 0,
      activationProtocolErrors: 0,
      targetResolutionsStarted: 0,
      activeTargetResolutions: 0,
      completedTargetResolutions: 0,
      abortedTargetResolutions: 0,
      entityOpensStarted: 0,
      activeEntityOpens: 0,
      completedEntityOpens: 0,
      abortedEntityOpens: 0,
      originPersistencesStarted: 0,
      activeOriginPersistences: 0,
      completedOriginPersistences: 0,
      abortedOriginPersistences: 0,
      owners: [],
      lastReleasedOwner: expect.objectContaining({ ownerId: 1, mounted: false }),
    });
  });

  it('retains an unmounted owner until every activation settles', () => {
    const ownerId = registerResolvedReferenceRootCacheOwner();
    beginResolvedReferenceRootActivation(ownerId);
    beginResolvedReferenceRootActivation(ownerId);

    releaseResolvedReferenceRootCacheOwner(ownerId);
    expect(getFullChatViewReferenceRootCacheDiagnostics()).toMatchObject({
      activeOwners: 1,
      startedActivations: 2,
      activeActivations: 2,
      completedActivations: 0,
      owners: [{ ownerId, mounted: false, activeActivations: 2 }],
    });

    completeResolvedReferenceRootActivation(ownerId, true);
    expect(getFullChatViewReferenceRootCacheDiagnostics()).toMatchObject({
      activeOwners: 1,
      startedActivations: 2,
      activeActivations: 1,
      completedActivations: 1,
      successfulActivations: 1,
      failedActivations: 0,
    });

    completeResolvedReferenceRootActivation(ownerId, false);
    expect(getFullChatViewReferenceRootCacheDiagnostics()).toMatchObject({
      activeOwners: 0,
      activeActivations: 0,
      owners: [],
    });
  });
});

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

describe('FullChatView assistant route selector', () => {
  beforeEach(resetFullChatViewHarness);

  it('renders a pending agent approval inside the docked chat flow, never as a modal', () => {
    mockChatState.messages = [
      {
        id: 'approval-user-message',
        role: 'user',
        content: 'Clean the generated build output',
        createdAt: 1,
      },
    ];
    useDestructiveConfirmStore.getState().present({
      requestId: 'approval-request',
      toolName: 'Bash',
      operation: 'Run shell command',
      resolvedPath: '/workspace',
      command: 'rm -rf build',
      risk: 'destructive',
      riskSummary: 'This command can delete files or directories.',
    });

    render(<FullChatView workspacePath="/workspace" />);

    const chatScroll = screen.getByTestId('chat-messages-scroll');
    const approval = screen.getByTestId('agent-confirm-inline');
    expect(chatScroll).toContainElement(approval);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByTestId('chat-composer')).toBeInTheDocument();
  });

  it('shows an owned approval only in the matching chat conversation', () => {
    mockChatState.messages = [
      {
        id: 'approval-owner-message',
        role: 'user',
        content: 'Run the requested command',
        createdAt: 1,
      },
    ];
    useDestructiveConfirmStore.getState().present({
      requestId: 'owned-approval-request',
      conversationId: 'conversation-b',
      toolName: 'Bash',
      operation: 'Run shell command',
      resolvedPath: '/workspace',
      command: 'rm -rf build',
    });

    const { rerender } = render(
      <FullChatView workspacePath="/workspace" conversationId="conversation-a" scoped />
    );
    expect(screen.getByTestId('full-chat-view')).toHaveAttribute(
      'data-conversation-id',
      'conversation-a'
    );
    expect(screen.queryByTestId('agent-confirm-inline')).toBeNull();

    rerender(<FullChatView workspacePath="/workspace" conversationId="conversation-b" scoped />);
    expect(screen.getByTestId('full-chat-view')).toHaveAttribute(
      'data-conversation-id',
      'conversation-b'
    );
    expect(screen.getByTestId('agent-confirm-inline')).toBeInTheDocument();
  });

  it('sends pending AppBar prompts only through the matching chat tab conversation', async () => {
    mockChatState.pendingMessage = {
      conversationId: 'visible-conv',
      content: 'Scoped prompt from AppBar',
    };

    render(<FullChatView workspacePath="/workspace" conversationId="visible-conv" />);

    await waitFor(() => {
      expect(mockChatState.setPendingMessage).toHaveBeenCalledWith(null);
      expect(mockChatState.sendMessage).toHaveBeenCalledWith(
        'Scoped prompt from AppBar',
        '/workspace',
        'visible-conv',
        undefined,
        {
          claimIfUnowned: true,
          activateConversation: true,
          onNotStarted: expect.any(Function),
        }
      );
    });
  });

  it('does not steal pending AppBar prompts for a different chat tab', () => {
    mockChatState.pendingMessage = {
      conversationId: 'other-conv',
      content: 'This belongs to another tab',
    };

    render(<FullChatView workspacePath="/workspace" conversationId="visible-conv" />);

    expect(mockChatState.setPendingMessage).not.toHaveBeenCalledWith(null);
    expect(mockChatState.sendMessage).not.toHaveBeenCalled();
  });

  it('restores a pending AppBar prompt when the send is rejected before acceptance', async () => {
    mockChatState.pendingMessage = {
      conversationId: 'visible-conv',
      content: 'Keep this command palette prompt',
    };
    mockChatState.sendMessage.mockResolvedValueOnce('rejected');

    render(<FullChatView workspacePath="/workspace" conversationId="visible-conv" />);

    await waitFor(() => {
      expect(screen.getByTestId('ai-input')).toHaveValue('Keep this command palette prompt');
    });
    expect(mockChatState.setPendingMessage).toHaveBeenCalledWith(null);
  });

  it('seeds a pending draft into the composer without sending it', () => {
    mockChatState.pendingDraft = {
      conversationId: 'visible-conv',
      text: 'Tell me about this selection',
      references: [],
    };

    render(<FullChatView workspacePath="/workspace" conversationId="visible-conv" />);

    expect(mockChatState.sendMessage).not.toHaveBeenCalled();
    expect(mockChatState.setPendingDraft).toHaveBeenCalledWith(null);
    expect(screen.getByTestId('ai-input')).toHaveValue('Tell me about this selection');
  });

  it('cancels the pending draft focus retry when the chat unmounts', () => {
    vi.useFakeTimers();
    mockChatState.pendingDraft = {
      conversationId: 'visible-conv',
      text: 'Keep this draft',
      references: [],
    };

    const querySelector = document.querySelector.bind(document);
    const querySelectorSpy = vi
      .spyOn(document, 'querySelector')
      .mockImplementation((selector) =>
        selector === '[data-testid="ai-input"]' ? null : querySelector(selector)
      );
    let animationFrameCallback: FrameRequestCallback | null = null;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      animationFrameCallback = callback;
      return 17;
    });

    try {
      const { unmount } = render(
        <FullChatView workspacePath="/workspace" conversationId="visible-conv" />
      );

      expect(animationFrameCallback).not.toBeNull();
      act(() => animationFrameCallback?.(0));
      const focusAttemptsBeforeUnmount = querySelectorSpy.mock.calls.filter(
        ([selector]) => selector === '[data-testid="ai-input"]'
      ).length;

      unmount();
      act(() => vi.advanceTimersByTime(80));

      expect(
        querySelectorSpy.mock.calls.filter(([selector]) => selector === '[data-testid="ai-input"]')
      ).toHaveLength(focusAttemptsBeforeUnmount);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not cancel the pending draft focus retry when clearing the consumed draft rerenders', () => {
    mockChatState.pendingDraft = {
      conversationId: 'visible-conv',
      text: 'Keep this draft',
      references: [],
    };
    const cancelAnimationFrame = vi.spyOn(window, 'cancelAnimationFrame');
    let pendingDraftFrameCallback: FrameRequestCallback | null = null;
    let pendingDraftFrameId: number | null = null;
    let captureNextFrame = false;
    let nextFrameId = 23;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      const frameId = nextFrameId++;
      if (captureNextFrame) {
        pendingDraftFrameCallback = callback;
        pendingDraftFrameId = frameId;
        captureNextFrame = false;
      }
      return frameId;
    });
    const querySelector = document.querySelector.bind(document);
    let composerQueryCount = 0;
    vi.spyOn(document, 'querySelector').mockImplementation((selector) => {
      if (selector === '[data-testid="ai-input"]' && composerQueryCount++ === 0) {
        captureNextFrame = true;
        return null;
      }
      return querySelector(selector);
    });

    const rendered = render(
      <FullChatView workspacePath="/workspace" conversationId="visible-conv" />
    );
    mockChatState.pendingDraft = null;
    rendered.rerender(<FullChatView workspacePath="/workspace" conversationId="visible-conv" />);

    expect(pendingDraftFrameId).not.toBeNull();
    expect(cancelAnimationFrame).not.toHaveBeenCalledWith(pendingDraftFrameId);
    act(() => pendingDraftFrameCallback?.(0));
    expect(composerQueryCount).toBeGreaterThan(1);
  });

  it('scopes the stop button to the visible chat tab conversation', () => {
    mockChatState.messages = [{ id: 'm1', role: 'user', content: 'Question', createdAt: 1 }];
    mockChatState.isLoading = true;
    mockChatState.isStreaming = false;

    render(<FullChatView workspacePath="/workspace" conversationId="visible-conv" />);

    fireEvent.click(screen.getByTestId('ai-stop-button'));

    expect(mockChatState.stopGeneration).toHaveBeenCalledWith('visible-conv');
  });

  it('keeps an unresolved chat tab isolated from the globally active conversation draft', async () => {
    mockChatState.currentConversationId = 'durable-conv';
    mockChatState.messages = [{ id: 'm1', role: 'user', content: 'Question', createdAt: 1 }];
    mockChatState.isLoading = true;
    mockChatState.composerDrafts.set('durable-conv', {
      text: 'Draft owned by another conversation',
      attachments: [],
      references: [],
    });

    render(<FullChatView workspacePath="/workspace" conversationId="preminted-tab-conv" />);

    const input = screen.getByTestId('ai-input');
    expect(input).toHaveValue('');
    fireEvent.change(input, { target: { value: 'Draft owned by this tab' } });

    await waitFor(() => {
      expect(mockChatState.setComposerDraft).toHaveBeenCalledWith('preminted-tab-conv', {
        text: 'Draft owned by this tab',
        attachments: [],
        references: [],
      });
    });
    expect(mockChatState.setComposerDraft).not.toHaveBeenCalledWith(
      'durable-conv',
      expect.anything()
    );
  });

  it('keeps projected assistant rows stable when the composer rerenders after provider ID reuse', async () => {
    const providerItemId = 'assistant-text:codex-sdk:item_2';
    mockChatState.messages = [
      ...blocksToMessages(
        [{ type: 'text', id: providerItemId, content: 'First settled answer.' }],
        'turn-a'
      ),
      ...blocksToMessages(
        [{ type: 'text', id: providerItemId, content: 'Second settled answer.' }],
        'turn-b'
      ),
    ];
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      render(<FullChatView workspacePath="/workspace" conversationId="visible-conv" />);
      expect(screen.getAllByTestId('assistant-message')).toHaveLength(2);

      const input = screen.getByTestId('ai-input');
      await act(async () => {
        fireEvent.change(input, { target: { value: 'Line one\nLine two\nLine three' } });
        fireEvent.change(input, { target: { value: '' } });
        await Promise.resolve();
      });

      expect(screen.getAllByTestId('assistant-message')).toHaveLength(2);
      expect(consoleError.mock.calls.flat().join(' ')).not.toContain(
        'Encountered two children with the same key'
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it('scrolls only the bounded transcript synchronously and leaves it still during composer edits', async () => {
    mockChatState.messages = [
      {
        id: 'settled-assistant',
        turnId: 'settled-turn',
        role: 'assistant',
        content: 'A settled answer above a draft.',
        createdAt: 1,
      },
    ];
    const { rerender } = render(
      <FullChatView workspacePath="/workspace" conversationId="visible-conv" />
    );
    const scrollArea = screen.getByTestId('chat-messages-scroll');
    const input = screen.getByTestId('ai-input');
    Object.defineProperty(scrollArea, 'scrollHeight', { configurable: true, value: 640 });

    mockChatState.messages = [
      ...mockChatState.messages,
      {
        id: 'new-settled-assistant',
        turnId: 'new-settled-turn',
        role: 'assistant',
        content: 'A second settled answer.',
        createdAt: 2,
      },
    ];
    rerender(<FullChatView workspacePath="/workspace" conversationId="visible-conv" />);

    expect(scrollArea.scrollTop).toBe(640);
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();

    scrollArea.scrollTop = 120;
    await act(async () => {
      fireEvent.change(input, { target: { value: 'Line one\nLine two\nLine three' } });
      fireEvent.change(input, { target: { value: '' } });
      await Promise.resolve();
    });

    expect(scrollArea.scrollTop).toBe(120);
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it('wires the active conversation into the extracted history surface', () => {
    mockChatState.conversations = [
      {
        id: 'conv-1',
        title: 'Existing workspace chat',
        workspacePath: '/workspace',
        pinned: true,
        provider: 'openai',
        model: 'gpt-4o',
        createdAt: 1,
        updatedAt: 2,
      },
    ];
    mockChatState.currentConversationId = 'conv-1';

    render(<FullChatView workspacePath="/workspace" />);

    expect(screen.getByTestId('ai-history-launcher')).toBeInTheDocument();
    expect(screen.getByTestId('ai-active-conversation-title')).toHaveTextContent(
      'Existing workspace chat'
    );
  });

  it('hydrates a persisted tab when its active pointer exists but its transcript slice is cold', async () => {
    mockChatState.conversations = [
      {
        id: 'persisted-cold-conversation',
        title: 'Persisted cold conversation',
        workspacePath: '/workspace',
        pinned: false,
        provider: 'openai',
        model: 'gpt-4o',
        createdAt: 1,
        updatedAt: 2,
      },
    ];
    mockChatState.currentConversationId = 'persisted-cold-conversation';
    mockChatState._convStates = new Map();

    render(
      <FullChatView workspacePath="/workspace" conversationId="persisted-cold-conversation" />
    );

    await waitFor(() => {
      expect(mockChatState.hydrateConversation).toHaveBeenCalledWith('persisted-cold-conversation');
    });
    expect(mockChatState.switchConversation).not.toHaveBeenCalled();
  });

  it('does not reserve hidden history space in a headerless inline chat', () => {
    localStorage.setItem('waypoint:ai-history-pinned', 'true');
    try {
      render(<FullChatView workspacePath="/workspace" scoped hideHeader />);

      expect(screen.queryByTestId('ai-history-launcher')).not.toBeInTheDocument();
      expect(document.querySelector('[data-chat-drop-zone]')).not.toHaveAttribute(
        'data-history-pinned'
      );
      expect(screen.getByTestId('chat-composer').closest('.chat-content-rail')).toBeInTheDocument();
    } finally {
      localStorage.removeItem('waypoint:ai-history-pinned');
    }
  });

  it('copies the complete docked and scoped conversations instead of the global transcript', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    mockChatState.conversations = [
      {
        id: 'docked-A',
        title: 'Docked transcript',
        workspacePath: '/workspace',
        pinned: false,
        provider: 'openai',
        model: 'gpt-4o',
        createdAt: 1,
        updatedAt: 3,
      },
      {
        id: 'scoped-B',
        title: 'Scoped transcript',
        workspacePath: '/workspace',
        pinned: false,
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        createdAt: 1,
        updatedAt: 3,
      },
    ];
    mockChatState.currentConversationId = 'docked-A';
    mockChatState.messages = [
      { id: 'docked-user', role: 'user', content: 'DOCKED-QUESTION', createdAt: 1 },
      { id: 'docked-assistant', role: 'assistant', content: 'DOCKED-ANSWER', createdAt: 2 },
    ];

    const docked = render(<FullChatView workspacePath="/workspace" />);
    expect(screen.getByTestId('copy-thread-surface')).toHaveAttribute(
      'data-layout',
      'thread-toolbar'
    );
    expect(screen.getByTestId('copy-thread-surface')).not.toHaveClass('absolute');
    expect(screen.getByTestId('copy-thread-button')).toHaveAccessibleName('Copy transcript');
    expect(screen.getByTestId('copy-thread-button')).toHaveTextContent(/^$/);
    fireEvent.click(screen.getByTestId('copy-thread-button'));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const dockedMarkdown = writeText.mock.calls[0][0] as string;
    expect(dockedMarkdown).toContain('# Docked transcript');
    expect(dockedMarkdown).toContain('DOCKED-QUESTION');
    expect(dockedMarkdown).toContain('DOCKED-ANSWER');
    expect(dockedMarkdown).not.toContain('docked-A');
    expect(dockedMarkdown).not.toContain('**Surface:**');
    docked.unmount();

    writeText.mockClear();
    (mockChatState._convStates as Map<string, unknown>).set('scoped-B', {
      messages: [
        { id: 'scoped-user', role: 'user', content: 'SCOPED-QUESTION', createdAt: 1 },
        { id: 'scoped-assistant', role: 'assistant', content: 'SCOPED-ANSWER', createdAt: 2 },
      ],
      turns: {},
      activeTurnId: null,
      streamingBlocks: [],
      isLoading: false,
      isStreaming: false,
      error: null,
    });

    render(<FullChatView workspacePath="/workspace" conversationId="scoped-B" scoped hideHeader />);
    expect(screen.getByTestId('copy-thread-surface')).toHaveAttribute(
      'data-layout',
      'thread-toolbar'
    );
    expect(screen.getByTestId('copy-thread-surface')).not.toHaveClass('absolute');
    fireEvent.click(screen.getByTestId('copy-thread-button'));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const scopedMarkdown = writeText.mock.calls[0][0] as string;
    expect(scopedMarkdown).toContain('# Scoped transcript');
    expect(scopedMarkdown).toContain('SCOPED-QUESTION');
    expect(scopedMarkdown).toContain('SCOPED-ANSWER');
    expect(scopedMarkdown).not.toContain('DOCKED-QUESTION');
    expect(scopedMarkdown).not.toContain('scoped-B');
    expect(scopedMarkdown).not.toContain('**Surface:**');
  });

  it('keeps simple copy independent of references and loads them only for detailed copy', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    mockChatState.conversations = [
      {
        id: 'conv-refs',
        title: 'Referenced transcript',
        workspacePath: '/workspace',
        pinned: false,
        provider: 'openai',
        model: 'gpt-4o',
        createdAt: 1,
        updatedAt: 3,
      },
    ];
    mockChatState.currentConversationId = 'conv-refs';
    mockChatState.messages = [
      { id: 'user-ref', role: 'user', content: 'Use these inputs.', createdAt: 1 },
      { id: 'assistant-ref', role: 'assistant', content: 'Done.', createdAt: 2 },
    ];
    vi.mocked(getMessageReferencesForMessages).mockResolvedValue(
      new Map([
        ['user-ref', ['ref-second', 'ref-first']],
        ['assistant-ref', ['ref-first']],
      ])
    );
    vi.mocked(getEntityReferencesByIds).mockResolvedValue([
      {
        id: 'ref-first',
        entity_type: 'design',
        display_label: 'First design',
        locator: 'dnaforge://design/first',
        deep_link_params: null,
        data: null,
        source: 'test',
        status: 'created',
        workspace_scope: null,
        created_at: 1,
        updated_at: 1,
      },
      {
        id: 'ref-second',
        entity_type: 'file',
        display_label: 'second.gb',
        locator: 'git://workspace/second.gb',
        deep_link_params: null,
        data: null,
        source: 'test',
        status: 'created',
        workspace_scope: null,
        created_at: 1,
        updated_at: 1,
      },
    ]);

    render(<FullChatView workspacePath="/workspace" />);

    expect(getMessageReferencesForMessages).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('copy-thread-button'));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

    expect(getMessageReferencesForMessages).not.toHaveBeenCalled();
    expect(getEntityReferencesByIds).not.toHaveBeenCalled();
    const simpleMarkdown = writeText.mock.calls[0][0] as string;
    expect(simpleMarkdown).toContain('Use these inputs.');
    expect(simpleMarkdown).toContain('Done.');
    expect(simpleMarkdown).not.toMatch(/second\.gb|First design|Entities and files/);

    writeText.mockClear();
    fireEvent.contextMenu(screen.getByTestId('copy-thread-button'));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

    expect(getMessageReferencesForMessages).toHaveBeenCalledWith(['user-ref', 'assistant-ref']);
    expect(getEntityReferencesByIds).toHaveBeenCalledWith(['ref-second', 'ref-first']);
    const markdown = writeText.mock.calls[0][0] as string;
    expect(markdown.indexOf('- second.gb')).toBeLessThan(markdown.indexOf('- First design'));
    expect(markdown.match(/^- First design$/gm)).toHaveLength(1);

    writeText.mockClear();
    vi.mocked(getMessageReferencesForMessages).mockRejectedValue(
      new Error('message reference query unavailable')
    );
    fireEvent.contextMenu(screen.getByTestId('copy-thread-button'));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Could not prepare the complete thread. Reopen the chat, then try again.'
      )
    );
    expect(writeText).not.toHaveBeenCalled();
  });

  it('uses Escape in focused history to pause the active conversation before closing peek', () => {
    mockChatState.currentConversationId = 'visible-conv';
    mockChatState.messages = [{ id: 'active', role: 'user', content: 'Active turn', createdAt: 1 }];
    mockChatState.isLoading = true;

    render(<FullChatView workspacePath="/workspace" conversationId="visible-conv" />);
    fireEvent.focus(screen.getByTestId('ai-history-button'));
    const search = screen.getByTestId('ai-history-search');
    fireEvent.focus(search);
    fireEvent.keyDown(search, { key: 'Escape' });

    expect(mockChatState.stopGeneration).toHaveBeenCalledWith('visible-conv');
    expect(screen.getByTestId('ai-history-panel')).toHaveAttribute('data-history-mode', 'floating');
  });
});

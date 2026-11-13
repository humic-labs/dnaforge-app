import { expectToastCall } from '../../test/toast-assertions';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentUserInputStore } from '../../features/ai/agent-confirm/agent-user-input-store';
import { useDestructiveConfirmStore } from '../../features/ai/agent-confirm/destructive-confirm-store';
import type {
  ConversationHistoryReadState,
  ConversationSummary,
} from '../../features/ai/hooks/useChat';
import { TAB_PORTAL_HOST_ATTACHED_EVENT } from '../../shared/tab-portal-contract';
import { ChatHistorySurface } from './ChatHistorySurface';

const mockActions = vi.hoisted(() => ({
  conversationHistoryRead: { status: 'ready', hasLoaded: true } as ConversationHistoryReadState,
  newConversation: vi.fn(),
  switchConversation: vi.fn(),
  deleteConversation: vi.fn(),
  togglePin: vi.fn(),
  renameConversation: vi.fn(),
  loadConversations: vi.fn(),
  addToast: vi.fn(),
  forkConversation: vi.fn(),
}));

vi.mock('../../features/ai/hooks/useChat', () => ({
  useChatStore: (selector: (state: typeof mockActions) => unknown) => selector(mockActions),
}));

vi.mock('../../stores/toast-store', () => ({
  useToastStore: {
    getState: () => ({ addToast: mockActions.addToast }),
  },
}));

vi.mock('../../platform', () => ({
  platform: () => ({
    agentCapabilities: {
      forkConversation: mockActions.forkConversation,
    },
  }),
}));

vi.mock('./MessageFormatting', () => ({ formatTimeAgo: () => 'now' }));

const conversations: ConversationSummary[] = [
  {
    id: 'conv-1',
    title: 'First conversation',
    workspacePath: '/workspace',
    pinned: false,
    provider: null,
    model: null,
    createdAt: 1,
    updatedAt: 2,
  },
  {
    id: 'conv-2',
    title: 'Second conversation',
    workspacePath: '/workspace',
    pinned: true,
    provider: null,
    model: null,
    createdAt: 2,
    updatedAt: 3,
  },
];

function rect(left: number, top = 0, width = 243, height = 720): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

interface RenderSurfaceOptions {
  conversations?: ConversationSummary[];
  anchor?: HTMLElement | null;
  pinned?: boolean;
  isOpen?: boolean;
  isBusy?: boolean;
  queuedMessageCount?: number;
  setPinned?: (pinned: boolean) => void;
  onConversationIdChange?: (id: string) => void;
  onRequestPanelFocus?: () => void;
  onPinnedLayoutChange?: (pinned: boolean) => void;
  onPause?: () => void;
}

function renderSurface(options: RenderSurfaceOptions = {}) {
  const anchor = options.anchor === undefined ? document.createElement('div') : options.anchor;
  if (anchor && !anchor.isConnected) {
    anchor.dataset.historyTestAnchor = 'true';
    document.body.append(anchor);
  }
  const input = document.createElement('textarea');
  input.dataset.historyTestInput = 'true';
  document.body.append(input);
  const inputRef = { current: input };

  const props = {
    anchor,
    inputRef,
    workspacePath: '/workspace',
    viewConversationId: 'conv-1',
    conversations: options.conversations ?? conversations,
    pinned: options.pinned ?? false,
    setPinned: options.setPinned ?? vi.fn(),
    isOpen: options.isOpen ?? true,
    isBusy: options.isBusy ?? false,
    queuedMessageCount: options.queuedMessageCount ?? 0,
    onConversationIdChange: options.onConversationIdChange,
    onRequestPanelFocus: options.onRequestPanelFocus,
    onPinnedLayoutChange: options.onPinnedLayoutChange,
    onPause: options.onPause ?? vi.fn(),
  };
  const result = render(<ChatHistorySurface {...props} />);
  return { ...result, anchor, input, props };
}

describe('ChatHistorySurface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockActions.conversationHistoryRead = { status: 'ready', hasLoaded: true };
    mockActions.newConversation.mockResolvedValue('new-conv');
    mockActions.switchConversation.mockResolvedValue('applied');
    mockActions.deleteConversation.mockResolvedValue(null);
    mockActions.renameConversation.mockResolvedValue(undefined);
    mockActions.togglePin.mockResolvedValue(undefined);
    mockActions.loadConversations.mockResolvedValue(undefined);
    mockActions.forkConversation.mockResolvedValue({
      ok: true,
      conversationId: 'conv-forked',
      parentConversationId: 'conv-1',
    });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 720 });
  });

  afterEach(() => {
    useDestructiveConfirmStore.getState().clear();
    useAgentUserInputStore.getState().clear();
    vi.restoreAllMocks();
    document
      .querySelectorAll('[data-history-test-anchor], [data-history-test-input]')
      .forEach((element) => element.remove());
  });

  it('does not claim empty history before a successful read', async () => {
    mockActions.conversationHistoryRead = { status: 'idle', hasLoaded: false };
    const view = renderSurface({ pinned: true, conversations: [] });
    expect(screen.queryByText('No conversations yet')).not.toBeInTheDocument();
    expect(await screen.findByTestId('ai-history-read-state')).toHaveTextContent('has not loaded');
    expect(screen.getByRole('button', { name: 'Load history' })).toBeEnabled();
    expect(screen.queryByText('No conversations yet')).not.toBeInTheDocument();
    mockActions.conversationHistoryRead = { status: 'loading', hasLoaded: false };
    view.rerender(<ChatHistorySurface {...view.props} />);
    expect(screen.getByTestId('ai-history-read-state')).toHaveTextContent('Loading chats');
    expect(screen.queryByTestId('ai-history-empty')).not.toBeInTheDocument();
  });

  it('shows a bounded first-read failure and catches an explicit Retry rejection', async () => {
    mockActions.conversationHistoryRead = { status: 'error', hasLoaded: false };
    mockActions.loadConversations.mockRejectedValueOnce(new Error('private read diagnostic'));
    renderSurface({ pinned: true, conversations: [] });
    expect(await screen.findByTestId('ai-history-read-state')).toHaveTextContent(
      'Some chats may be missing'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry history' }));
    await waitFor(() => expect(mockActions.loadConversations).toHaveBeenCalledOnce());
    expect(screen.queryByTestId('ai-history-empty')).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('private read diagnostic');
  });

  it('keeps saved rows and their actions available under a failed refresh', async () => {
    mockActions.conversationHistoryRead = { status: 'error', hasLoaded: true };
    renderSurface({ pinned: true });
    expect(await screen.findByTestId('ai-history-read-state')).toHaveTextContent(
      'saved list may be out of date'
    );
    expect(screen.getAllByTestId('conversation-item')).toHaveLength(2);
    expect(
      screen.getByRole('button', { name: 'Open conversation: First conversation' })
    ).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Retry history' })).toBeEnabled();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search chats' }), {
      target: { value: 'unmatched title' },
    });
    expect(screen.getByTestId('ai-history-no-match')).toHaveTextContent(
      'No matches in the saved list'
    );
    expect(screen.queryByTestId('ai-history-empty')).not.toBeInTheDocument();
  });

  it('distinguishes a confirmed empty read from title-filter no-match and an in-flight refresh', async () => {
    const view = renderSurface({ pinned: true, conversations: [] });
    expect(await screen.findByTestId('ai-history-empty')).toHaveTextContent('No conversations yet');
    expect(screen.getByTestId('ai-history-empty')).toHaveTextContent('after their first message');
    view.rerender(<ChatHistorySurface {...view.props} conversations={conversations} />);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search chats' }), {
      target: { value: 'not in any title' },
    });
    expect(screen.getByTestId('ai-history-no-match')).toHaveTextContent('No matching chats');
    expect(screen.queryByTestId('ai-history-empty')).not.toBeInTheDocument();
    mockActions.conversationHistoryRead = { status: 'loading', hasLoaded: true };
    view.rerender(<ChatHistorySurface {...view.props} conversations={conversations} />);
    expect(screen.getByTestId('ai-history-read-state')).toHaveTextContent('Refreshing chats');
    expect(screen.getByTestId('ai-history-no-match')).toHaveTextContent('saved list');
  });

  it('marks another chat that is waiting for an answer', async () => {
    useAgentUserInputStore.getState().present({
      requestId: 'waiting-question',
      conversationId: 'conv-2',
      provider: 'grok-acp',
      questions: [
        {
          id: 'continue',
          header: 'Check',
          prompt: 'Continue this turn?',
          options: [],
          multiSelect: false,
          allowFreeText: true,
        },
      ],
    });

    renderSurface();
    fireEvent.mouseEnter(await screen.findByTestId('ai-history-launcher'));

    const waitingRow = screen
      .getByText('Second conversation')
      .closest('[data-testid="conversation-item"]');
    expect(waitingRow).not.toBeNull();
    expect(within(waitingRow as HTMLElement).getByTestId('conversation-waiting')).toHaveTextContent(
      'Waiting'
    );
    expect(
      screen.getByText('First conversation').closest('[data-testid="conversation-item"]')
    ).not.toHaveTextContent('Waiting');
    expect(screen.getByTestId('ai-history-waiting-dot')).toBeInTheDocument();
    expect(screen.getByTestId('ai-history-button')).toHaveAttribute(
      'aria-label',
      'Pin conversation sidebar. Another chat is waiting for you.'
    );
  });

  it('keeps the waiting mark on the open chat without flagging the history button', async () => {
    useDestructiveConfirmStore.getState().present({
      requestId: 'waiting-approval',
      conversationId: 'conv-1',
      toolName: 'Bash',
      operation: 'Run shell command',
      resolvedPath: '/workspace',
      command: 'rm -rf build',
    });

    renderSurface();
    fireEvent.mouseEnter(await screen.findByTestId('ai-history-launcher'));

    const openRow = screen
      .getByText('First conversation')
      .closest('[data-testid="conversation-item"]');
    expect(within(openRow as HTMLElement).getByTestId('conversation-waiting')).toHaveTextContent(
      'Waiting'
    );
    expect(screen.queryByTestId('ai-history-waiting-dot')).toBeNull();
    expect(screen.getByTestId('ai-history-button')).toHaveAttribute(
      'aria-label',
      'Pin conversation sidebar'
    );
  });

  it('mounts only after its anchor exists and clamps a narrow right-pane flyout to the viewport', async () => {
    const { rerender, props } = renderSurface({ anchor: null });
    expect(screen.queryByTestId('ai-history-launcher')).not.toBeInTheDocument();

    const anchor = document.createElement('div');
    anchor.getBoundingClientRect = () => rect(557);
    document.body.append(anchor);
    rerender(<ChatHistorySurface {...props} anchor={anchor} />);

    await waitFor(() => {
      expect(screen.getByTestId('ai-history-launcher')).toHaveStyle({ left: '473px' });
    });
    fireEvent.mouseEnter(screen.getByTestId('ai-history-launcher'));
    expect(screen.getByTestId('ai-history-panel')).toHaveAttribute('data-history-mode', 'floating');
  });

  it('restores the pinned panel with its late launcher without requesting a pin toggle', async () => {
    const setPinned = vi.fn();
    const { rerender, props } = renderSurface({ anchor: null, pinned: true, setPinned });
    expect(screen.queryByTestId('ai-history-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ai-history-panel')).not.toBeInTheDocument();

    const anchor = document.createElement('div');
    anchor.dataset.historyTestAnchor = 'true';
    anchor.getBoundingClientRect = () => rect(100);
    document.body.append(anchor);
    rerender(<ChatHistorySurface {...props} anchor={anchor} />);

    const toggle = await screen.findByTestId('ai-history-button');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('ai-history-panel')).toHaveAttribute('data-history-mode', 'pinned');
    expect(setPinned).not.toHaveBeenCalled();
  });

  it('remeasures when a stable tab portal moves between equal-sized panes', async () => {
    const anchor = document.createElement('div');
    let anchorLeft = 100;
    anchor.getBoundingClientRect = () => rect(anchorLeft);
    const { unmount } = renderSurface({ anchor });

    await waitFor(() =>
      expect(screen.getByTestId('ai-history-launcher')).toHaveStyle({ left: '116px' })
    );
    anchorLeft = 500;
    window.dispatchEvent(new Event(TAB_PORTAL_HOST_ATTACHED_EVENT));
    await waitFor(() =>
      expect(screen.getByTestId('ai-history-launcher')).toHaveStyle({ left: '473px' })
    );
    unmount();
  });

  it('keeps one toggle stable across peek and pin, with keyboard-reachable search and rows', async () => {
    const setPinned = vi.fn();
    renderSurface({ setPinned });
    const toggle = await screen.findByTestId('ai-history-button');
    fireEvent.focus(toggle);
    const panel = await screen.findByTestId('ai-history-panel');
    expect(panel).toHaveAttribute('data-history-mode', 'floating');
    expect(within(panel).getByRole('searchbox', { name: 'Search chats' })).toBeInTheDocument();
    expect(
      within(panel).getByRole('button', { name: 'Open conversation: First conversation' })
    ).toHaveAttribute('aria-current', 'page');

    fireEvent.click(toggle);
    expect(setPinned).toHaveBeenCalledWith(true);
    expect(screen.getByTestId('ai-history-button')).toBe(toggle);
  });

  it('keeps the saved title when hovered, focused, or clicked', async () => {
    renderSurface();

    const titleButton = await screen.findByTestId('ai-active-conversation-title-button');
    expect(titleButton).toHaveAttribute('aria-expanded', 'false');
    expect(titleButton).not.toHaveAttribute('title');
    expect(titleButton).toHaveTextContent('First conversation');
    expect(titleButton).toHaveAttribute('aria-label', 'Conversation title: First conversation');
    expect(screen.queryByTestId('ai-history-panel')).not.toBeInTheDocument();

    fireEvent.mouseEnter(titleButton);
    expect(titleButton).toHaveAttribute('aria-expanded', 'true');
    expect(titleButton).toHaveTextContent('First conversation');
    expect(screen.queryByTestId('ai-history-panel')).not.toBeInTheDocument();

    fireEvent.mouseLeave(titleButton);
    expect(titleButton).toHaveAttribute('aria-expanded', 'false');
    expect(titleButton).toHaveTextContent('First conversation');

    fireEvent.focus(titleButton);
    expect(titleButton).toHaveAttribute('aria-expanded', 'true');
    expect(titleButton).toHaveTextContent('First conversation');
    expect(screen.queryByTestId('ai-history-panel')).not.toBeInTheDocument();

    fireEvent.click(titleButton);
    expect(titleButton).toHaveTextContent('First conversation');
    expect(screen.queryByTestId('ai-history-panel')).not.toBeInTheDocument();

    fireEvent.focus(screen.getByTestId('ai-history-button'));
    expect(await screen.findByTestId('ai-history-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-active-conversation-title-button')).not.toBeInTheDocument();
  });

  it('carries the source draft identity through New and Switch and dismisses only a transient panel', async () => {
    const onConversationIdChange = vi.fn();
    const { input } = renderSurface({ onConversationIdChange });
    fireEvent.mouseEnter(await screen.findByTestId('ai-history-launcher'));
    fireEvent.click(screen.getByRole('button', { name: 'New conversation' }));

    await waitFor(() => {
      expect(mockActions.newConversation).toHaveBeenCalledWith('/workspace', {
        sourceConversationId: 'conv-1',
      });
    });
    expect(onConversationIdChange).toHaveBeenCalledWith('new-conv');
    expect(input).toHaveFocus();
    expect(screen.queryByTestId('ai-history-panel')).not.toBeInTheDocument();

    fireEvent.mouseLeave(screen.getByTestId('ai-history-launcher'));
    fireEvent.mouseEnter(screen.getByTestId('ai-history-launcher'));
    fireEvent.click(screen.getByRole('button', { name: 'Open conversation: Second conversation' }));
    await waitFor(() => {
      expect(mockActions.switchConversation).toHaveBeenCalledWith('conv-2', {
        sourceConversationId: 'conv-1',
        workspacePath: '/workspace',
      });
    });
  });

  it('puts the visible row padding inside the primary conversation button', async () => {
    renderSurface();
    fireEvent.mouseEnter(await screen.findByTestId('ai-history-launcher'));

    const row = screen.getAllByTestId('conversation-item')[1];
    const button = within(row).getByTestId('conversation-open-button');
    const actions = within(row).getByTestId('ai-rename-button').parentElement;
    expect(row).not.toHaveClass('px-2.5', 'py-1.5');
    expect(button).toHaveClass('block', 'w-full', 'px-2.5', 'py-1.5');
    expect(button.parentElement).toBe(row);
    expect(actions).toHaveClass('z-10');

    fireEvent.click(within(row).getByTestId('ai-rename-button'));
    expect(within(row).getByTestId('ai-rename-input')).toBeInTheDocument();
    expect(within(row).queryByTestId('ai-rename-button')).not.toBeInTheDocument();
  });

  it('keeps a rejected rename draft and offers an explicit retry without exposing the native error', async () => {
    mockActions.renameConversation.mockRejectedValueOnce(new Error('private native diagnostic'));
    const { props } = renderSurface({ pinned: true });
    const row = (await screen.findAllByTestId('conversation-item'))[0];
    fireEvent.click(within(row).getByTestId('ai-rename-button'));
    const input = within(row).getByTestId('ai-rename-input');
    fireEvent.change(input, { target: { value: 'Intended manual name' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(within(row).getByRole('alert')).toHaveTextContent("Couldn't rename this chat")
    );
    expect(input).toHaveValue('Intended manual name');
    expect(props.conversations[0].title).toBe('First conversation');
    expect(document.body).not.toHaveTextContent('private native diagnostic');
    fireEvent.blur(input);
    expect(mockActions.renameConversation).toHaveBeenCalledOnce();
    fireEvent.click(within(row).getByRole('button', { name: 'Retry rename' }));
    await waitFor(() =>
      expect(within(row).queryByTestId('ai-rename-input')).not.toBeInTheDocument()
    );
    expect(mockActions.renameConversation.mock.calls).toEqual([
      ['conv-1', 'Intended manual name'],
      ['conv-1', 'Intended manual name'],
    ]);
  });

  it('admits Enter followed by blur once for a pending rename generation', async () => {
    const write = deferred<void>();
    mockActions.renameConversation.mockReturnValueOnce(write.promise);
    renderSurface({ pinned: true });
    const row = (await screen.findAllByTestId('conversation-item'))[0];
    fireEvent.click(within(row).getByTestId('ai-rename-button'));
    const input = within(row).getByTestId('ai-rename-input');
    fireEvent.change(input, { target: { value: 'One accepted rename' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);
    expect(mockActions.renameConversation).toHaveBeenCalledOnce();
    await act(async () => {
      write.resolve();
      await write.promise;
    });
    expect(within(row).queryByTestId('ai-rename-input')).not.toBeInTheDocument();
  });

  it('does not let rename A completion clear editing B', async () => {
    const write = deferred<void>();
    mockActions.renameConversation.mockReturnValueOnce(write.promise);
    renderSurface({ pinned: true });
    const [a, b] = await screen.findAllByTestId('conversation-item');
    fireEvent.click(within(a).getByTestId('ai-rename-button'));
    fireEvent.change(within(a).getByTestId('ai-rename-input'), { target: { value: 'Saved A' } });
    fireEvent.keyDown(within(a).getByTestId('ai-rename-input'), { key: 'Enter' });
    fireEvent.click(within(b).getByTestId('ai-rename-button'));
    fireEvent.change(within(b).getByTestId('ai-rename-input'), { target: { value: 'Unsaved B' } });
    await act(async () => {
      write.resolve();
      await write.promise;
    });
    expect(within(b).getByTestId('ai-rename-input')).toHaveValue('Unsaved B');
    expect(mockActions.renameConversation).toHaveBeenCalledOnce();
  });

  it('keeps a newer edit of the same row when an earlier rename settles', async () => {
    const write = deferred<void>();
    mockActions.renameConversation.mockReturnValueOnce(write.promise);
    renderSurface({ pinned: true });
    const row = (await screen.findAllByTestId('conversation-item'))[0];
    fireEvent.click(within(row).getByTestId('ai-rename-button'));
    const input = within(row).getByTestId('ai-rename-input');
    fireEvent.change(input, { target: { value: 'Earlier submitted name' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.change(input, { target: { value: 'New independent draft' } });
    await act(async () => {
      write.resolve();
      await write.promise;
    });
    expect(input).toHaveValue('New independent draft');
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(within(row).queryByTestId('ai-rename-input')).not.toBeInTheDocument()
    );
    expect(mockActions.renameConversation.mock.calls).toEqual([
      ['conv-1', 'Earlier submitted name'],
      ['conv-1', 'New independent draft'],
    ]);
  });

  it('retains failed A for row-local retry while B keeps its independent edit', async () => {
    const write = deferred<void>();
    mockActions.renameConversation.mockReturnValueOnce(write.promise);
    renderSurface({ pinned: true });
    const [a, b] = await screen.findAllByTestId('conversation-item');
    fireEvent.click(within(a).getByTestId('ai-rename-button'));
    fireEvent.change(within(a).getByTestId('ai-rename-input'), {
      target: { value: 'Retry this A' },
    });
    fireEvent.keyDown(within(a).getByTestId('ai-rename-input'), { key: 'Enter' });
    fireEvent.click(within(b).getByTestId('ai-rename-button'));
    fireEvent.change(within(b).getByTestId('ai-rename-input'), {
      target: { value: 'Keep editing B' },
    });
    await act(async () => {
      write.reject(new Error('synthetic refusal'));
      await write.promise.catch(() => undefined);
    });
    expect(within(a).getByRole('alert')).toHaveTextContent('Your edit is kept');
    expect(within(b).getByTestId('ai-rename-input')).toHaveValue('Keep editing B');
    fireEvent.click(within(a).getByRole('button', { name: 'Retry rename' }));
    await waitFor(() => expect(within(a).queryByRole('alert')).not.toBeInTheDocument());
    expect(within(b).getByTestId('ai-rename-input')).toHaveValue('Keep editing B');
    expect(mockActions.renameConversation).toHaveBeenLastCalledWith('conv-1', 'Retry this A');
  });

  it('does not replace a newer same-row draft with an earlier rejected edit', async () => {
    const write = deferred<void>();
    mockActions.renameConversation.mockReturnValueOnce(write.promise);
    renderSurface({ pinned: true });
    const row = (await screen.findAllByTestId('conversation-item'))[0];
    fireEvent.click(within(row).getByTestId('ai-rename-button'));
    const input = within(row).getByTestId('ai-rename-input');
    fireEvent.change(input, { target: { value: 'Earlier rejected name' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.change(input, { target: { value: 'Latest intended edit' } });
    await act(async () => {
      write.reject(new Error('synthetic refusal'));
      await write.promise.catch(() => undefined);
    });
    expect(input).toHaveValue('Latest intended edit');
    expect(within(row).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not restore an older failed draft after a newer same-row submission and a move to B', async () => {
    const oldWrite = deferred<void>();
    const newWrite = deferred<void>();
    mockActions.renameConversation
      .mockReturnValueOnce(oldWrite.promise)
      .mockReturnValueOnce(newWrite.promise);
    renderSurface({ pinned: true });
    const [a, b] = await screen.findAllByTestId('conversation-item');
    fireEvent.click(within(a).getByTestId('ai-rename-button'));
    const input = within(a).getByTestId('ai-rename-input');
    fireEvent.change(input, { target: { value: 'Superseded A' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.change(input, { target: { value: 'Latest submitted A' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(within(b).getByTestId('ai-rename-button'));
    fireEvent.change(within(b).getByTestId('ai-rename-input'), {
      target: { value: 'Independent B' },
    });
    await act(async () => {
      oldWrite.reject(new Error('old refusal'));
      await oldWrite.promise.catch(() => undefined);
    });
    await act(async () => {
      newWrite.resolve();
      await newWrite.promise;
    });
    expect(within(a).queryByRole('alert')).not.toBeInTheDocument();
    expect(within(b).getByTestId('ai-rename-input')).toHaveValue('Independent B');
    expect(mockActions.renameConversation.mock.calls).toEqual([
      ['conv-1', 'Superseded A'],
      ['conv-1', 'Latest submitted A'],
    ]);
  });

  it('retires an Escape-dismissed generation so its late rejection cannot return or clear editing B', async () => {
    const write = deferred<void>();
    mockActions.renameConversation.mockReturnValueOnce(write.promise);
    renderSurface({ pinned: true });
    const [a, b] = await screen.findAllByTestId('conversation-item');
    fireEvent.click(within(a).getByTestId('ai-rename-button'));
    const input = within(a).getByTestId('ai-rename-input');
    fireEvent.change(input, { target: { value: 'Dismissed pending A' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.click(within(b).getByTestId('ai-rename-button'));
    fireEvent.change(within(b).getByTestId('ai-rename-input'), {
      target: { value: 'Keep editing B' },
    });
    await act(async () => {
      write.reject(new Error('late refusal'));
      await write.promise.catch(() => undefined);
    });
    expect(within(a).queryByRole('alert')).not.toBeInTheDocument();
    expect(within(b).getByTestId('ai-rename-input')).toHaveValue('Keep editing B');
    fireEvent.keyDown(within(b).getByTestId('ai-rename-input'), { key: 'Escape' });
    fireEvent.click(within(a).getByTestId('ai-rename-button'));
    expect(within(a).getByTestId('ai-rename-input')).toHaveValue('First conversation');
    expect(mockActions.renameConversation).toHaveBeenCalledOnce();
  });

  it('keeps a failed pin confirmed, catches its rejection, and retries without blocking another row', async () => {
    mockActions.togglePin.mockRejectedValueOnce(new Error('private native pin diagnostic'));
    const onConversationIdChange = vi.fn();
    const { props } = renderSurface({ pinned: true, onConversationIdChange });
    const [a, b] = await screen.findAllByTestId('conversation-item');
    fireEvent.click(within(a).getByTitle('Pin conversation'));
    await waitFor(() =>
      expect(within(a).getByRole('alert')).toHaveTextContent("Couldn't change this chat's pin")
    );
    expect(props.conversations[0].pinned).toBe(false);
    expect(document.body).not.toHaveTextContent('private native pin diagnostic');
    fireEvent.click(within(b).getByTestId('conversation-open-button'));
    await waitFor(() => expect(onConversationIdChange).toHaveBeenCalledWith('conv-2'));
    fireEvent.click(within(a).getByRole('button', { name: 'Retry pin' }));
    await waitFor(() => expect(within(a).queryByRole('alert')).not.toBeInTheDocument());
    expect(mockActions.togglePin.mock.calls).toEqual([['conv-1'], ['conv-1']]);
  });

  it('does not admit two same-surface pin gestures while its own call is pending', async () => {
    const write = deferred<void>();
    mockActions.togglePin.mockReturnValueOnce(write.promise);
    renderSurface({ pinned: true });
    const [a, b] = await screen.findAllByTestId('conversation-item');
    const pin = within(a).getByTitle('Pin conversation');
    fireEvent.click(pin);
    fireEvent.click(pin);
    expect(pin).toBeDisabled();
    expect(within(b).getByTestId('conversation-open-button')).toBeEnabled();
    expect(mockActions.togglePin).toHaveBeenCalledOnce();
    await act(async () => {
      write.resolve();
      await write.promise;
    });
    expect(pin).toBeEnabled();
  });

  it('does not revive an editor removed by a deletion in another surface', async () => {
    const write = deferred<void>();
    mockActions.renameConversation.mockReturnValueOnce(write.promise);
    const view = renderSurface({ pinned: true });
    const row = (await screen.findAllByTestId('conversation-item'))[0];
    fireEvent.click(within(row).getByTestId('ai-rename-button'));
    fireEvent.change(within(row).getByTestId('ai-rename-input'), {
      target: { value: 'Deleted draft' },
    });
    fireEvent.keyDown(within(row).getByTestId('ai-rename-input'), { key: 'Enter' });
    view.rerender(<ChatHistorySurface {...view.props} conversations={[conversations[1]]} />);
    await act(async () => {
      write.resolve();
      await write.promise;
    });
    expect(screen.queryByTestId('ai-rename-input')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('conversation-item')).toHaveLength(1);
    expect(screen.getByText('Second conversation')).toBeInTheDocument();
  });

  it('forks a conversation, reloads history, and switches only after the durable copy exists', async () => {
    const onConversationIdChange = vi.fn();
    renderSurface({ onConversationIdChange });
    fireEvent.mouseEnter(await screen.findByTestId('ai-history-launcher'));
    const activeRow = screen.getAllByTestId('conversation-item')[0];
    fireEvent.mouseEnter(activeRow);
    fireEvent.click(
      within(activeRow).getByRole('button', { name: 'Fork conversation: First conversation' })
    );

    await waitFor(() => expect(mockActions.forkConversation).toHaveBeenCalledOnce());
    expect(mockActions.forkConversation).toHaveBeenCalledWith({ conversationId: 'conv-1' });
    expect(mockActions.loadConversations).toHaveBeenCalledOnce();
    expect(mockActions.switchConversation).toHaveBeenCalledWith('conv-forked', {
      sourceConversationId: 'conv-1',
      workspacePath: '/workspace',
    });
    expect(onConversationIdChange).toHaveBeenCalledWith('conv-forked');
  });

  it('focuses the replacement composer after the new conversation commits', async () => {
    const anchor = document.createElement('div');
    anchor.dataset.historyTestAnchor = 'true';
    document.body.append(anchor);
    function ChatPane() {
      const [id, setId] = useState('conv-1');
      const inputRef = useRef<HTMLTextAreaElement>(null);
      return (
        <>
          <textarea key={id} ref={inputRef} aria-label="Composer" data-conversation-id={id} />
          <ChatHistorySurface
            anchor={anchor}
            inputRef={inputRef}
            workspacePath="/workspace"
            viewConversationId={id}
            conversations={conversations}
            pinned={false}
            setPinned={vi.fn()}
            isOpen
            isBusy={false}
            queuedMessageCount={0}
            onConversationIdChange={setId}
            onPause={vi.fn()}
          />
        </>
      );
    }
    render(<ChatPane />);
    fireEvent.click(await screen.findByRole('button', { name: 'New conversation' }));
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Composer' })).toHaveAttribute(
        'data-conversation-id',
        'new-conv'
      )
    );
    expect(screen.getByRole('textbox', { name: 'Composer' })).toHaveFocus();
  });

  it('focuses a new empty composer mounted after the history sibling', async () => {
    const anchor = document.createElement('div');
    anchor.dataset.historyTestAnchor = 'true';
    document.body.append(anchor);
    function ChatPane() {
      const [id, setId] = useState('conv-1');
      const inputRef = useRef<HTMLTextAreaElement>(null);
      return (
        <>
          <ChatHistorySurface
            anchor={anchor}
            inputRef={inputRef}
            workspacePath="/workspace"
            viewConversationId={id}
            conversations={conversations}
            pinned={false}
            setPinned={vi.fn()}
            isOpen
            isBusy={false}
            queuedMessageCount={0}
            onConversationIdChange={setId}
            onPause={vi.fn()}
          />
          {id === 'conv-1' ? (
            <div>
              <textarea ref={inputRef} aria-label="Original composer" />
            </div>
          ) : (
            <section>
              <textarea ref={inputRef} aria-label="Empty composer" />
            </section>
          )}
        </>
      );
    }
    render(<ChatPane />);
    fireEvent.click(await screen.findByRole('button', { name: 'New conversation' }));
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Empty composer' })).toHaveFocus()
    );
  });

  it('coalesces rapid New clicks into one durable conversation operation', async () => {
    let resolveNew!: (id: string) => void;
    mockActions.newConversation.mockImplementationOnce(
      () => new Promise<string>((resolve) => (resolveNew = resolve))
    );
    const onConversationIdChange = vi.fn();
    renderSurface({ onConversationIdChange });
    fireEvent.mouseEnter(await screen.findByTestId('ai-history-launcher'));
    const button = screen.getByRole('button', { name: 'New conversation' });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(mockActions.newConversation).toHaveBeenCalledTimes(1);
    resolveNew('single-new-conv');
    await waitFor(() => expect(onConversationIdChange).toHaveBeenCalledWith('single-new-conv'));
  });

  it('resets stale hover and focus state while another chat pane owns the global surface', async () => {
    const anchor = document.createElement('div');
    anchor.getBoundingClientRect = () => rect(100);
    const { rerender, props } = renderSurface({ anchor });
    fireEvent.mouseEnter(await screen.findByTestId('ai-history-launcher'));
    expect(screen.getByTestId('ai-history-panel')).toBeInTheDocument();

    rerender(<ChatHistorySurface {...props} anchor={anchor} isOpen={false} />);
    expect(screen.queryByTestId('ai-history-launcher')).not.toBeInTheDocument();
    rerender(<ChatHistorySurface {...props} anchor={anchor} isOpen />);
    await screen.findByTestId('ai-history-launcher');
    expect(screen.queryByTestId('ai-history-panel')).not.toBeInTheDocument();
  });

  it('gives Escape-to-pause precedence while a turn or queued follow-up exists', async () => {
    const onPause = vi.fn();
    renderSurface({ isBusy: true, queuedMessageCount: 1, onPause });
    const toggle = await screen.findByTestId('ai-history-button');
    fireEvent.focus(toggle);
    await screen.findByTestId('ai-history-panel');
    fireEvent.keyDown(screen.getByTestId('ai-history-launcher'), { key: 'Escape' });
    expect(onPause).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('ai-history-panel')).toBeInTheDocument();
  });

  it('lets the last rapid history choice win even when an earlier load resolves later', async () => {
    let resolveFirst!: () => void;
    let resolveSecond!: () => void;
    mockActions.switchConversation
      .mockImplementationOnce(
        () => new Promise<'applied'>((resolve) => (resolveFirst = () => resolve('applied')))
      )
      .mockImplementationOnce(
        () => new Promise<'applied'>((resolve) => (resolveSecond = () => resolve('applied')))
      );
    const onConversationIdChange = vi.fn();
    renderSurface({ onConversationIdChange });
    fireEvent.mouseEnter(await screen.findByTestId('ai-history-launcher'));
    fireEvent.click(screen.getByRole('button', { name: 'Open conversation: First conversation' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open conversation: Second conversation' }));

    resolveSecond();
    await waitFor(() => expect(onConversationIdChange).toHaveBeenCalledWith('conv-2'));
    resolveFirst();
    await Promise.resolve();
    expect(onConversationIdChange).toHaveBeenCalledTimes(1);
  });

  it('does not retarget the tab when the shared store rejects a stale switch', async () => {
    mockActions.switchConversation.mockResolvedValueOnce('stale');
    const onConversationIdChange = vi.fn();
    renderSurface({ onConversationIdChange });
    fireEvent.mouseEnter(await screen.findByTestId('ai-history-launcher'));
    fireEvent.click(screen.getByRole('button', { name: 'Open conversation: Second conversation' }));

    await waitFor(() => expect(mockActions.switchConversation).toHaveBeenCalledTimes(1));
    expect(onConversationIdChange).not.toHaveBeenCalled();
  });

  it("finishes the clicked tab's navigation without stealing focus when another pane takes ownership", async () => {
    let resolveSwitch!: () => void;
    mockActions.switchConversation.mockImplementationOnce(
      () => new Promise<'available'>((resolve) => (resolveSwitch = () => resolve('available')))
    );
    const onConversationIdChange = vi.fn();
    const { rerender, props } = renderSurface({ onConversationIdChange });
    fireEvent.mouseEnter(await screen.findByTestId('ai-history-launcher'));
    fireEvent.click(screen.getByRole('button', { name: 'Open conversation: Second conversation' }));
    expect(mockActions.switchConversation).toHaveBeenCalledTimes(1);

    const otherPaneInput = document.createElement('textarea');
    document.body.append(otherPaneInput);
    rerender(<ChatHistorySurface {...props} isOpen={false} />);
    otherPaneInput.focus();
    resolveSwitch();

    await waitFor(() => expect(onConversationIdChange).toHaveBeenCalledWith('conv-2'));
    expect(otherPaneInput).toHaveFocus();
    otherPaneInput.remove();
  });

  it('retargets after deleting the active row and creates a blank chat when none remain', async () => {
    const onConversationIdChange = vi.fn();
    renderSurface({ onConversationIdChange });
    fireEvent.mouseEnter(await screen.findByTestId('ai-history-launcher'));
    const activeRow = screen.getAllByTestId('conversation-item')[0];
    fireEvent.mouseEnter(activeRow);
    fireEvent.click(within(activeRow).getByTitle('Delete conversation'));

    await waitFor(() => expect(mockActions.deleteConversation).toHaveBeenCalledWith('conv-1'));
    expect(mockActions.newConversation).toHaveBeenCalledWith('/workspace', {
      force: true,
      sourceConversationId: null,
    });
    expect(onConversationIdChange).toHaveBeenCalledWith('new-conv');
  });

  it('retargets a deleted active tab without stealing focus after ownership moves', async () => {
    let resolveDelete!: (nextId: string | null) => void;
    mockActions.deleteConversation.mockImplementationOnce(
      () => new Promise<string | null>((resolve) => (resolveDelete = resolve))
    );
    const onConversationIdChange = vi.fn();
    const { rerender, props } = renderSurface({ onConversationIdChange });
    fireEvent.mouseEnter(await screen.findByTestId('ai-history-launcher'));
    const activeRow = screen.getAllByTestId('conversation-item')[0];
    fireEvent.mouseEnter(activeRow);
    fireEvent.click(within(activeRow).getByTitle('Delete conversation'));
    expect(within(activeRow).getByRole('button', { name: /open conversation/i })).toBeDisabled();

    const otherPaneInput = document.createElement('textarea');
    document.body.append(otherPaneInput);
    rerender(<ChatHistorySurface {...props} isOpen={false} />);
    otherPaneInput.focus();
    resolveDelete('conv-2');

    await waitFor(() => expect(onConversationIdChange).toHaveBeenCalledWith('conv-2'));
    expect(otherPaneInput).toHaveFocus();
    otherPaneInput.remove();
  });

  it('reports a failed new-chat request instead of leaving an unhandled rejection', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockActions.newConversation.mockRejectedValueOnce(new Error('database unavailable'));
    renderSurface();
    fireEvent.mouseEnter(await screen.findByTestId('ai-history-launcher'));
    fireEvent.click(screen.getByRole('button', { name: 'New conversation' }));

    await waitFor(() =>
      expectToastCall(mockActions.addToast, "Couldn't start a new chat — try again.", 'error')
    );
  });

  it('reports a failed conversation switch without retargeting the tab', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockActions.switchConversation.mockRejectedValueOnce(new Error('database unavailable'));
    const onConversationIdChange = vi.fn();
    renderSurface({ onConversationIdChange });
    fireEvent.mouseEnter(await screen.findByTestId('ai-history-launcher'));
    fireEvent.click(screen.getByRole('button', { name: 'Open conversation: Second conversation' }));

    await waitFor(() =>
      expectToastCall(mockActions.addToast, "Couldn't open that chat — try again.", 'error')
    );
    expect(onConversationIdChange).not.toHaveBeenCalled();
  });

  it('retargets a deleted tab to an isolated placeholder when replacement creation fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000222');
    mockActions.newConversation.mockRejectedValueOnce(new Error('database unavailable'));
    const onConversationIdChange = vi.fn();
    renderSurface({ onConversationIdChange });
    fireEvent.mouseEnter(await screen.findByTestId('ai-history-launcher'));
    const activeRow = screen.getAllByTestId('conversation-item')[0];
    fireEvent.mouseEnter(activeRow);
    fireEvent.click(within(activeRow).getByTitle('Delete conversation'));

    await waitFor(() =>
      expect(onConversationIdChange).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000222')
    );
    expectToastCall(
      mockActions.addToast,
      "Chat deleted, but the replacement couldn't be saved — try again.",
      'error'
    );
  });

  it('reports a failed deletion without retargeting the still-existing chat', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockActions.deleteConversation.mockRejectedValueOnce(new Error('database unavailable'));
    const onConversationIdChange = vi.fn();
    renderSurface({ onConversationIdChange });
    fireEvent.mouseEnter(await screen.findByTestId('ai-history-launcher'));
    const activeRow = screen.getAllByTestId('conversation-item')[0];
    fireEvent.mouseEnter(activeRow);
    fireEvent.click(within(activeRow).getByTitle('Delete conversation'));

    await waitFor(() =>
      expectToastCall(mockActions.addToast, "Couldn't delete that chat — try again.", 'error')
    );
    expect(onConversationIdChange).not.toHaveBeenCalled();
  });
});

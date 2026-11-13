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

describe('FullChatView queue controls', () => {
  beforeEach(resetFullChatViewHarness);

  it('shows an idle submission in the thread while the turn is being prepared', () => {
    mockChatState.currentConversationId = 'visible-conv';
    mockChatState.queuedMessages = [
      {
        id: 'direct-1',
        content: 'Start this conversation',
        workspacePath: '/workspace',
        referenceIds: [],
        createdAt: 2,
        displayInThreadWhilePending: true,
      },
    ];

    const { rerender } = render(
      <FullChatView workspacePath="/workspace" conversationId="visible-conv" />
    );
    expect(screen.getByTestId('user-message')).toHaveTextContent('Start this conversation');
    expect(screen.queryByTestId('queued-chat-stack')).not.toBeInTheDocument();

    mockChatState.messages = [
      { id: 'direct-1', role: 'user', content: 'Start this conversation', createdAt: 2 },
    ];
    mockChatState.queuedMessages = [];
    rerender(<FullChatView workspacePath="/workspace" conversationId="visible-conv" />);
    expect(screen.getAllByTestId('user-message')).toHaveLength(1);
    expect(screen.queryByTestId('queued-chat-stack')).not.toBeInTheDocument();
  });

  it('keeps the composer enabled and accepts repeated Enter submissions while an agent works', async () => {
    mockChatState.currentConversationId = 'visible-conv';
    mockChatState.messages = [{ id: 'm1', role: 'user', content: 'First turn', createdAt: 1 }];
    mockChatState.isLoading = true;

    render(<FullChatView workspacePath="/workspace" conversationId="visible-conv" />);

    const input = screen.getByTestId('ai-input');
    expect(input).not.toBeDisabled();

    fireEvent.change(input, { target: { value: 'First queued message' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.change(input, { target: { value: 'Second queued message' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(mockChatState.sendMessage).toHaveBeenNthCalledWith(
        1,
        'First queued message',
        '/workspace',
        'visible-conv',
        [],
        {
          claimIfUnowned: true,
          activateConversation: true,
          attachments: [],
          onNotStarted: expect.any(Function),
        }
      );
      expect(mockChatState.sendMessage).toHaveBeenNthCalledWith(
        2,
        'Second queued message',
        '/workspace',
        'visible-conv',
        [],
        {
          claimIfUnowned: true,
          activateConversation: true,
          attachments: [],
          onNotStarted: expect.any(Function),
        }
      );
    });
    expect(mockChatState.stopGeneration).not.toHaveBeenCalled();
  });

  it('advances a queued row on empty Enter while empty Enter and idle Escape otherwise do nothing', () => {
    mockChatState.currentConversationId = 'visible-conv';
    mockChatState.messages = [{ id: 'm1', role: 'user', content: 'Active turn', createdAt: 1 }];
    mockChatState.isLoading = true;

    const { rerender } = render(
      <FullChatView workspacePath="/workspace" conversationId="visible-conv" />
    );
    const input = screen.getByTestId('ai-input');

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(mockChatState.stopGeneration).not.toHaveBeenCalled();
    expect(mockChatState.sendMessage).not.toHaveBeenCalled();

    mockChatState.queuedMessages = [
      {
        id: 'queued-1',
        content: 'Advance me',
        workspacePath: '/workspace',
        referenceIds: [],
        createdAt: 2,
      },
    ];
    rerender(<FullChatView workspacePath="/workspace" conversationId="visible-conv" />);

    fireEvent.keyDown(screen.getByTestId('ai-input'), { key: 'Enter' });
    expect(mockChatState.stopGeneration).toHaveBeenCalledWith('visible-conv');

    mockChatState.stopGeneration.mockClear();
    mockChatState.isLoading = false;
    mockChatState.queuedMessages = [];
    rerender(<FullChatView workspacePath="/workspace" conversationId="visible-conv" />);

    fireEvent.keyDown(screen.getByTestId('ai-input'), { key: 'Escape' });
    expect(mockChatState.stopGeneration).not.toHaveBeenCalled();
    expect(mockChatState.sendMessage).not.toHaveBeenCalled();
  });

  it('keeps the focused composer edge above the attached queue and wires its advance target', () => {
    mockChatState.currentConversationId = 'visible-conv';
    mockChatState.messages = [{ id: 'm1', role: 'user', content: 'Active turn', createdAt: 1 }];
    mockChatState.isLoading = true;
    mockChatState.queuedMessages = [
      {
        id: 'queued-1',
        content: 'First queued message',
        workspacePath: '/workspace',
        referenceIds: [],
        createdAt: 2,
      },
      {
        id: 'queued-2',
        content: 'Second queued message',
        workspacePath: '/workspace',
        referenceIds: [],
        createdAt: 3,
      },
    ];

    render(<FullChatView workspacePath="/workspace" conversationId="visible-conv" />);
    expect(screen.getByTestId('chat-composer')).toHaveClass('relative', 'z-10');
    fireEvent.click(screen.getAllByTestId('advance-queued-message')[1]);

    expect(mockChatState.advanceQueueThrough).toHaveBeenCalledWith('queued-2', 'visible-conv');
  });

  it('keeps Escape queue advancement available after the focused queued row is promoted', () => {
    mockChatState.currentConversationId = 'visible-conv';
    mockChatState.messages = [{ id: 'm1', role: 'user', content: 'Active turn', createdAt: 1 }];
    mockChatState.isLoading = true;
    mockChatState.queuedMessages = [
      {
        id: 'queued-1',
        content: 'Queued follow-up',
        workspacePath: '/workspace',
        referenceIds: [],
        createdAt: 2,
      },
    ];

    const { rerender } = render(
      <FullChatView workspacePath="/workspace" conversationId="visible-conv" />
    );
    const advanceButton = screen.getByTestId('advance-queued-message');
    advanceButton.focus();
    fireEvent.click(advanceButton);
    const input = screen.getByTestId('ai-input');
    expect(input).toHaveFocus();

    mockChatState.queuedMessages = [];
    rerender(<FullChatView workspacePath="/workspace" conversationId="visible-conv" />);
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(mockChatState.stopGeneration).toHaveBeenCalledWith('visible-conv');
  });

  it('animates a promoted queue bubble from its latest pinned-rail rectangle', () => {
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    const animate = vi.fn();
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      if (this.getAttribute('data-testid') === 'queued-chat-message') {
        const pinned = document
          .querySelector('[data-chat-drop-zone]')
          ?.hasAttribute('data-history-pinned');
        return {
          x: pinned ? 340 : 100,
          y: 500,
          left: pinned ? 340 : 100,
          top: 500,
          right: pinned ? 740 : 500,
          bottom: 540,
          width: 400,
          height: 40,
          toJSON: () => ({}),
        } as DOMRect;
      }
      if (this.getAttribute('data-testid') === 'user-message') {
        return {
          x: 400,
          y: 200,
          left: 400,
          top: 200,
          right: 800,
          bottom: 240,
          width: 400,
          height: 40,
          toJSON: () => ({}),
        } as DOMRect;
      }
      return originalGetBoundingClientRect.call(this);
    };
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      configurable: true,
      value: animate,
    });

    try {
      mockChatState.currentConversationId = 'visible-conv';
      mockChatState.messages = [
        { id: 'active', role: 'user', content: 'Active turn', createdAt: 1 },
      ];
      mockChatState.queuedMessages = [
        {
          id: 'promoted-id',
          content: 'Promote this message',
          workspacePath: '/workspace',
          referenceIds: [],
          createdAt: 2,
        },
      ];

      const { rerender } = render(
        <FullChatView workspacePath="/workspace" conversationId="visible-conv" />
      );
      expect(screen.getByTestId('queued-chat-message')).toHaveTextContent('Promote this message');
      fireEvent.mouseEnter(screen.getByTestId('ai-history-launcher'));
      fireEvent.click(screen.getByTestId('ai-history-button'));
      expect(document.querySelector('[data-chat-drop-zone]')).toHaveAttribute(
        'data-history-pinned',
        'true'
      );

      mockChatState.queuedMessages = [];
      mockChatState.messages = [
        { id: 'active', role: 'user', content: 'Active turn', createdAt: 1 },
        { id: 'promoted-id', role: 'user', content: 'Promote this message', createdAt: 2 },
      ];
      rerender(<FullChatView workspacePath="/workspace" conversationId="visible-conv" />);

      const promoted = screen.getAllByTestId('user-message')[1];
      expect(promoted).toHaveAttribute('data-promoted-from-queue', 'true');
      expect(promoted).toHaveClass('animate-chat-queue-promotion');
      expect(animate).toHaveBeenCalled();
      expect(animate.mock.calls[0]?.[0]?.[0]).toMatchObject({
        transform: 'translate(-60px, 300px) scale(1, 1)',
      });
    } finally {
      localStorage.removeItem('waypoint:ai-history-pinned');
      HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
      delete (HTMLElement.prototype as { animate?: unknown }).animate;
    }
  });

  it('pauses the active turn on Escape without discarding the unsent draft', () => {
    mockChatState.currentConversationId = 'visible-conv';
    mockChatState.messages = [{ id: 'm1', role: 'user', content: 'Active turn', createdAt: 1 }];
    mockChatState.isLoading = true;
    mockChatState.queuedMessages = [
      {
        id: 'queued-1',
        content: 'Run after pause',
        workspacePath: '/workspace',
        referenceIds: [],
        createdAt: 2,
      },
    ];

    render(<FullChatView workspacePath="/workspace" conversationId="visible-conv" />);

    const input = screen.getByTestId('ai-input');
    fireEvent.change(input, { target: { value: 'Keep this draft' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(mockChatState.stopGeneration).toHaveBeenCalledWith('visible-conv');
    expect(input).toHaveValue('Keep this draft');
  });
});

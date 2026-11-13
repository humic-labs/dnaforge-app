import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, resetUseChatConversationHarness, useChatStore } from '../../test/ai/useChat-harness';
import { ChatHistorySurface } from './ChatHistorySurface';

vi.mock('./MessageFormatting', () => ({ formatTimeAgo: () => 'now' }));

function ConnectedSurface({ anchor, input }: { anchor: HTMLElement; input: HTMLTextAreaElement }) {
  const conversations = useChatStore((state) => state.conversations);
  return (
    <ChatHistorySurface
      anchor={anchor}
      inputRef={{ current: input }}
      workspacePath={null}
      viewConversationId="h2-two-surface-b"
      conversations={conversations}
      pinned
      setPinned={() => undefined}
      isOpen
      isBusy={false}
      queuedMessageCount={0}
      onPause={() => undefined}
    />
  );
}

describe('two history surfaces share the actual action owner  H2)', () => {
  beforeEach(resetUseChatConversationHarness);
  afterEach(cleanup);

  it('orders two accepted pin gestures across actual mounted surfaces rather than relying on one component guard', async () => {
    useChatStore.setState({
      conversations: [
        {
          id: 'h2-two-surface-a',
          title: 'Two-surface A',
          workspacePath: '/a',
          pinned: false,
          provider: null,
          model: null,
          createdAt: 1,
          updatedAt: 2,
        },
        {
          id: 'h2-two-surface-b',
          title: 'Two-surface B',
          workspacePath: '/b',
          pinned: false,
          provider: null,
          model: null,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let nativePinned = false;
    let calls = 0;
    vi.mocked(db.toggleConversationPinned).mockImplementation(async () => {
      const readPinned = nativePinned;
      if (++calls === 1) await gate;
      nativePinned = !readPinned;
      return nativePinned;
    });
    const anchor = document.createElement('div');
    const input = document.createElement('textarea');
    document.body.append(anchor, input);
    render(
      <>
        <ConnectedSurface anchor={anchor} input={input} />
        <ConnectedSurface anchor={anchor} input={input} />
      </>
    );
    try {
      const surfaces = await screen.findAllByTestId('ai-history-panel');
      expect(surfaces).toHaveLength(2);
      const a = surfaces.map(
        (surface) =>
          within(surface)
            .getByText('Two-surface A')
            .closest('[data-testid="conversation-item"]') as HTMLElement
      );
      const pins = a.map((item) => within(item).getByTitle('Pin conversation'));
      fireEvent.click(pins[0]);
      expect(pins[0]).toBeDisabled();
      expect(pins[1]).toBeEnabled();
      fireEvent.click(pins[1]);
      expect(pins[1]).toBeDisabled();
      expect(db.toggleConversationPinned).toHaveBeenCalledOnce();
      for (const surface of surfaces) {
        expect(
          within(surface).getByRole('button', { name: 'Open conversation: Two-surface B' })
        ).toBeEnabled();
      }
      await act(async () => {
        release();
        await gate;
      });
      await waitFor(() => {
        expect(db.toggleConversationPinned).toHaveBeenCalledTimes(2);
        expect(pins[0]).toBeEnabled();
        expect(pins[1]).toBeEnabled();
      });
      expect(nativePinned).toBe(false);
      expect(
        useChatStore.getState().conversations.find((c) => c.id === 'h2-two-surface-a')?.pinned
      ).toBe(false);
      for (const item of a) expect(within(item).getByTitle('Pin conversation')).toBeInTheDocument();
    } finally {
      await act(async () => {
        release();
        await gate;
      });
      anchor.remove();
      input.remove();
    }
  });
});

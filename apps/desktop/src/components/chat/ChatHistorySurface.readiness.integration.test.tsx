import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createEmptyConversationState,
  db,
  resetUseChatConversationHarness,
  useChatStore,
} from '../../test/ai/useChat-harness';
import { ChatHistorySurface } from './ChatHistorySurface';

vi.mock('./MessageFormatting', () => ({ formatTimeAgo: () => 'now' }));

function ConnectedHistory({ anchor, input }: { anchor: HTMLElement; input: HTMLTextAreaElement }) {
  const rows = useChatStore((state) => state.conversations);
  const current = useChatStore((state) => state.currentConversationId);
  return (
    <ChatHistorySurface
      anchor={anchor}
      inputRef={{ current: input }}
      workspacePath={null}
      viewConversationId={current}
      conversations={rows}
      pinned
      setPinned={() => undefined}
      isOpen
      isBusy={false}
      queuedMessageCount={0}
      onPause={() => undefined}
    />
  );
}

function storedRow(id: string, title: string, pinned = 0, updatedAt = 1) {
  return {
    id,
    title,
    pinned,
    workspace_path: `/${id}`,
    provider: null,
    model: null,
    created_at: 1,
    updated_at: updatedAt,
  };
}

function renderHistory() {
  const anchor = document.createElement('div');
  const input = document.createElement('textarea');
  document.body.append(anchor, input);
  const view = render(<ConnectedHistory anchor={anchor} input={input} />);
  return {
    view,
    remove: () => {
      view.unmount();
      anchor.remove();
      input.remove();
    },
  };
}

describe('history readiness uses the actual shared read owner  H3)', () => {
  beforeEach(() => {
    resetUseChatConversationHarness();
    vi.mocked(db.getConversationHistory).mockReset().mockResolvedValue([]);
    vi.mocked(db.updateConversation).mockReset().mockResolvedValue(undefined);
    vi.mocked(db.toggleConversationPinned).mockReset().mockResolvedValue(true);
  });
  afterEach(cleanup);

  it('renders an actual first-read rejection and recovers from visible Retry without claiming empty or changing the pane/draft', async () => {
    vi.mocked(db.getConversationHistory)
      .mockRejectedValueOnce(new Error('private history read detail'))
      .mockResolvedValueOnce([storedRow('a', 'Persisted A'), storedRow('b', 'Persisted B')]);
    const draft = { text: 'Keep this unsent draft', attachments: [], references: [] };
    useChatStore.setState({
      currentConversationId: 'b',
      composerDrafts: new Map([['b', draft]]),
      _convStates: new Map([['b', createEmptyConversationState()]]),
    });
    const mounted = renderHistory();
    try {
      fireEvent.click(await screen.findByRole('button', { name: 'Load history' }));
      await waitFor(() =>
        expect(screen.getByTestId('ai-history-read-state')).toHaveTextContent('could not be loaded')
      );
      expect(screen.queryByTestId('ai-history-empty')).not.toBeInTheDocument();
      expect(document.body).not.toHaveTextContent('private history read detail');
      expect(useChatStore.getState().conversationHistoryRead).toEqual({
        status: 'error',
        hasLoaded: false,
      });
      fireEvent.click(screen.getByRole('button', { name: 'Retry history' }));
      await screen.findByText('Persisted A');
      await screen.findByText('Persisted B');
      expect(useChatStore.getState().conversationHistoryRead).toEqual({
        status: 'ready',
        hasLoaded: true,
      });
      expect(useChatStore.getState().currentConversationId).toBe('b');
      expect(useChatStore.getState().composerDrafts.get('b')).toBe(draft);
      expect(useChatStore.getState().conversations.map((c) => c.workspacePath)).toEqual([
        '/a',
        '/b',
      ]);
      expect(db.getConversationHistory).toHaveBeenCalledTimes(2);
    } finally {
      mounted.remove();
    }
  });

  it('keeps cached rows and real action mutations through refresh rejection, then Retry cannot seize a newer selection', async () => {
    const saved = [storedRow('a', 'Confirmed A', 0, 1), storedRow('b', 'Confirmed B', 0, 2)];
    vi.mocked(db.getConversationHistory).mockResolvedValueOnce(saved);
    await useChatStore.getState().loadConversations();
    useChatStore.setState({
      currentConversationId: 'a',
      _convStates: new Map([
        ['a', createEmptyConversationState()],
        ['b', createEmptyConversationState()],
      ]),
      composerDrafts: new Map([['a', { text: 'Retained A', attachments: [], references: [] }]]),
    });
    let reject!: (reason: unknown) => void;
    const refused = new Promise<Awaited<ReturnType<typeof db.getConversationHistory>>>(
      (_yes, no) => {
        reject = no;
      }
    );
    let releaseRetry!: (rows: Awaited<ReturnType<typeof db.getConversationHistory>>) => void;
    const retry = new Promise<Awaited<ReturnType<typeof db.getConversationHistory>>>((yes) => {
      releaseRetry = yes;
    });
    vi.mocked(db.getConversationHistory).mockReturnValueOnce(refused).mockReturnValueOnce(retry);
    const mounted = renderHistory();
    try {
      fireEvent.click(await screen.findByRole('button', { name: 'Refresh history' }));
      expect(screen.getByTestId('ai-history-read-state')).toHaveTextContent('Refreshing');
      await act(async () => {
        await useChatStore.getState().renameConversation('a', 'Acknowledged A');
        await useChatStore.getState().togglePin('a');
      });
      const acknowledged = useChatStore.getState().conversations;
      await act(async () => {
        reject(new Error('native refresh refusal'));
        await refused.catch(() => undefined);
      });
      expect(screen.getByTestId('ai-history-read-state')).toHaveTextContent(
        'saved list may be out of date'
      );
      expect(useChatStore.getState().conversations).toBe(acknowledged);
      expect(screen.getByText('Acknowledged A')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Retry history' }));
      fireEvent.click(screen.getByRole('button', { name: 'Open conversation: Confirmed B' }));
      await waitFor(() => expect(useChatStore.getState().currentConversationId).toBe('b'));
      const before = useChatStore.getState();
      await act(async () => {
        releaseRetry(saved);
        await retry;
      });
      expect(useChatStore.getState().conversationHistoryRead).toEqual({
        status: 'ready',
        hasLoaded: true,
      });
      expect(useChatStore.getState().currentConversationId).toBe('b');
      expect(useChatStore.getState().composerDrafts).toBe(before.composerDrafts);
      expect(useChatStore.getState().conversations.find((c) => c.id === 'a')).toMatchObject({
        title: 'Acknowledged A',
        pinned: true,
      });
      expect(screen.queryByTestId('ai-history-read-state')).not.toBeInTheDocument();
    } finally {
      await act(async () => {
        reject(new Error('test cleanup'));
        releaseRetry(saved);
        await Promise.allSettled([refused, retry]);
      });
      mounted.remove();
    }
  });
});

// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const { track } = vi.hoisted(() => ({
  track: vi.fn((_event: string, _properties?: Record<string, unknown>) => true),
}));
vi.mock('../../lib/telemetry-correlation', () => ({
  getTelemetryCorrelationContext: () => ({
    appSessionId: '10000000-0000-4000-8000-000000000001',
    episodeCorrelationId: '10000000-0000-4000-8000-000000000002',
  }),
}));
vi.mock('../../lib/analytics', () => ({
  trackRendererEvent: track,
  isAnalyticsCaptureReady: () => true,
  getAnalyticsIdentifiedAccountId: () => 'private-original-account',
  subscribeAnalyticsCaptureReady: () => () => undefined,
}));
vi.mock('./MessageFormatting', () => ({ formatTimeAgo: () => 'now' }));
import {
  db,
  resetUseChatConversationHarness,
  useChatStore,
  createEmptyConversationState,
} from '../../test/ai/useChat-harness';
import { ChatHistorySurface } from './ChatHistorySurface';
import { useHistoryPaneObservation } from './useHistoryPaneObservation';
const a = {
  id: 'PRIVATE-ID-A',
  title: 'PRIVATE-TITLE-Alpha',
  workspacePath: '/PRIVATE-ROOT-A',
  pinned: false,
  provider: null,
  model: null,
  createdAt: 1,
  updatedAt: 2,
};
const b = {
  ...a,
  id: 'PRIVATE-ID-B',
  title: 'PRIVATE-TITLE-Beta',
  workspacePath: '/PRIVATE-ROOT-B',
  updatedAt: 1,
};
function Connected({
  anchor,
  input,
  open = true,
  generation,
}: {
  anchor: HTMLElement;
  input: HTMLTextAreaElement;
  open?: boolean;
  generation?: string;
}) {
  const state = useChatStore();
  const observed = useHistoryPaneObservation({
    conversationId: state.currentConversationId,
    known: state.conversations.some((row) => row.id === state.currentConversationId),
    hasState:
      state.currentConversationId !== null && state._convStates.has(state.currentConversationId),
    isOpen: open,
    scoped: false,
    switchConversation: state.switchConversation,
    hydrateConversation: state.hydrateConversation,
  });
  return (
    <ChatHistorySurface
      anchor={anchor}
      inputRef={{ current: input }}
      workspacePath={a.workspacePath}
      viewConversationId={state.currentConversationId}
      conversations={state.conversations}
      pinned
      setPinned={() => undefined}
      isOpen={open}
      isBusy={false}
      queuedMessageCount={0}
      historyPaneGenerationId={generation ?? observed.paneGenerationId}
      onConversationIdChange={observed.retarget}
      onPause={() => undefined}
    />
  );
}
const events = (action: string, stage = 'store') =>
  track.mock.calls
    .filter(([, props]) => props?.history_action === action && props.history_stage === stage)
    .map(([, props]) => props!);
describe('H1 semantic history surface with actual H2/H3 store', () => {
  let anchor: HTMLDivElement;
  let input: HTMLTextAreaElement;
  beforeEach(() => {
    resetUseChatConversationHarness();
    track.mockReset().mockReturnValue(true);
    anchor = document.createElement('div');
    input = document.createElement('textarea');
    document.body.append(anchor, input);
    useChatStore.setState({
      conversations: [a, b],
      conversationHistoryRead: { status: 'ready', hasLoaded: true },
      currentConversationId: a.id,
      composerDrafts: new Map(),
      _convStates: new Map([[a.id, createEmptyConversationState()]]),
    });
  });
  afterEach(() => {
    cleanup();
    anchor.remove();
    input.remove();
    vi.restoreAllMocks();
  });
  it('keeps live local title filtering event-free until blur; the settled snapshot has no query, length or keys', async () => {
    render(<Connected anchor={anchor} input={input} />);
    const search = await screen.findByRole('searchbox', { name: 'Search chats' });
    fireEvent.change(search, { target: { value: 'PRIVATE-TITLE-A' } });
    fireEvent.change(search, { target: { value: 'PRIVATE-TITLE-Alpha' } });
    expect(screen.getAllByTestId('conversation-item')).toHaveLength(1);
    expect(events('title_filter')).toEqual([]);
    fireEvent.blur(search);
    await waitFor(() => expect(events('title_filter')).toHaveLength(1));
    expect(events('title_filter')[0]).toMatchObject({
      history_result: 'filter_matches',
      history_match_bucket: 'one',
      history_authority: 'loaded_titles',
      history_freshness: 'current',
    });
    fireEvent.blur(search);
    expect(events('title_filter')).toHaveLength(1);
    fireEvent.change(search, { target: { value: 'PRIVATE-no-match' } });
    expect(screen.getByTestId('ai-history-no-match')).toBeVisible();
    fireEvent.blur(search);
    await waitFor(() =>
      expect(events('title_filter').at(-1)?.history_result).toBe('filter_no_match')
    );
    fireEvent.change(search, { target: { value: '' } });
    fireEvent.blur(search);
    await waitFor(() =>
      expect(events('title_filter').at(-1)?.history_result).toBe('filter_cleared')
    );
    expect(JSON.stringify(track.mock.calls)).not.toMatch(
      /PRIVATE|query_length|key_code|workspace_path|conversation_id/
    );
  });
  it('settles cached/unavailable filtering honestly and cancels a dirty close once', async () => {
    useChatStore.setState({ conversationHistoryRead: { status: 'error', hasLoaded: true } });
    const view = render(<Connected anchor={anchor} input={input} />);
    const search = await screen.findByRole('searchbox');
    fireEvent.change(search, { target: { value: 'none' } });
    expect(screen.getByTestId('ai-history-no-match')).toHaveTextContent('saved list');
    fireEvent.blur(search);
    await waitFor(() => expect(events('title_filter')[0]?.history_freshness).toBe('cached'));
    act(() =>
      useChatStore.setState({ conversationHistoryRead: { status: 'error', hasLoaded: false } })
    );
    fireEvent.change(search, { target: { value: 'Alpha' } });
    fireEvent.blur(search);
    await waitFor(() =>
      expect(events('title_filter').at(-1)).toMatchObject({
        history_phase: 'refused',
        history_result: 'filter_unavailable',
      })
    );
    fireEvent.change(search, { target: { value: 'dirty' } });
    view.rerender(<Connected anchor={anchor} input={input} open={false} />);
    expect(events('title_filter').at(-1)).toMatchObject({
      history_phase: 'cancelled',
      history_result: 'surface_closed',
    });
    const length = events('title_filter').length;
    view.unmount();
    expect(events('title_filter')).toHaveLength(length);
  });
  it('cancels a dirty edit owned by a retired pane generation once without a keystroke stream', async () => {
    const first = '33760000-0000-4000-8000-000000000061';
    const next = '33760000-0000-4000-8000-000000000062';
    const view = render(<Connected anchor={anchor} input={input} generation={first} />);
    const search = await screen.findByRole('searchbox');
    fireEvent.change(search, { target: { value: 'PRIVATE-OLD-EDIT' } });
    expect(events('title_filter')).toEqual([]);
    view.rerender(<Connected anchor={anchor} input={input} generation={next} />);
    expect(events('title_filter')).toHaveLength(1);
    expect(events('title_filter')[0]).toMatchObject({
      history_phase: 'cancelled',
      history_result: 'superseded',
      history_pane_generation_id: first,
    });
    fireEvent.blur(search);
    expect(events('title_filter')).toHaveLength(1);
    expect(search).toHaveValue('PRIVATE-OLD-EDIT');
  });
  it('joins UI selection to actual keyed/pane commitment and preserves unrelated drafts and root affinity', async () => {
    const draft = { text: 'PRIVATE-DRAFT-A', attachments: [], references: [] };
    useChatStore.setState({ composerDrafts: new Map([[a.id, draft]]) });
    render(<Connected anchor={anchor} input={input} />);
    fireEvent.click(await screen.findByRole('button', { name: `Open conversation: ${b.title}` }));
    await waitFor(() => expect(events('resume', 'pane')).toHaveLength(1));
    expect(events('resume', 'pane')[0]).toMatchObject({
      operation_id: events('resume')[0]?.operation_id,
      history_result: 'pane_presented',
      history_authority: 'pane_commit',
    });
    expect(useChatStore.getState().composerDrafts.get(a.id)).toBe(draft);
    expect(
      useChatStore.getState().conversations.find((row) => row.id === b.id)?.workspacePath
    ).toBe('/PRIVATE-ROOT-B');
    expect(JSON.stringify(track.mock.calls)).not.toContain('PRIVATE');
  });
  it('retains failed rename/pin drafts and admits a distinct retry with real store refusal', async () => {
    const failure = new Error('PRIVATE-SQL');
    vi.mocked(db.updateConversationWithResult).mockRejectedValueOnce(failure);
    vi.mocked(db.toggleConversationPinnedWithResult).mockRejectedValueOnce(failure);
    render(<Connected anchor={anchor} input={input} />);
    const item = (await screen.findByText(a.title)).closest(
      '[data-testid="conversation-item"]'
    ) as HTMLElement;
    fireEvent.click(within(item).getByTestId('ai-rename-button'));
    const edit = within(item).getByRole('textbox', { name: 'Conversation name' });
    fireEvent.change(edit, { target: { value: 'PRIVATE-RENAMED' } });
    fireEvent.keyDown(edit, { key: 'Enter' });
    await waitFor(() => expect(edit).toHaveAttribute('aria-invalid', 'true'));
    expect(edit).toHaveValue('PRIVATE-RENAMED');
    fireEvent.keyDown(edit, { key: 'Enter' });
    expect(events('rename')).toHaveLength(1);
    fireEvent.click(within(item).getByRole('button', { name: 'Retry rename' }));
    await waitFor(() =>
      expect(useChatStore.getState().conversations.find((row) => row.id === a.id)?.title).toBe(
        'PRIVATE-RENAMED'
      )
    );
    expect(events('rename').map((row) => row.history_result)).toEqual([
      'native_write_rejected',
      'row_updated',
    ]);
    expect(new Set(events('rename').map((row) => row.operation_id)).size).toBe(2);
    fireEvent.click(within(item).getByTitle('Pin conversation'));
    await waitFor(() =>
      expect(within(item).getByRole('button', { name: 'Retry pin' })).toBeEnabled()
    );
    fireEvent.click(within(item).getByRole('button', { name: 'Retry pin' }));
    await waitFor(() => expect(events('row_pin').at(-1)?.history_result).toBe('row_updated'));
    expect(JSON.stringify(track.mock.calls)).not.toContain('PRIVATE');
  });
  it('preserves Enter/blur single-flight and settles explicit rename cancel without a write', async () => {
    render(<Connected anchor={anchor} input={input} />);
    const item = (await screen.findByText(a.title)).closest(
      '[data-testid="conversation-item"]'
    ) as HTMLElement;
    fireEvent.click(within(item).getByTestId('ai-rename-button'));
    const edit = within(item).getByRole('textbox', { name: 'Conversation name' });
    fireEvent.change(edit, { target: { value: 'PRIVATE-CANCEL' } });
    fireEvent.keyDown(edit, { key: 'Escape' });
    expect(db.updateConversationWithResult).not.toHaveBeenCalled();
    expect(events('rename').at(-1)).toMatchObject({
      history_phase: 'cancelled',
      history_result: 'edit_cancelled',
    });
    fireEvent.click(within(item).getByTestId('ai-rename-button'));
    const next = within(item).getByRole('textbox', { name: 'Conversation name' });
    fireEvent.change(next, { target: { value: 'PRIVATE-COMMIT' } });
    fireEvent.keyDown(next, { key: 'Enter' });
    fireEvent.blur(next);
    await waitFor(() => expect(db.updateConversationWithResult).toHaveBeenCalledOnce());
    expect(events('rename').filter((row) => row.history_result === 'row_updated')).toHaveLength(1);
  });
});

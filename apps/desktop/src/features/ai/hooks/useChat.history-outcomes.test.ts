// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const { track } = vi.hoisted(() => ({
  track: vi.fn((_event: string, _properties?: Record<string, unknown>) => true),
}));
vi.mock('../../../lib/telemetry-correlation', () => ({
  getTelemetryCorrelationContext: () => ({
    appSessionId: '10000000-0000-4000-8000-000000000001',
    episodeCorrelationId: '10000000-0000-4000-8000-000000000002',
  }),
}));
vi.mock('../../../lib/analytics', () => ({
  trackRendererEvent: track,
  isAnalyticsCaptureReady: () => true,
  getAnalyticsIdentifiedAccountId: () => 'private-original-account',
  subscribeAnalyticsCaptureReady: () => () => undefined,
}));
import {
  createEmptyConversationState,
  db,
  resetUseChatConversationHarness,
  useChatStore,
  markChatConversationDeleted,
} from '../../../test/ai/useChat-harness';
import { beginHistoryObservation } from '../../../lib/chat-history-telemetry';
const summary = (id: string, path = '/controlled-a') => ({
  id,
  title: `PRIVATE-TITLE-${id}`,
  workspacePath: path,
  pinned: false,
  provider: null,
  model: null,
  createdAt: 1,
  updatedAt: 1,
});
const row = (id: string) => ({
  id,
  title: `PRIVATE-TITLE-${id}`,
  workspace_path: '/controlled-b',
  pinned: 0,
  provider: null,
  model: null,
  created_at: 1,
  updated_at: 1,
});
function events(action: string, stage = 'store') {
  return track.mock.calls
    .filter(
      ([name, props]) =>
        name === 'chat_history_observed' &&
        props?.history_action === action &&
        props?.history_stage === stage
    )
    .map(([, props]) => props!);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function seed(id = 'a') {
  const slice = createEmptyConversationState();
  useChatStore.setState({
    conversations: [summary(id)],
    currentConversationId: id,
    composerDrafts: new Map(),
    _convStates: new Map([[id, slice]]),
  });
  return slice;
}
describe('H1 actual history store outcomes on H2/H3 ownership', () => {
  beforeEach(() => {
    resetUseChatConversationHarness();
    useChatStore.setState({ composerDrafts: new Map() });
    vi.mocked(db.deleteConversation).mockReset().mockResolvedValue(undefined);
    track.mockReset().mockReturnValue(true);
  });
  afterEach(() => vi.restoreAllMocks());
  it('separates confirmed empty from a rejected first read and preserves the original exception', async () => {
    await useChatStore.getState().loadConversations();
    expect(events('list').at(-1)).toMatchObject({
      history_result: 'loaded_empty',
      history_freshness: 'current',
      history_match_bucket: 'zero',
    });
    useChatStore.setState({ conversationHistoryRead: { status: 'idle', hasLoaded: false } });
    const failure = new Error('PRIVATE-SQL-ERROR');
    vi.mocked(db.getConversationHistory).mockRejectedValueOnce(failure);
    await expect(useChatStore.getState().loadConversations()).rejects.toBe(failure);
    expect(events('list').at(-1)).toMatchObject({
      history_phase: 'error',
      history_result: 'read_rejected',
      history_freshness: 'unavailable',
    });
  });
  it('retains a cached snapshot on rejection and cancels an obsolete successful read once', async () => {
    seed();
    useChatStore.setState({ conversationHistoryRead: { status: 'ready', hasLoaded: true } });
    vi.mocked(db.getConversationHistory).mockRejectedValueOnce(new Error('refused'));
    await expect(useChatStore.getState().loadConversations()).rejects.toThrow('refused');
    expect(events('list').at(-1)?.history_freshness).toBe('cached');
    expect(useChatStore.getState().conversations[0]?.id).toBe('a');
    const held = deferred<Awaited<ReturnType<typeof db.getConversationHistory>>>();
    vi.mocked(db.getConversationHistory)
      .mockImplementationOnce(() => held.promise)
      .mockResolvedValueOnce([row('b')]);
    const old = useChatStore.getState().loadConversations();
    await useChatStore.getState().loadConversations();
    held.resolve([row('old')]);
    await old;
    expect(events('list').at(-1)).toMatchObject({
      history_phase: 'cancelled',
      history_result: 'superseded',
    });
    expect(useChatStore.getState().conversations.some((c) => c.id === 'old')).toBe(false);
  });
  it('distinguishes live/cached/persisted availability without claiming pane presentation', async () => {
    const a = seed();
    a.isStreaming = true;
    await useChatStore.getState().switchConversation('a');
    expect(events('resume').at(-1)?.history_result).toBe('live_available');
    a.isStreaming = false;
    useChatStore.setState({ _convStates: new Map([['a', a]]) });
    await useChatStore.getState().switchConversation('a');
    expect(events('resume').at(-1)?.history_result).toBe('cached_available');
    await useChatStore.getState().switchConversation('b');
    expect(events('resume').at(-1)?.history_result).toBe('persisted_available');
    expect(events('resume', 'pane')).toEqual([]);
    expect(db.getMessages).toHaveBeenCalledWith('b');
  });
  it('hydrates missing keyed state even with a matching pointer; background hydration preserves pointer and drafts', async () => {
    seed();
    const drafts = new Map([['a', { text: 'PRIVATE-DRAFT-A', attachments: [], references: [] }]]);
    useChatStore.setState({ composerDrafts: drafts, _convStates: new Map() });
    await useChatStore.getState().hydrateConversation('a');
    expect(useChatStore.getState()._convStates.has('a')).toBe(true);
    await useChatStore.getState().hydrateConversation('b');
    expect(useChatStore.getState().currentConversationId).toBe('a');
    expect(useChatStore.getState().composerDrafts).toBe(drafts);
    expect(events('hydrate').map((e) => e.history_result)).toEqual([
      'persisted_available',
      'persisted_available',
    ]);
    await useChatStore.getState().hydrateConversation('b');
    expect(events('hydrate').at(-1)?.history_result).toBe('already_available');
  });
  it('does not install a persisted snapshot after deletion retires a pending hydration', async () => {
    seed();
    const drafts = new Map([['a', { text: 'PRIVATE-DRAFT-A', attachments: [], references: [] }]]);
    useChatStore.setState({ composerDrafts: drafts });
    const held = deferred<Awaited<ReturnType<typeof db.getMessages>>>();
    vi.mocked(db.getMessages).mockImplementationOnce(() => held.promise);
    const hydration = useChatStore.getState().hydrateConversation('b');
    await vi.waitFor(() => expect(db.getMessages).toHaveBeenCalledWith('b'));
    markChatConversationDeleted('b');
    held.resolve([]);
    await hydration;
    expect(useChatStore.getState()._convStates.has('b')).toBe(false);
    expect(useChatStore.getState().currentConversationId).toBe('a');
    expect(useChatStore.getState().composerDrafts).toBe(drafts);
    expect(events('hydrate').at(-1)).toMatchObject({
      history_phase: 'refused',
      history_result: 'tombstoned',
    });
    const reads = vi.mocked(db.getMessages).mock.calls.length;
    await useChatStore.getState().hydrateConversation('b');
    expect(db.getMessages).toHaveBeenCalledTimes(reads);
    expect(useChatStore.getState()._convStates.has('b')).toBe(false);
  });

  it('keeps superseded hydration keyed without seizing the newer pane and refuses a tombstone', async () => {
    seed();
    const held = deferred<Awaited<ReturnType<typeof db.getMessages>>>();
    vi.mocked(db.getMessages).mockImplementationOnce(() => held.promise);
    const old = useChatStore.getState().switchConversation('b');
    await Promise.resolve();
    await useChatStore.getState().switchConversation('c');
    held.resolve([]);
    await expect(old).resolves.toBe('available');
    expect(useChatStore.getState().currentConversationId).toBe('c');
    expect(useChatStore.getState()._convStates.has('b')).toBe(true);
    expect(events('resume').at(-1)?.history_freshness).toBe('superseded');
    markChatConversationDeleted('gone');
    await expect(useChatStore.getState().switchConversation('gone')).resolves.toBe('stale');
    expect(events('resume').at(-1)).toMatchObject({
      history_phase: 'refused',
      history_result: 'tombstoned',
    });
  });
  it('preserves a rejected hydration exception and does not report state or a pane', async () => {
    const failure = new Error('PRIVATE-hydration');
    vi.mocked(db.getMessages).mockRejectedValueOnce(failure);
    await expect(useChatStore.getState().hydrateConversation('missing')).rejects.toBe(failure);
    expect(events('hydrate').at(-1)).toMatchObject({
      history_phase: 'error',
      history_result: 'hydration_rejected',
    });
    expect(useChatStore.getState()._convStates.has('missing')).toBe(false);
  });
  it('separates New reuse, forced creation and create rejection without changing product-ID allocation', async () => {
    seed();
    await expect(useChatStore.getState().newConversation('/controlled-a')).resolves.toBe('a');
    expect(db.createConversation).not.toHaveBeenCalled();
    expect(events('new').at(-1)?.history_result).toBe('new_reused');
    const id = await useChatStore.getState().newConversation('/controlled-a', { force: true });
    expect(id).toBe('00000000-0000-0000-0000-000000000000');
    expect(events('new').at(-1)?.history_result).toBe('new_created');
    const failure = new Error('PRIVATE-create');
    vi.mocked(db.createConversation).mockRejectedValueOnce(failure);
    await expect(
      useChatStore.getState().newConversation('/controlled-b', { force: true })
    ).rejects.toBe(failure);
    expect(events('new').at(-1)?.history_result).toBe('create_rejected');
  });
  it('joins an admitted duplicate New without another database create or a false create receipt', async () => {
    seed();
    const held = deferred<Awaited<ReturnType<typeof db.createConversation>>>();
    vi.mocked(db.createConversation).mockImplementationOnce(() => held.promise);
    const first = useChatStore
      .getState()
      .newConversation('/controlled-b', { force: true, sourceConversationId: 'a' });
    const observed = beginHistoryObservation('new', 'history_surface');
    const joined = useChatStore.getState().newConversation('/controlled-b', {
      force: true,
      sourceConversationId: 'a',
      history: observed,
    });
    held.resolve(row('created'));
    await expect(first).resolves.toBe('created');
    await expect(joined).resolves.toBe('created');
    expect(db.createConversation).toHaveBeenCalledOnce();
    expect(events('new').filter((e) => e.history_result === 'joined_existing')).toHaveLength(1);
  });
  it('does not settle a joined New as returned before its shared operation, and preserves a shared rejection', async () => {
    seed();
    const held = deferred<Awaited<ReturnType<typeof db.createConversation>>>();
    vi.mocked(db.createConversation).mockImplementationOnce(() => held.promise);
    const first = useChatStore
      .getState()
      .newConversation('/controlled-b', { force: true, sourceConversationId: 'a' });
    const observed = beginHistoryObservation('new', 'history_surface');
    const joined = useChatStore.getState().newConversation('/controlled-b', {
      force: true,
      sourceConversationId: 'a',
      history: observed,
    });
    expect(events('new').filter((row) => row.operation_id === observed.id)).toEqual([]);
    const failure = new Error('PRIVATE-shared-create');
    const owned = Promise.allSettled([first, joined]);
    held.reject(failure);
    const results = await owned;
    expect(results).toEqual([
      { status: 'rejected', reason: failure },
      { status: 'rejected', reason: failure },
    ]);
    expect(events('new').filter((row) => row.operation_id === observed.id)).toHaveLength(1);
    expect(events('new').find((row) => row.operation_id === observed.id)).toMatchObject({
      history_phase: 'error',
      history_result: 'create_rejected',
      history_authority: 'not_attested',
    });
    expect(db.createConversation).toHaveBeenCalledOnce();
  });
  it.each(['rename', 'row_pin'] as const)(
    'does not project a non-applied %s update and admits a genuine retry',
    async (action) => {
      seed();
      const operation = () =>
        action === 'rename'
          ? useChatStore.getState().renameConversation('a', 'PRIVATE-new-title')
          : useChatStore.getState().togglePin('a');
      if (action === 'rename')
        vi.mocked(db.updateConversationWithResult).mockResolvedValueOnce({ status: 'not_applied' });
      else
        vi.mocked(db.toggleConversationPinnedWithResult).mockResolvedValueOnce({
          status: 'not_applied',
          pinned: true,
        });
      await operation();
      expect(events(action).at(-1)).toMatchObject({
        history_phase: 'refused',
        history_result: 'row_not_applied',
        history_authority: 'sqlite_changes',
      });
      expect(useChatStore.getState().conversations[0]).toMatchObject({
        title: 'PRIVATE-TITLE-a',
        pinned: false,
      });
      await operation();
      expect(events(action).at(-1)?.history_result).toBe('row_updated');
    }
  );
  it('keeps genuinely SELECT-absent pin rows distinct from zero-applied updates', async () => {
    seed();
    vi.mocked(db.toggleConversationPinnedWithResult).mockResolvedValueOnce({
      status: 'missing',
      pinned: false,
    });
    await useChatStore.getState().togglePin('a');
    expect(events('row_pin')).toHaveLength(1);
    expect(events('row_pin')[0]).toMatchObject({
      history_phase: 'refused',
      history_result: 'row_missing',
      history_authority: 'sqlite_return',
      history_freshness: 'unavailable',
    });
    expect(events('row_pin')[0]?.history_result).not.toBe('row_not_applied');
    expect(useChatStore.getState().conversations.find((row) => row.id === 'a')?.pinned).toBe(false);
  });
  it('preserves serialized pin acceptance across rejection and keeps no-op acknowledgement weaker than changes', async () => {
    seed();
    const failure = new Error('PRIVATE-pin');
    vi.mocked(db.toggleConversationPinnedWithResult)
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({ status: 'updated', pinned: true })
      .mockResolvedValueOnce({ status: 'not_attested', pinned: false });
    const rejected = useChatStore.getState().togglePin('a');
    const next = useChatStore.getState().togglePin('a');
    await expect(rejected).rejects.toBe(failure);
    await next;
    expect(events('row_pin').map((e) => e.history_result)).toEqual([
      'native_write_rejected',
      'row_updated',
    ]);
    await useChatStore.getState().togglePin('a');
    expect(events('row_pin').at(-1)).toMatchObject({
      history_result: 'native_write_returned',
      history_authority: 'sqlite_return',
      history_pin_state: 'unknown',
    });
  });
  it('settles rename projection failure once after native acknowledgement and preserves the actual Zustand listener exception', async () => {
    seed();
    const failure = new Error('PRIVATE-rename-projection');
    let armed = true;
    vi.mocked(db.updateConversationWithResult).mockResolvedValue({ status: 'updated' });
    const unsubscribe = useChatStore.subscribe((state, previous) => {
      const next = state.conversations.find((row) => row.id === 'a');
      const old = previous.conversations.find((row) => row.id === 'a');
      if (armed && next?.title === 'PRIVATE-ACKNOWLEDGED-TITLE' && old?.title !== next.title) {
        armed = false;
        throw failure;
      }
    });
    try {
      await expect(
        useChatStore.getState().renameConversation('a', 'PRIVATE-ACKNOWLEDGED-TITLE')
      ).rejects.toBe(failure);
      expect(db.updateConversationWithResult).toHaveBeenCalledExactlyOnceWith(
        'a',
        'PRIVATE-ACKNOWLEDGED-TITLE'
      );
      expect(useChatStore.getState().conversations.find((row) => row.id === 'a')?.title).toBe(
        'PRIVATE-ACKNOWLEDGED-TITLE'
      );
      expect(events('rename')).toHaveLength(1);
      expect(events('rename')[0]).toMatchObject({
        history_phase: 'error',
        history_result: 'write_returned_projection_failed',
        history_authority: 'sqlite_return',
      });
      expect(events('rename').some((row) => row.history_result === 'row_updated')).toBe(false);
      await useChatStore.getState().renameConversation('a', 'PRIVATE-RETRIED-TITLE');
      expect(events('rename')).toHaveLength(2);
      expect(events('rename')[1]).toMatchObject({
        history_phase: 'result',
        history_result: 'row_updated',
        history_authority: 'sqlite_changes',
      });
      expect(events('rename')[1]?.operation_id).not.toBe(events('rename')[0]?.operation_id);
    } finally {
      unsubscribe();
    }
  });
  it('settles pin projection failure once after native acknowledgement, preserving exception identity and queue release', async () => {
    seed();
    const failure = new Error('PRIVATE-pin-projection');
    let armed = true;
    vi.mocked(db.toggleConversationPinnedWithResult)
      .mockResolvedValueOnce({ status: 'updated', pinned: true })
      .mockResolvedValueOnce({ status: 'updated', pinned: false });
    const unsubscribe = useChatStore.subscribe((state, previous) => {
      const next = state.conversations.find((row) => row.id === 'a');
      const old = previous.conversations.find((row) => row.id === 'a');
      if (armed && next?.pinned === true && old?.pinned === false) {
        armed = false;
        throw failure;
      }
    });
    try {
      await expect(useChatStore.getState().togglePin('a')).rejects.toBe(failure);
      expect(db.toggleConversationPinnedWithResult).toHaveBeenCalledExactlyOnceWith('a');
      expect(useChatStore.getState().conversations.find((row) => row.id === 'a')?.pinned).toBe(
        true
      );
      expect(events('row_pin')).toHaveLength(1);
      expect(events('row_pin')[0]).toMatchObject({
        history_phase: 'error',
        history_result: 'write_returned_projection_failed',
        history_authority: 'sqlite_return',
      });
      expect(events('row_pin').some((row) => row.history_result === 'row_updated')).toBe(false);
      await useChatStore.getState().togglePin('a');
      expect(useChatStore.getState().conversations.find((row) => row.id === 'a')?.pinned).toBe(
        false
      );
      expect(events('row_pin')).toHaveLength(2);
      expect(events('row_pin')[1]).toMatchObject({
        history_phase: 'result',
        history_result: 'row_updated',
        history_authority: 'sqlite_changes',
        history_pin_state: 'unpinned',
      });
      expect(events('row_pin')[1]?.operation_id).not.toBe(events('row_pin')[0]?.operation_id);
    } finally {
      unsubscribe();
    }
  });
  it('does not revive a row after a late rename acknowledgement', async () => {
    seed();
    const held = deferred<Awaited<ReturnType<typeof db.updateConversationWithResult>>>();
    vi.mocked(db.updateConversationWithResult).mockImplementationOnce(() => held.promise);
    const rename = useChatStore.getState().renameConversation('a', 'PRIVATE-late');
    markChatConversationDeleted('a');
    held.resolve({ status: 'updated' });
    await rename;
    expect(events('rename').at(-1)?.history_freshness).toBe('superseded');
    expect(useChatStore.getState().conversations[0]?.title).toBe('PRIVATE-TITLE-a');
  });
  it('separates native delete rejection from returned deletion with replacement read failure', async () => {
    seed();
    const failure = new Error('PRIVATE-delete');
    vi.mocked(db.deleteConversation).mockRejectedValueOnce(failure);
    await expect(useChatStore.getState().deleteConversation('a')).rejects.toBe(failure);
    expect(events('delete').at(-1)?.history_result).toBe('delete_rejected');
    expect(useChatStore.getState().conversations).toHaveLength(1);
    useChatStore.setState({ conversations: [summary('a'), summary('b', '/controlled-b')] });
    vi.mocked(db.getMessages).mockRejectedValueOnce(new Error('PRIVATE-replacement'));
    await expect(useChatStore.getState().deleteConversation('a')).resolves.toBe('b');
    expect(events('delete').at(-1)).toMatchObject({
      history_result: 'delete_returned',
      history_authority: 'sqlite_return',
      history_replacement: 'read_failed_placeholder',
      history_availability: 'placeholder',
      history_shadow_cleanup: 'NOT_ATTESTED',
    });
    expect(useChatStore.getState().conversations.map((c) => c.id)).toEqual(['b']);
    expect(events('delete', 'pane')).toEqual([]);
  });
  it('optional sink or randomness failure does not change original store results or errors', async () => {
    seed();
    track.mockImplementation(() => {
      throw new Error('PRIVATE-sink');
    });
    await expect(useChatStore.getState().switchConversation('a')).resolves.toBe('applied');
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(() => {
      throw new Error('random refused');
    });
    const failure = new Error('PRIVATE-original');
    vi.mocked(db.updateConversationWithResult).mockRejectedValueOnce(failure);
    await expect(useChatStore.getState().renameConversation('a', 'PRIVATE-title')).rejects.toBe(
      failure
    );
    expect(JSON.stringify(track.mock.calls)).not.toMatch(
      /PRIVATE-(TITLE|DRAFT|SQL|create|hydration|delete|replacement|original|title)/
    );
  });
});

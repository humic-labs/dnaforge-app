// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const { track } = vi.hoisted(() => ({
  track: vi.fn((_event: string, _props?: Record<string, unknown>) => true),
}));
vi.mock('../lib/telemetry-correlation', () => ({
  getTelemetryCorrelationContext: () => ({
    appSessionId: '10000000-0000-4000-8000-000000000001',
    episodeCorrelationId: '10000000-0000-4000-8000-000000000002',
  }),
}));
vi.mock('../lib/analytics', () => ({
  trackRendererEvent: track,
  isAnalyticsCaptureReady: () => true,
  getAnalyticsIdentifiedAccountId: () => 'private-original-account',
  subscribeAnalyticsCaptureReady: () => () => undefined,
}));
import {
  FullChatView,
  getFullChatViewHarness,
  resetFullChatViewHarness,
} from './FullChatView.test-harness';
import { createEmptyConversationState } from '../features/ai/orchestration/chat-store-types';
const { mockChatState } = getFullChatViewHarness();
const rows = [
  {
    id: 'private-a',
    title: 'PRIVATE-TITLE-A',
    workspacePath: '/private-root-a',
    pinned: false,
    provider: null,
    model: null,
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: 'private-b',
    title: 'PRIVATE-TITLE-B',
    workspacePath: '/private-root-b',
    pinned: false,
    provider: null,
    model: null,
    createdAt: 1,
    updatedAt: 1,
  },
];
function panes() {
  return track.mock.calls
    .filter(([, props]) => props?.history_stage === 'pane')
    .map(([, props]) => props!);
}
function state(text: string) {
  return {
    ...createEmptyConversationState(),
    messages: [{ id: text, role: 'user' as const, content: text, createdAt: 1 }],
  };
}
describe('FullChatView H1 commitment at the existing H2/H3 owner', () => {
  beforeEach(() => {
    resetFullChatViewHarness();
    track.mockReset().mockReturnValue(true);
    Object.assign(mockChatState, { conversations: rows, currentConversationId: 'private-a' });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });
  it('does not mistake a matching pointer or a resolved hydrate for a visible hydrated transcript', async () => {
    let release!: () => void;
    const pending = new Promise<void>((yes) => {
      release = yes;
    });
    mockChatState.hydrateConversation.mockReturnValue(pending);
    const view = render(
      <FullChatView workspacePath="/private-root-a" conversationId="private-a" isOpen />
    );
    await waitFor(() =>
      expect(mockChatState.hydrateConversation).toHaveBeenCalledExactlyOnceWith('private-a')
    );
    expect(mockChatState.switchConversation).not.toHaveBeenCalled();
    expect(panes()).toEqual([]);
    await act(async () => {
      release();
      await pending;
    });
    expect(panes()).toEqual([]);
    mockChatState._convStates.set('private-a', state('PRIVATE-TRANSCRIPT-A'));
    view.rerender(
      <FullChatView workspacePath="/private-root-a" conversationId="private-a" isOpen />
    );
    await waitFor(() =>
      expect(panes().some((row) => row.history_result === 'pane_presented')).toBe(true)
    );
    expect(screen.getByTestId('chat-messages-scroll')).toHaveTextContent('PRIVATE-TRANSCRIPT-A');
    expect(panes().filter((row) => row.history_result === 'pane_presented')).toHaveLength(1);
  });
  it('keeps split/scoped transcripts, drafts and affinity distinct while a background completion settles', async () => {
    const a = state('PRIVATE-TRANSCRIPT-A');
    mockChatState._convStates.set('private-a', a);
    mockChatState.composerDrafts = new Map([
      ['private-a', { text: 'PRIVATE-DRAFT-A', attachments: [], references: [] }],
    ]);
    let release!: () => void;
    const pending = new Promise<void>((yes) => {
      release = yes;
    });
    mockChatState.hydrateConversation.mockReturnValue(pending);
    const view = render(
      <>
        <FullChatView workspacePath="/private-root-a" conversationId="private-a" isOpen />
        <FullChatView
          workspacePath="/private-root-b"
          conversationId="private-b"
          scoped
          isOpen={false}
        />
      </>
    );
    await waitFor(() =>
      expect(mockChatState.hydrateConversation).toHaveBeenCalledWith('private-b')
    );
    await act(async () => {
      release();
      await pending;
    });
    mockChatState._convStates.set('private-b', state('PRIVATE-TRANSCRIPT-B'));
    view.rerender(
      <>
        <FullChatView workspacePath="/private-root-a" conversationId="private-a" isOpen />
        <FullChatView
          workspacePath="/private-root-b"
          conversationId="private-b"
          scoped
          isOpen={false}
        />
      </>
    );
    await waitFor(() =>
      expect(panes().some((row) => row.history_result === 'background_available')).toBe(true)
    );
    expect(mockChatState.currentConversationId).toBe('private-a');
    expect(mockChatState._convStates.get('private-a')).toBe(a);
    expect(mockChatState.composerDrafts.get('private-a')?.text).toBe('PRIVATE-DRAFT-A');
    const transcripts = screen.getAllByTestId('chat-messages-scroll');
    expect(transcripts[0]).toHaveTextContent('PRIVATE-TRANSCRIPT-A');
    expect(transcripts[1]).toHaveTextContent('PRIVATE-TRANSCRIPT-B');
    expect(panes().filter((row) => row.history_result === 'pane_presented')).toEqual([]);
    expect(JSON.stringify(track.mock.calls)).not.toContain('PRIVATE');
    expect(JSON.stringify(track.mock.calls)).not.toContain('private-root');
  });
  it('continues a scoped transcript with its actual persisted workspace affinity and leaves the other pane draft intact', async () => {
    mockChatState._convStates.set('private-a', state('PRIVATE-TRANSCRIPT-A'));
    mockChatState._convStates.set('private-b', state('PRIVATE-TRANSCRIPT-B'));
    mockChatState.composerDrafts = new Map([
      ['private-a', { text: 'PRIVATE-RETAIN-A', attachments: [], references: [] }],
    ]);
    render(
      <>
        <FullChatView workspacePath="/private-root-a" conversationId="private-a" isOpen />
        <FullChatView
          workspacePath="/wrong-inherited-global-root"
          conversationId="private-b"
          scoped
          isOpen
        />
      </>
    );
    const views = screen.getAllByTestId('full-chat-view');
    await waitFor(() =>
      expect(within(views[0]!).getByTestId('ai-input')).toHaveValue('PRIVATE-RETAIN-A')
    );
    mockChatState.setComposerDraft.mockClear();
    fireEvent.change(within(views[1]!).getByTestId('ai-input'), {
      target: { value: 'PRIVATE-SCOPED-CONTINUATION' },
    });
    fireEvent.click(within(views[1]!).getByTestId('chat-send-button'));
    await waitFor(() =>
      expect(mockChatState.sendMessage).toHaveBeenCalledWith(
        'PRIVATE-SCOPED-CONTINUATION',
        '/private-root-b',
        'private-b',
        [],
        expect.objectContaining({ claimIfUnowned: false, activateConversation: false })
      )
    );
    expect(within(views[0]!).getByTestId('ai-input')).toHaveValue('PRIVATE-RETAIN-A');
    expect(mockChatState.setComposerDraft.mock.calls.some(([id]) => id === 'private-a')).toBe(
      false
    );
    expect(mockChatState.currentConversationId).toBe('private-a');
  });
  it('retires a background completion after its bound view changes', async () => {
    let release!: () => void;
    const pending = new Promise<void>((yes) => {
      release = yes;
    });
    mockChatState.hydrateConversation.mockReturnValue(pending);
    const view = render(
      <FullChatView
        workspacePath="/private-root-a"
        conversationId="private-a"
        scoped
        isOpen={false}
      />
    );
    await waitFor(() =>
      expect(mockChatState.hydrateConversation).toHaveBeenCalledWith('private-a')
    );
    const originalOperationId = track.mock.calls.find(
      ([, props]) =>
        props?.history_action === 'presentation' && props?.history_stage === 'operation'
    )?.[1]?.operation_id;
    expect(originalOperationId).toEqual(expect.any(String));
    mockChatState._convStates.set('private-b', state('PRIVATE-TRANSCRIPT-B'));
    view.rerender(
      <FullChatView
        workspacePath="/private-root-b"
        conversationId="private-b"
        scoped
        isOpen={false}
      />
    );
    await act(async () => {
      release();
      await pending;
    });
    const originalSettlements = panes().filter(
      (event) => event.operation_id === originalOperationId
    );
    expect(originalSettlements).toHaveLength(1);
    expect(originalSettlements[0]).toMatchObject({
      history_phase: 'cancelled',
      history_result: 'superseded',
    });
    const currentSettlement = panes().find(
      (event) =>
        event.operation_id !== originalOperationId &&
        event.history_result === 'background_available'
    );
    expect(currentSettlement).toMatchObject({
      history_phase: 'result',
      history_result: 'background_available',
      history_authority: 'keyed_state',
      operation_id: expect.any(String),
    });
    expect(screen.getByTestId('chat-messages-scroll')).toHaveTextContent('PRIVATE-TRANSCRIPT-B');
  });
});

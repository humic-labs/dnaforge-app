import { describe, expect, it } from 'vitest';
import { createEmptyConversationState, type ConversationState } from './chat-store-types';
import { mergeHydratedConversationState } from './chat-conversation-state';

function hydratedState(): ConversationState {
  return {
    ...createEmptyConversationState(),
    messages: [{ id: 'db-message', role: 'user', content: 'Persisted', createdAt: 1 }],
  };
}

describe('mergeHydratedConversationState', () => {
  it('retains a saved failure through an empty or queued hydration placeholder', () => {
    const hydrated = { ...hydratedState(), error: 'Your work is saved. Please try again.' };
    expect(mergeHydratedConversationState(hydrated, createEmptyConversationState()).error).toBe(
      hydrated.error
    );
  });

  it('keeps a live retry and a session-local preparation error authoritative', () => {
    const hydrated = { ...hydratedState(), error: 'Saved failure' };
    expect(
      mergeHydratedConversationState(hydrated, {
        ...createEmptyConversationState(),
        isLoading: true,
        error: null,
      }).error
    ).toBeNull();
    expect(
      mergeHydratedConversationState(hydrated, {
        ...createEmptyConversationState(),
        error: 'Cannot prepare this submission',
      }).error
    ).toBe('Cannot prepare this submission');
  });

  it('preserves a queued row that arrived during database hydration', () => {
    const latest = {
      ...createEmptyConversationState(),
      queuedMessages: [
        {
          id: 'queued-message',
          content: 'Follow up',
          workspacePath: null,
          referenceIds: [],
          routeSelection: {
            kind: 'provider' as const,
            provider: 'openai' as const,
            model: 'gpt-4o',
          },
          routeSnapshot: {
            routeKind: 'provider',
            hostId: 'direct-api',
            provider: 'openai' as const,
            model: 'gpt-4o',
            transport: null,
            authorityProfileId: null,
            permissionMode: null,
            routeSnapshotJson: JSON.stringify({
              kind: 'provider',
              provider: 'openai',
              model: 'gpt-4o',
            }),
          },
          createdAt: 2,
        },
      ],
    };

    const merged = mergeHydratedConversationState(hydratedState(), latest);

    expect(merged.messages.map((message) => message.id)).toEqual(['db-message']);
    expect(merged.queuedMessages.map((message) => message.id)).toEqual(['queued-message']);
  });

  it('keeps a live transcript authoritative when it appears during hydration', () => {
    const latest = {
      ...createEmptyConversationState(),
      messages: [{ id: 'live-message', role: 'user' as const, content: 'Live', createdAt: 3 }],
      isLoading: true,
    };

    const merged = mergeHydratedConversationState(hydratedState(), latest);

    expect(merged.messages.map((message) => message.id)).toEqual(['live-message']);
    expect(merged.isLoading).toBe(true);
  });
});

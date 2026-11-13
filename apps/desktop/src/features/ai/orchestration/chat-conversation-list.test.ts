import { describe, expect, it } from 'vitest';
import type { ConversationSummary } from './chat-store-types';
import {
  mergeLoadedConversationSummaries,
  orderConversationSummaries,
} from './chat-conversation-list';

const summary = (id: string, title = id): ConversationSummary => ({
  id,
  title,
  workspacePath: '/workspace',
  pinned: false,
  provider: null,
  model: null,
  createdAt: 0,
  updatedAt: 0,
});

describe('mergeLoadedConversationSummaries', () => {
  it('preserves local add, delete, rename, and pin mutations from a delayed load', () => {
    const renamed = { ...summary('keep', 'Renamed locally'), pinned: true };
    const result = mergeLoadedConversationSummaries({
      loaded: [summary('keep', 'Old DB title'), summary('deleted'), summary('db-only')],
      latest: [renamed, summary('new-local')],
      idsAtRequestStart: new Set(['keep', 'deleted']),
      deletedIds: new Set(['deleted']),
    });

    expect(result.map((conversation) => conversation.id)).toEqual(['keep', 'new-local', 'db-only']);
    expect(result.find((conversation) => conversation.id === 'keep')).toMatchObject({
      title: 'Renamed locally',
      pinned: true,
    });
  });

  it('orders pinned first and newest first without mutating exact-timestamp ties', () => {
    const input = [
      { ...summary('older-unpinned'), updatedAt: 10 },
      { ...summary('same-time-a'), updatedAt: 20 },
      { ...summary('pinned-older'), pinned: true, updatedAt: 5 },
      { ...summary('same-time-b'), updatedAt: 20 },
      { ...summary('pinned-newer'), pinned: true, updatedAt: 30 },
    ];

    expect(orderConversationSummaries(input).map((conversation) => conversation.id)).toEqual([
      'pinned-newer',
      'pinned-older',
      'same-time-a',
      'same-time-b',
      'older-unpinned',
    ]);
    expect(input.map((conversation) => conversation.id)).toEqual([
      'older-unpinned',
      'same-time-a',
      'pinned-older',
      'same-time-b',
      'pinned-newer',
    ]);
  });

  it('preserves local conversations from every workspace while an app-wide read settles', () => {
    const otherWorkspace = { ...summary('other-workspace'), workspacePath: '/other' };
    const result = mergeLoadedConversationSummaries({
      loaded: [summary('persisted')],
      latest: [otherWorkspace],
      idsAtRequestStart: new Set(),
    });

    expect(result.map((conversation) => conversation.id)).toEqual(['other-workspace', 'persisted']);
  });
});

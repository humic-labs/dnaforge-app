import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getMessageReferencesForMessages, expandReferences, expandReferencesFromIds } = vi.hoisted(
  () => ({
    getMessageReferencesForMessages: vi.fn(),
    expandReferences: vi.fn(),
    expandReferencesFromIds: vi.fn(),
  })
);

vi.mock('../../../db', () => ({ getMessageReferencesForMessages }));
vi.mock('./reference-context', () => ({ expandReferences, expandReferencesFromIds }));

import { assembleTurnModelMessages } from './assemble-turn-context';

describe('assembleTurnModelMessages inline reference authority', () => {
  beforeEach(() => {
    getMessageReferencesForMessages.mockReset();
    expandReferences.mockReset().mockImplementation(async (content: string) => content);
    expandReferencesFromIds
      .mockReset()
      .mockImplementation(async (content: string, ids: string[]) => `${content}:${ids.join(',')}`);
  });

  it('exposes only structured IDs attached to messages in this model context', async () => {
    getMessageReferencesForMessages.mockResolvedValue(
      new Map([
        ['user-history', ['reference-history']],
        ['assistant-history', ['reference-assistant']],
        ['tool-history', ['reference-tool']],
      ])
    );
    const messages = [
      { id: 'user-history', role: 'user' as const, content: 'Earlier', createdAt: 1 },
      { id: 'assistant-history', role: 'assistant' as const, content: 'Answer', createdAt: 2 },
      {
        id: 'tool-history',
        role: 'tool' as const,
        content: '{}',
        toolName: 'read_file',
        toolCallId: 'call-1',
        createdAt: 3,
      },
      { id: 'user-current', role: 'user' as const, content: 'Now', createdAt: 4 },
    ];

    const result = await assembleTurnModelMessages({
      messages,
      currentUserMessageId: 'user-current',
      stagedReferenceIds: ['reference-current'],
      workspacePath: '/repo',
    });

    expect(getMessageReferencesForMessages).toHaveBeenCalledWith([
      'user-history',
      'assistant-history',
      'tool-history',
      'user-current',
    ]);
    expect(result.exposedReferenceIds).toEqual([
      'reference-current',
      'reference-history',
      'reference-assistant',
      'reference-tool',
    ]);
    expect(expandReferencesFromIds).toHaveBeenCalledWith('Earlier', ['reference-history']);
    expect(expandReferencesFromIds).toHaveBeenCalledWith('Now', ['reference-current']);
  });

  it('fails closed to the current staged IDs when historical join loading fails', async () => {
    getMessageReferencesForMessages.mockRejectedValue(new Error('database unavailable'));

    const result = await assembleTurnModelMessages({
      messages: [{ id: 'user-current', role: 'user', content: 'Now', createdAt: 1 }],
      currentUserMessageId: 'user-current',
      stagedReferenceIds: ['reference-current'],
      workspacePath: '/repo',
    });

    expect(result.exposedReferenceIds).toEqual(['reference-current']);
  });
});

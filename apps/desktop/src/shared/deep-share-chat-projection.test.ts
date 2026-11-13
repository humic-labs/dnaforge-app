// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { projectPortableConversation } from './deep-share-chat-projection';

describe('projectPortableConversation', () => {
  it('keeps user prompts, final assistant answers, and included-artifact references only', () => {
    const result = projectPortableConversation({
      conversation: {
        id: 'conversation-1',
        title: 'Construct review',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_005_000,
      },
      messages: [
        { id: 'user-1', turnId: 'turn-1', role: 'user', content: 'Review it.', createdAt: 1 },
        {
          id: 'thinking-1',
          turnId: 'turn-1',
          role: 'assistant',
          content: 'Intermediate thought.',
          createdAt: 2,
        },
        {
          id: 'activity-1',
          turnId: 'turn-1',
          role: 'activity',
          content: 'PRIVATE_FIELD_CANARY_7F3A',
          createdAt: 3,
        },
        {
          id: 'tool-1',
          turnId: 'turn-1',
          role: 'tool',
          content: 'PRIVATE_FIELD_CANARY_7F3A',
          createdAt: 4,
        },
        {
          id: 'answer-1',
          turnId: 'turn-1',
          role: 'assistant',
          content: 'The construct is valid.[[ref:reference-1]]',
          createdAt: 5,
        },
      ],
      referencesByMessageId: new Map([
        [
          'answer-1',
          [
            {
              artifactId: 'artifact-1',
              artifactType: 'sequence',
              label: 'Construct',
            },
            {
              artifactId: 'excluded-artifact',
              artifactType: 'file',
              label: 'Not shared',
            },
          ],
        ],
      ]),
      includedArtifacts: new Map([['artifact-1', { type: 'sequence', name: 'Construct' }]]),
    });

    expect(result.messages).toEqual([
      expect.objectContaining({ id: 'user-1', role: 'user', content: 'Review it.' }),
      expect.objectContaining({
        id: 'answer-1',
        role: 'assistant',
        content: 'The construct is valid.',
        references: [{ artifactId: 'artifact-1', artifactType: 'sequence', label: 'Construct' }],
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_FIELD_CANARY_7F3A');
    expect(JSON.stringify(result)).not.toContain('excluded-artifact');
  });

  it('removes app-generated attachment framing and ignores extra runtime fields', () => {
    const userMessage = Object.assign(
      {
        id: 'user-1',
        turnId: 'turn-1',
        role: 'user' as const,
        content:
          'Compare this construct.\n\nAttached files:\n--- File: private-plan.md ---\nPRIVATE_FIELD_CANARY_7F3A',
        createdAt: 1,
      },
      {
        provider: 'PRIVATE_FIELD_CANARY_7F3A',
        routeSnapshot: { host: 'PRIVATE_FIELD_CANARY_7F3A' },
        toolCalls: [{ output: 'PRIVATE_FIELD_CANARY_7F3A' }],
      }
    );

    const result = projectPortableConversation({
      conversation: {
        id: 'conversation-1',
        title: 'Attachment review',
        createdAt: 1,
        updatedAt: 2,
      },
      messages: [userMessage],
      referencesByMessageId: new Map(),
      includedArtifacts: new Map(),
    });

    expect(result.messages[0].content).toBe('Compare this construct.');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_FIELD_CANARY_7F3A');
    expect(JSON.stringify(result)).not.toContain('private-plan.md');
  });
});

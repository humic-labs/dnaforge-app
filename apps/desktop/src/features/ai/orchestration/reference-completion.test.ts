import { describe, expect, it } from 'vitest';
import type { ChatMessage } from './chat-types';
import { EMPTY_RESPONSE_FALLBACK, referenceCompletionFallback } from './reference-completion';

function referenceMessage(referenceId: string, materialized = true): ChatMessage {
  return {
    id: `message-${referenceId}`,
    turnId: 'turn-1',
    role: 'tool',
    toolName: 'create_reference',
    toolCallId: `call-${referenceId}`,
    content: JSON.stringify({
      output: { referenceId },
      ...(materialized ? { referenceData: { id: referenceId } } : {}),
    }),
    createdAt: 1,
  };
}

describe('referenceCompletionFallback', () => {
  it('acknowledges one or many materialized reference chips after empty or short model text', () => {
    expect(referenceCompletionFallback([referenceMessage('ref-1')], '')).toBe(
      'Created the requested clickable reference.'
    );
    expect(
      referenceCompletionFallback(
        [referenceMessage('ref-1'), referenceMessage('ref-2')],
        '[ pUC19 ]'
      )
    ).toBe('Created the requested clickable references.');
  });

  it('does not claim success for an unmaterialized reference or replace substantive prose', () => {
    expect(referenceCompletionFallback([referenceMessage('ref-1', false)], '')).toBe(
      EMPTY_RESPONSE_FALLBACK
    );
    expect(
      referenceCompletionFallback(
        [referenceMessage('ref-1')],
        'Created the exact requested pUC19 reference and verified its target.'
      )
    ).toBeNull();
  });
});

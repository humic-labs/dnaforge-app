import { describe, expect, it } from 'vitest';
import type { ChatEntityReferenceIpcRow } from '../../../shared/chat-turn-ipc';
import type { ContentBlock } from './chat-types';
import { presentCliReferencesInline } from './cli-reference-presentation';

const referenceId = '59f80a0b-64bf-40a0-bcd3-ff7cf2067505';
const reference: ChatEntityReferenceIpcRow = {
  id: referenceId,
  entity_type: 'sequence',
  display_label: 'pUC19.gb',
  locator: 'git://workspace/sequences/pUC19.gb',
  deep_link_params: null,
  data: null,
  source: 'ai',
  status: 'created',
  workspace_scope: null,
  workspace_root_path: null,
  created_at: 1,
  updated_at: 1,
};

function referenceBlock(): Extract<ContentBlock, { type: 'ref' }> {
  return {
    type: 'ref',
    reference,
    message: {
      id: 'tool-message',
      turnId: 'turn-1',
      role: 'tool',
      toolName: 'create_reference',
      toolCallId: 'call-1',
      content: JSON.stringify({
        input: { entityType: 'sequence', documentId: 'document-1' },
        output: { referenceId },
        isError: false,
        referenceData: reference,
      }),
      createdAt: 1,
    },
  };
}

describe('CLI reference presentation', () => {
  it('keeps completed tool history without a second chip or message association for an inline UUID', () => {
    const block = referenceBlock();
    const projected = presentCliReferencesInline([block], new Set([referenceId]));
    expect(projected).toEqual([
      {
        type: 'tool',
        message: {
          ...block.message,
          referenceIds: [],
          content: JSON.stringify({
            input: { entityType: 'sequence', documentId: 'document-1' },
            output: { referenceId },
            isError: false,
          }),
        },
      },
    ]);
    expect(JSON.parse(block.message.content).referenceData).toEqual(reference);
  });

  it('preserves the standalone fallback when no inline reference resolves', () => {
    const block = referenceBlock();
    expect(presentCliReferencesInline([block], new Set())).toEqual([block]);
  });

  it('preserves a different UUID even when another reference to the same entity is inline', () => {
    const block = referenceBlock();
    expect(presentCliReferencesInline([block], new Set(['different-reference']))).toEqual([block]);
  });

  it('preserves unrelated tool history', () => {
    const block: ContentBlock = { type: 'tool', message: referenceBlock().message };
    expect(presentCliReferencesInline([block], new Set([referenceId]))).toEqual([block]);
  });

  it('rejects invalid serialized reference history instead of dropping it', () => {
    const block = referenceBlock();
    block.message.content = 'null';
    expect(() => presentCliReferencesInline([block], new Set([referenceId]))).toThrow(
      'CLI reference history is invalid'
    );
  });
});

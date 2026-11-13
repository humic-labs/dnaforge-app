import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DBEntityReference } from '../../db/entity-references';
import { useChatStore } from '../../features/ai/hooks/useChat';
import type { AttachedFile } from './FilePill';
import { useConversationComposerDraft } from './useConversationComposerDraft';

function DraftHarness({ conversationId }: { conversationId: string }) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<AttachedFile[]>([]);
  const [references, setReferences] = useState<DBEntityReference[]>([]);
  useConversationComposerDraft({
    conversationId,
    text,
    attachments,
    references,
    setText,
    setAttachments,
    setReferences,
  });
  return (
    <div>
      <textarea data-testid="draft-input" value={text} onChange={(e) => setText(e.target.value)} />
      <span data-testid="attachment-names">{attachments.map((file) => file.name).join(',')}</span>
      <span data-testid="reference-labels">
        {references.map((reference) => reference.display_label).join(',')}
      </span>
    </div>
  );
}

describe('useConversationComposerDraft', () => {
  beforeEach(() => {
    useChatStore.setState(useChatStore.getInitialState(), true);
  });

  afterEach(() => {
    useChatStore.setState(useChatStore.getInitialState(), true);
  });

  it('restores drafts without a Strict Mode cleanup erasing them', async () => {
    useChatStore.getState().setComposerDraft('draft-conv', {
      text: 'This belongs to the preserved chat',
      attachments: [
        {
          id: 'file-1',
          name: 'notes.txt',
          path: '/workspace/notes.txt',
          size: 5,
          content: 'notes',
        },
      ],
      references: [
        {
          id: 'ref-1',
          entity_type: 'sequence',
          display_label: 'Selected region',
          locator: '/workspace/example.gb',
          deep_link_params: null,
          data: null,
          source: 'test',
          status: 'created',
          workspace_scope: '/workspace',
          created_at: 1,
          updated_at: 1,
        },
      ],
    });

    const { rerender } = render(
      <StrictMode>
        <DraftHarness key="draft-conv" conversationId="draft-conv" />
      </StrictMode>
    );
    const input = screen.getByTestId('draft-input');
    expect(input).toHaveValue('This belongs to the preserved chat');
    expect(screen.getByTestId('attachment-names')).toHaveTextContent('notes.txt');
    expect(screen.getByTestId('reference-labels')).toHaveTextContent('Selected region');
    expect(useChatStore.getState().composerDrafts.get('draft-conv')?.text).toBe(
      'This belongs to the preserved chat'
    );

    fireEvent.change(input, { target: { value: 'Updated preserved draft' } });
    await waitFor(() => {
      expect(useChatStore.getState().composerDrafts.get('draft-conv')?.text).toBe(
        'Updated preserved draft'
      );
    });

    rerender(
      <StrictMode>
        <DraftHarness key="blank-conv" conversationId="blank-conv" />
      </StrictMode>
    );
    expect(screen.getByTestId('draft-input')).toHaveValue('');

    rerender(
      <StrictMode>
        <DraftHarness key="draft-conv" conversationId="draft-conv" />
      </StrictMode>
    );
    expect(screen.getByTestId('draft-input')).toHaveValue('Updated preserved draft');
  });
});

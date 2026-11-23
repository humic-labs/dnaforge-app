import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DBEntityReference } from '../../db/entity-references';
import { useChatStore } from '../../features/ai/hooks/useChat';
import type { AttachedFile } from './FilePill';
import { useConversationComposerDraft } from './useConversationComposerDraft';

function DraftHarness({
  conversationId,
  ...refusal
}: Pick<
  Parameters<typeof useConversationComposerDraft>[0],
  'refusedMessage' | 'refusedReferenceIds' | 'referenceMap'
> & { conversationId: string }) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<AttachedFile[]>([]);
  const [references, setReferences] = useState<DBEntityReference[]>([]);
  useConversationComposerDraft({
    conversationId,
    ...refusal,
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

  it('recovers refused input with its reference and attachment after hydration and yields to edits', () => {
    const refused = {
      id: 'refused-user',
      role: 'user' as const,
      createdAt: 1,
      content: '  雪' + 'Δ'.repeat(33_000) + ' fin  ',
      attachments: [
        { id: 'file-1', name: 'note.txt', path: '/test/note.txt', size: 2, content: 'hi' },
      ],
    };
    const ref = {
      id: 'ref-1',
      entity_type: 'sequence',
      display_label: 'My selection',
      locator: 'test',
      data: null,
      deep_link_params: null,
      source: 'test',
      status: 'created',
      workspace_scope: null,
      created_at: 1,
      updated_at: 1,
    } satisfies DBEntityReference;
    const normal = <DraftHarness conversationId="one" />;
    const recovered = (
      <DraftHarness
        conversationId="one"
        refusedMessage={refused}
        refusedReferenceIds={[ref.id]}
        referenceMap={new Map([[ref.id, ref]])}
      />
    );
    const first = render(normal);
    first.rerender(recovered);
    expect(screen.getByTestId('draft-input')).toHaveValue(refused.content);
    expect(screen.getByTestId('reference-labels')).toHaveTextContent(ref.display_label);
    expect(screen.getByTestId('attachment-names')).toHaveTextContent('note.txt');
    first.unmount();
    useChatStore.setState(useChatStore.getInitialState(), true);
    const restarted = render(<StrictMode>{recovered}</StrictMode>);
    expect(screen.getByTestId('draft-input')).toHaveValue(refused.content);
    restarted.unmount();
    useChatStore.setState(useChatStore.getInitialState(), true);
    const withNewerInput = render(normal);
    fireEvent.change(screen.getByTestId('draft-input'), { target: { value: 'a newer draft' } });
    withNewerInput.rerender(recovered);
    expect(screen.getByTestId('draft-input')).toHaveValue('a newer draft');
    expect(screen.getByTestId('reference-labels')).toBeEmptyDOMElement();
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

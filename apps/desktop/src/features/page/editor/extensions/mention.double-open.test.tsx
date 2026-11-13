/**
 * @vitest-environment jsdom
 */
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MentionExtension } from './mention';

let opens: CustomEvent[] = [];
const listener = (event: Event) => opens.push(event as CustomEvent);

beforeEach(() => {
  opens = [];
  window.addEventListener('waypoint:open-entity', listener);
});
afterEach(() => window.removeEventListener('waypoint:open-entity', listener));

const DOC = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'we cut ' },
        {
          type: 'mention',
          attrs: {
            label: 'pUC19',
            entityType: 'sequence',
            entityId: 'ent-1',
            path: 'sequences/pUC19.gb',
            contentHash: null,
          },
        },
      ],
    },
  ],
};

function Harness() {
  const editor = useEditor({
    extensions: [
      StarterKit,
      MentionExtension.configure({
        onMentionClick: (intent) => {
          window.dispatchEvent(new CustomEvent('waypoint:open-entity', { detail: intent }));
        },
        onCreatePage: null,
      }),
    ],
    content: DOC,
  });
  return <EditorContent editor={editor} />;
}

describe('a chip click opens exactly once', () => {
  it('dispatches ONE open event, not one per click owner', async () => {
    const { container } = render(<Harness />);

    const chip = await waitFor(() => {
      const found = container.querySelector('[data-testid="mention-chip"]') as HTMLElement | null;
      expect(found, 'the node view should have rendered a chip').not.toBeNull();
      return found!;
    });

    chip.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    await waitFor(() => expect(opens.length).toBeGreaterThan(0));
    expect(
      opens.length,
      `expected exactly one open, got ${opens.length} — the node view and the ` +
        'ProseMirror click plugin are both handling the same click'
    ).toBe(1);
  });

  it('renders the chip as INLINE content inside the paragraph', async () => {
    const { container } = render(<Harness />);

    await waitFor(() => {
      const paragraph = container.querySelector('p');
      expect(paragraph?.querySelector('[data-testid="mention-chip"]')).not.toBeNull();
    });
  });
});

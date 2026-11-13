/**
 * @vitest-environment jsdom
 */
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MentionExtension, type MentionAttrs } from './mention';

const removers: Array<() => void> = [];
afterEach(() => {
  cleanup();
  for (const remove of removers.splice(0)) remove();
});

function Harness({ mention }: { mention: MentionAttrs }) {
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
    content: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: mention }] }],
    },
  });
  return <EditorContent editor={editor} />;
}

async function mount(onOpen: (attrs: MentionAttrs) => void, mention: MentionAttrs) {
  const listener = (event: Event) => onOpen((event as CustomEvent<MentionAttrs>).detail);
  window.addEventListener('waypoint:open-entity', listener);
  removers.push(() => window.removeEventListener('waypoint:open-entity', listener));
  const view = render(<Harness mention={mention} />);
  return view.findByTestId('mention-chip');
}

describe('mention click in the real React editor opens the target entity', () => {
  it('fires for a SEQUENCE mention with its attrs', async () => {
    const spy = vi.fn();
    const chip = await mount(spy, {
      entityType: 'sequence',
      entityId: 'sequences/circular/pUC19.gb',
      label: 'pUC19',
    });
    fireEvent.click(chip);
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy.mock.calls[0][0]).toMatchObject({
      entityType: 'sequence',
      entityId: 'sequences/circular/pUC19.gb',
      action: 'open',
    });
  });

  it('fires for a DESIGN mention', async () => {
    const spy = vi.fn();
    const chip = await mount(spy, {
      entityType: 'design',
      entityId: 'designs/x.wpdesign.json',
      label: 'X',
    });
    fireEvent.click(chip);
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy.mock.calls[0][0]).toMatchObject({
      entityType: 'design',
      entityId: 'designs/x.wpdesign.json',
      action: 'open',
    });
  });
});

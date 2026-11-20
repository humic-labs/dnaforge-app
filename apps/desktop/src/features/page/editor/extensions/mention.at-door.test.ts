// @vitest-environment jsdom
import { Editor, type Range } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MentionExtension } from './mention';
let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});
function setup(content = '<p>hi @pUC there</p>') {
  const obsoleteResolver = vi.fn();
  const extension = MentionExtension.configure({
    onMentionClick: null,
    onCreatePage: null,
    resolveReferenceRecord: obsoleteResolver,
  });
  editor = new Editor({ content, extensions: [StarterKit, extension] });
  const command = (
    extension.options as {
      suggestion: { command: (input: { editor: Editor; range: Range; props: unknown }) => unknown };
    }
  ).suggestion.command;
  return { editor, command, obsoleteResolver };
}
function mentions(ed: Editor) {
  const found: Record<string, unknown>[] = [];
  ed.state.doc.descendants((node) => {
    if (node.type.name === 'mention') found.push(node.attrs);
  });
  return found;
}
const range: Range = { from: 4, to: 8 };
const chosen = {
  entityType: 'sequence',
  entityId: 'repo-beta::pUC19',
  label: 'pUC19',
  path: 'sequences/vectors/pUC19.gb',
  contentHash: `sha256:${'d'.repeat(64)}`,
  objectUuid: 'pUC19',
  projectId: 'repo-beta',
};

describe('the @ door consumes the verified canonical picker record', () => {
  it('stores the exact target path, content hash and owning project', () => {
    const { editor: ed, command } = setup();
    command({ editor: ed, range, props: chosen });
    expect(mentions(ed)).toEqual([expect.objectContaining(chosen)]);
    expect(mentions(ed)[0].occurrenceId).toEqual(expect.any(String));
    expect(mentions(ed)[0].occurrenceId).not.toBe(chosen.entityId);
  });
  it('does not run a second name-based resolver after exact-ID selection', () => {
    const { editor: ed, command, obsoleteResolver } = setup();
    expect(command({ editor: ed, range, props: chosen })).toBeUndefined();
    expect(obsoleteResolver).not.toHaveBeenCalled();
  });
  it('replaces only the query in one document transaction', () => {
    const { editor: ed, command } = setup();
    const changes: unknown[] = [];
    ed.on('transaction', ({ transaction }) => {
      if (transaction.docChanged) changes.push(transaction);
    });
    command({ editor: ed, range, props: chosen });
    expect(changes).toHaveLength(1);
    expect(ed.getText()).toBe('hi pUC19 there');
    expect(ed.state.doc.textContent).not.toContain('@pUC');
  });
  it('does not append synthetic whitespace at the end of a paragraph', () => {
    const { editor: ed, command } = setup('<p>hi @pUC</p>');
    command({ editor: ed, range, props: chosen });
    expect(ed.state.doc.child(0).lastChild?.type.name).toBe('mention');
    expect(ed.getText()).toBe('hi pUC19');
  });
  it.each([null, '', 'new'])(
    'preserves literal query when a canonical target is absent: %j',
    (entityId) => {
      const { editor: ed, command } = setup();
      const before = ed.getJSON();
      command({ editor: ed, range, props: { ...chosen, entityId } });
      expect(ed.getJSON()).toEqual(before);
      expect(mentions(ed)).toHaveLength(0);
    }
  );
  it('keeps a pathless canonical record without inventing a file or resolving by label', () => {
    const { editor: ed, command, obsoleteResolver } = setup();
    command({
      editor: ed,
      range,
      props: {
        entityType: 'registry',
        entityId: 'saved-record',
        label: 'Record',
        registryKind: 'strain',
      },
    });
    expect(mentions(ed)[0]).toMatchObject({
      entityId: 'saved-record',
      path: null,
      contentHash: null,
      registryKind: 'strain',
    });
    expect(obsoleteResolver).not.toHaveBeenCalled();
  });
  it('keeps the inserted identity through a later unrelated edit', () => {
    const { editor: ed, command } = setup();
    command({ editor: ed, range, props: chosen });
    const before = { ...mentions(ed)[0] };
    ed.commands.insertContentAt(1, 'ZZ');
    expect(mentions(ed)[0]).toEqual(before);
    expect(ed.getText()).toBe('ZZhi pUC19 there');
  });
});

/**
 * @vitest-environment jsdom
 */
import { Editor, type Range } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MentionExtension } from './mention';

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

type Resolver =
  NonNullable<Parameters<typeof MentionExtension.configure>[0]> extends {
    resolveReferenceRecord?: infer R;
  }
    ? R
    : never;

function setup(resolveReferenceRecord?: Resolver, content = '<p>hi @pUC</p>') {
  const extension = MentionExtension.configure({
    onMentionClick: null,
    onCreatePage: null,
    ...(resolveReferenceRecord ? { resolveReferenceRecord } : {}),
  });
  editor = new Editor({ content, extensions: [StarterKit, extension] });
  const command = (
    extension.options as {
      suggestion: { command: (p: { editor: Editor; range: Range; props: unknown }) => unknown };
    }
  ).suggestion.command;
  return { editor, command };
}

function mentions(ed: Editor): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  ed.state.doc.descendants((node) => {
    if (node.type.name === 'mention') found.push(node.attrs);
    return true;
  });
  return found;
}

function textBeforeMention(ed: Editor): string {
  let at: number | null = null;
  ed.state.doc.descendants((node, pos) => {
    if (at === null && node.type.name === 'mention') at = pos;
    return at === null;
  });
  return at === null ? ed.state.doc.textContent : ed.state.doc.textBetween(0, at, '', '');
}

const CHOSEN = { entityType: 'sequence', entityId: null, label: 'pUC19' };
const AT_RANGE: Range = { from: 4, to: 8 };

describe('the @ door writes the same record as the picker', () => {
  it('inserts the resolved path and contentHash', async () => {
    const hash = `sha256:${'d'.repeat(64)}`;
    const { editor: ed, command } = setup(
      vi.fn().mockResolvedValue({ path: 'sequences/vectors/pUC19.gb', contentHash: hash })
    );

    await command({ editor: ed, range: AT_RANGE, props: CHOSEN });

    const [chip] = mentions(ed);
    expect(chip?.path).toBe('sequences/vectors/pUC19.gb');
    expect(chip?.contentHash).toBe(hash);
    expect(chip?.entityType).toBe('sequence');
    expect(chip?.label).toBe('pUC19');
  });

  it('resolves ONCE, for the chosen item only', async () => {
    const resolve = vi.fn().mockResolvedValue({ path: 'a/b.gb', contentHash: null });
    const { editor: ed, command } = setup(resolve);

    await command({ editor: ed, range: AT_RANGE, props: CHOSEN });

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ label: 'pUC19' }));
  });

  it('removes the "@pUC" query text', async () => {
    const { editor: ed, command } = setup(
      vi.fn().mockResolvedValue({ path: 'a/b.gb', contentHash: null })
    );

    await command({ editor: ed, range: AT_RANGE, props: CHOSEN });

    expect(ed.state.doc.textContent).not.toContain('@pUC');
  });

  it('remaps when the user types while the record is resolving', async () => {
    let release: (r: { path: string; contentHash: string | null }) => void = () => {};
    const { editor: ed, command } = setup(
      vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            release = resolve;
          })
      )
    );

    const pending = command({ editor: ed, range: AT_RANGE, props: CHOSEN });
    expect(ed.state.doc.textContent).not.toContain('@pUC');

    ed.chain().insertContentAt(1, 'ZZ').run();
    release({ path: 'a/b.gb', contentHash: null });
    await pending;

    expect(mentions(ed)).toHaveLength(1);
    expect(textBeforeMention(ed)).toBe('ZZhi ');
  });

  it('abandons the chip when its anchoring text was deleted mid-resolve', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let release: (r: { path: string; contentHash: string | null }) => void = () => {};
    const { editor: ed, command } = setup(
      vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            release = resolve;
          })
      ),
      '<p>hi @pUC there</p>'
    );

    const pending = command({ editor: ed, range: AT_RANGE, props: CHOSEN });
    ed.chain()
      .deleteRange({ from: 1, to: ed.state.doc.content.size - 1 })
      .run();

    release({ path: 'a/b.gb', contentHash: null });
    await pending;

    expect(mentions(ed)).toHaveLength(0);
    warn.mockRestore();
  });

  it('still inserts a chip when the resolver fails, carrying a null record', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { editor: ed, command } = setup(vi.fn().mockRejectedValue(new Error('hash failed')));

    await command({ editor: ed, range: AT_RANGE, props: CHOSEN });

    expect(mentions(ed)).toHaveLength(1);
    expect(mentions(ed)[0]?.path).toBeNull();
    error.mockRestore();
  });
});

describe('the @ door without a resolver keeps its original behaviour', () => {
  it('inserts synchronously with a null record', () => {
    const { editor: ed, command } = setup();

    const result = command({
      editor: ed,
      range: AT_RANGE,
      props: { entityType: 'page', entityId: 'page-1', label: 'Notes' },
    });

    expect(result).toBeUndefined();
    const [chip] = mentions(ed);
    expect(chip?.entityId).toBe('page-1');
    expect(chip?.path).toBeNull();
    expect(chip?.contentHash).toBeNull();
  });
});

describe('an @ item that already carries a path', () => {
  it('inserts it directly, with no resolver round trip', () => {
    const resolve = vi.fn();
    const { editor: ed, command } = setup(resolve as never);

    const result = command({
      editor: ed,
      range: AT_RANGE,
      props: {
        entityType: 'sequence',
        entityId: 'ent-1',
        label: 'pUC19',
        path: 'sequences/pUC19.gb',
        contentHash: `sha256:${'e'.repeat(64)}`,
      },
    });

    expect(result).toBeUndefined();
    expect(resolve, 'no round trip when the item already has the answer').not.toHaveBeenCalled();

    const [chip] = mentions(ed);
    expect(chip?.path).toBe('sequences/pUC19.gb');
    expect(chip?.contentHash).toBe(`sha256:${'e'.repeat(64)}`);
  });

  it('still falls back to the resolver when the item has no path', async () => {
    const resolve = vi.fn().mockResolvedValue({ path: 'resolved/x.gb', contentHash: null });
    const { editor: ed, command } = setup(resolve as never);

    await command({
      editor: ed,
      range: AT_RANGE,
      props: { entityType: 'sequence', entityId: 'ent-1', label: 'x', path: null },
    });

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(mentions(ed)[0]?.path).toBe('resolved/x.gb');
  });
});

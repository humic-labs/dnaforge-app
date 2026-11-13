/**
 * @vitest-environment jsdom
 */
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EmbedNode, MentionExtension } from '../editor/extensions';
import { createEmbedRegistry, embedRegistry } from './registry';
import type { EmbedDefinition, PickerResult } from './types';

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

function makeEditor(content = '<p>hello</p>'): Editor {
  editor = new Editor({
    content,
    extensions: [
      StarterKit,
      MentionExtension.configure({ onMentionClick: null, onCreatePage: null }),
    ],
  });
  return editor;
}

function mentionNodes(ed: Editor): { attrs: Record<string, unknown> }[] {
  const found: { attrs: Record<string, unknown> }[] = [];
  ed.state.doc.descendants((node) => {
    if (node.type.name === 'mention') found.push({ attrs: node.attrs });
    return true;
  });
  return found;
}

function textBeforeMention(ed: Editor): string {
  let mentionPos: number | null = null;
  ed.state.doc.descendants((node, pos) => {
    if (mentionPos === null && node.type.name === 'mention') mentionPos = pos;
    return mentionPos === null;
  });
  if (mentionPos === null) return ed.state.doc.textContent;
  return ed.state.doc.textBetween(0, mentionPos, '', '');
}

function definition(onComplete: EmbedDefinition['picker']['onComplete']): EmbedDefinition {
  return {
    type: 'sequence-ref',
    version: 1,
    label: 'Sequence',
    icon: 'sequence',
    keywords: [],
    picker: { stages: [], onComplete },
  };
}

const RECORD: PickerResult = {
  nodeType: 'mention',
  entityType: 'sequence',
  entityId: null,
  label: 'pUC19',
  path: 'sequences/vectors/pUC19.gb',
  contentHash: `sha256:${'b'.repeat(64)}`,
};

describe('the real registry inserts a reference record', () => {
  it('writes path and contentHash onto the inserted mention', () => {
    const registry = createEmbedRegistry();
    registry.register(definition(() => RECORD));
    const ed = makeEditor();

    const result = registry.completePickerFlow('sequence-ref', ed, {}, 1);

    expect(result).toBe(true);
    const [mention] = mentionNodes(ed);
    expect(mention?.attrs.path).toBe('sequences/vectors/pUC19.gb');
    expect(mention?.attrs.contentHash).toBe(RECORD.contentHash);
    expect(mention?.attrs.entityId).toBeNull();
    expect(mention?.attrs.label).toBe('pUC19');
  });

  it('inserts synchronously when onComplete is synchronous', () => {
    const registry = createEmbedRegistry();
    registry.register(definition(() => RECORD));
    const ed = makeEditor();

    const result = registry.completePickerFlow('sequence-ref', ed, {}, 1);

    expect(typeof result).toBe('boolean');
    expect(mentionNodes(ed)).toHaveLength(1);
  });
});

describe('versioned rich-block insertion', () => {
  it('stamps the registered content version on the generic embed node', () => {
    const registry = createEmbedRegistry();
    const Renderer = () => null;
    registry.register({
      type: 'versioned-table',
      version: 3,
      label: 'Versioned table',
      icon: 'table',
      keywords: [],
      Renderer,
      picker: {
        stages: [],
        onComplete: () => ({
          nodeType: 'embed',
          embedType: 'versioned-table',
          refId: 'table-3',
          data: { rows: 1 },
        }),
      },
    });
    editor = new Editor({ content: '<p>hello</p>', extensions: [StarterKit, EmbedNode] });

    expect(registry.completePickerFlow('versioned-table', editor, {}, 0)).toBe(true);
    const embeds: Array<{ attrs: Record<string, unknown> }> = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'embed') embeds.push({ attrs: node.attrs });
      return true;
    });
    expect(embeds).toEqual([
      {
        attrs: {
          type: 'versioned-table',
          version: 3,
          refId: 'table-3',
          data: { rows: 1 },
        },
      },
    ]);
  });

  it('returns a renderer only for the exact registered content version', () => {
    const registry = createEmbedRegistry();
    const Renderer = () => null;
    registry.register({
      type: 'versioned-table',
      version: 3,
      label: 'Versioned table',
      icon: 'table',
      keywords: [],
      Renderer,
      picker: {
        stages: [],
        onComplete: () => ({
          nodeType: 'embed',
          embedType: 'versioned-table',
          refId: 'table-3',
        }),
      },
    });

    expect(registry.getRenderer('versioned-table', 3)).toBe(Renderer);
    expect(registry.getRenderer('versioned-table', 4)).toBeUndefined();
  });
});

describe('the async seam  §4.6)', () => {
  it('awaits an async onComplete and still inserts the record', async () => {
    const registry = createEmbedRegistry();
    registry.register(definition(async () => RECORD));
    const ed = makeEditor();

    const pending = registry.completePickerFlow('sequence-ref', ed, {}, 1);
    expect(pending).toBeInstanceOf(Promise);
    expect(mentionNodes(ed)).toHaveLength(0);

    await expect(pending).resolves.toBe(true);
    expect(mentionNodes(ed)[0]?.attrs.path).toBe('sequences/vectors/pUC19.gb');
  });

  it('remaps the insertion position when the user types while awaiting', async () => {
    const registry = createEmbedRegistry();
    let release: (r: PickerResult) => void = () => {};
    registry.register(
      definition(
        () =>
          new Promise<PickerResult>((resolve) => {
            release = resolve;
          })
      )
    );
    const ed = makeEditor('<p>abc</p>');

    const endOfText = 4;
    const pending = registry.completePickerFlow('sequence-ref', ed, {}, endOfText);

    ed.chain().insertContentAt(1, 'XYZ').run();
    const textBefore = ed.state.doc.textContent;
    expect(textBefore).toBe('XYZabc');

    release(RECORD);
    await pending;

    expect(mentionNodes(ed)).toHaveLength(1);

    expect(textBeforeMention(ed)).toBe('XYZabc');
  });

  it('abandons the insertion when the anchoring text was deleted', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const registry = createEmbedRegistry();
    let release: (r: PickerResult) => void = () => {};
    registry.register(
      definition(
        () =>
          new Promise<PickerResult>((resolve) => {
            release = resolve;
          })
      )
    );
    const ed = makeEditor('<p>abcdef</p>');

    const pending = registry.completePickerFlow('sequence-ref', ed, {}, 4);
    ed.chain().deleteRange({ from: 1, to: 7 }).run();

    release(RECORD);
    await expect(pending).resolves.toBe(false);

    expect(mentionNodes(ed)).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Abandoned'));
    warn.mockRestore();
  });

  it('does not insert into a destroyed editor', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const registry = createEmbedRegistry();
    let release: (r: PickerResult) => void = () => {};
    registry.register(
      definition(
        () =>
          new Promise<PickerResult>((resolve) => {
            release = resolve;
          })
      )
    );
    const ed = makeEditor();

    const pending = registry.completePickerFlow('sequence-ref', ed, {}, 1);
    ed.destroy();
    release(RECORD);

    await expect(pending).resolves.toBe(false);
    warn.mockRestore();
  });

  it('reports false when the async onComplete rejects', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const registry = createEmbedRegistry();
    registry.register(definition(async () => Promise.reject(new Error('hash failed'))));
    const ed = makeEditor();

    await expect(registry.completePickerFlow('sequence-ref', ed, {}, 1)).resolves.toBe(false);
    expect(mentionNodes(ed)).toHaveLength(0);
    error.mockRestore();
  });
});

describe('singleton wiring', () => {
  it('the exported singleton is a real registry, not a separate shape', () => {
    expect(typeof embedRegistry.completePickerFlow).toBe('function');
    expect(typeof embedRegistry.register).toBe('function');
    expect(Object.getPrototypeOf(embedRegistry)).toBe(Object.getPrototypeOf(createEmbedRegistry()));
  });
});

describe('import-only embeds stay out of the slash menu', () => {
  it('never offers benchling-reference as an insert command', async () => {
    await import('./benchling-reference');
    const names = embedRegistry.getSlashCommands().map((command) => command.name);
    expect(names).not.toContain('benchling-reference');
  });

  it('still renders benchling-reference nodes that an import produced', async () => {
    await import('./benchling-reference');
    expect(embedRegistry.getRenderer('benchling-reference', 1)).toBeDefined();
    expect(embedRegistry.getRenderer('benchling-reference', 2)).toBeUndefined();
  });

  it('keeps hand-insertable embeds in the menu', async () => {
    await import('./image');
    expect(embedRegistry.getSlashCommands().map((command) => command.name)).toContain('image');
  });
});

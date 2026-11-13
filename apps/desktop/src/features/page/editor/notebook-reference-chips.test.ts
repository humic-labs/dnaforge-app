import { Editor, getSchema, type JSONContent } from '@tiptap/core';
import { DOMParser, DOMSerializer } from '@tiptap/pm/model';
import { describe, expect, it } from 'vitest';

import {
  parseNotebookMarkdown,
  serializeNotebookMarkdown,
} from '../../../db/notebook-markdown-codec';
import { getBaseExtensions, MentionExtension } from './extensions';
import { contentFingerprint } from '../../../shared/content-fingerprint';
import { canonicalNotebookJson } from '../../../db/notebook-markdown-codec';

const referenceId = 'e8a02a98-2484-4080-9c6b-04ade0763803';
const href = `dnaforge-chat://reference/${referenceId}`;
const label = 'M744_RS09620 read-derived S108P allele fraction';
const identity = { id: 'report', title: 'NGS evidence report', formatVersion: 2 };
const linkBlock: JSONContent = {
  type: 'paragraph',
  content: [{ type: 'text', text: label, marks: [{ type: 'link', attrs: { href } }] }],
};
const expectedChip = {
  type: 'mention',
  attrs: { referenceUri: href, label },
};
const extensions = () => [...getBaseExtensions(), MentionExtension];

describe('native notebook references by construction', () => {
  it('stores a native chip when a writer supplies an ordinary saved-result link', () => {
    const serialized = serializeNotebookMarkdown({
      identity,
      content: { type: 'doc', content: [linkBlock] },
    });
    const stored = JSON.parse(serialized.payloads[0].content).node;
    expect(stored.content).toMatchObject([expectedChip]);
    expect(serialized.markdown).toContain(`[${label}](${href})`);
    const reopened = parseNotebookMarkdown({
      markdown: serialized.markdown,
      payloads: new Map(serialized.payloads.map((p) => [p.relativePath, p.content])),
    });
    expect(reopened.content.content?.[0].content).toMatchObject([expectedChip]);
  });

  it('upgrades existing plain Markdown references without inventing a new reference', () => {
    const old = `# NGS evidence report\n\n<!-- dnaforge:notebook ${JSON.stringify({ ...identity, codecVersion: 1 })} -->\n\n[${label}](${href})\n`;
    const reopened = parseNotebookMarkdown({ markdown: old });
    expect(reopened.content.content?.[0].content).toMatchObject([expectedChip]);
  });

  it('upgrades an existing exact-node payload after validating the original bytes', () => {
    const fingerprint = contentFingerprint(canonicalNotebookJson(linkBlock));
    const payload = `.forge/blocks/${fingerprint}.json`;
    const visible = `[${label}](${href})\n`;
    const markdown = `# NGS evidence report\n\n<!-- dnaforge:notebook ${JSON.stringify({ ...identity, codecVersion: 1 })} -->\n\n<!-- dnaforge:block ${JSON.stringify({ version: 1, visibleFingerprint: contentFingerprint(visible), payload })} -->\n${visible}<!-- /dnaforge:block -->\n`;
    const reopened = parseNotebookMarkdown({
      markdown,
      payloads: new Map([
        [
          payload,
          JSON.stringify({ schema: 'waypoint.notebook.block.v1', fingerprint, node: linkBlock }),
        ],
      ]),
    });
    expect(reopened.content.content?.[0].content).toMatchObject([expectedChip]);
  });

  it('converts ordinary internal links inserted through the actual editor', () => {
    const editor = new Editor({ extensions: extensions(), content: '<p>Observed result</p>' });
    try {
      editor.commands.insertContentAt(editor.state.doc.content.size, linkBlock);
      expect(editor.getJSON().content?.[1].content?.[0]).toMatchObject(expectedChip);
      expect(editor.getHTML()).not.toContain('<a ');
    } finally {
      editor.destroy();
    }
  });

  it('preserves the exact saved reference through the real clipboard serializer/parser', () => {
    const schema = getSchema(extensions());
    const doc = schema.nodeFromJSON({
      type: 'doc',
      content: [{ type: 'paragraph', content: [expectedChip] }],
    });
    const host = document.createElement('div');
    host.appendChild(DOMSerializer.fromSchema(schema).serializeFragment(doc.content));
    const pasted = DOMParser.fromSchema(schema).parse(host).toJSON();
    expect(pasted.content[0].content[0]).toMatchObject(expectedChip);
  });

  it('keeps the cursor immediately after an inserted reference inside a sentence', () => {
    const editor = new Editor({ extensions: extensions(), content: '<p>Before tail</p>' });
    try {
      editor.commands.insertContentAt(8, linkBlock.content!);
      expect(editor.state.selection.from).toBe(9);
      editor.commands.insertContent('then ');
      expect(editor.getJSON().content?.[0].content).toMatchObject([
        { type: 'text', text: 'Before ' },
        expectedChip,
        { type: 'text', text: 'then tail' },
      ]);
    } finally {
      editor.destroy();
    }
  });

  it('leaves a normal external website link usable', () => {
    const external = {
      ...linkBlock,
      content: [
        {
          type: 'text',
          text: 'Source',
          marks: [{ type: 'link', attrs: { href: 'https://example.org/paper' } }],
        },
      ],
    };
    const serialized = serializeNotebookMarkdown({
      identity,
      content: { type: 'doc', content: [external] },
    });
    expect(JSON.parse(serialized.payloads[0].content).node).toEqual(external);
  });
});

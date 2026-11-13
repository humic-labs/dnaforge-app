import { describe, expect, it } from 'vitest';
import { generateJSON, getSchema } from '@tiptap/core';
import { getBaseExtensions, MentionExtension } from './extensions';
import {
  parseNotebookMarkdown,
  serializeNotebookMarkdown,
} from '../../../db/notebook-markdown-codec';

describe('notebook protocol tables', () => {
  it('preserves pasted rows, columns and a typed reference through save and reopen', () => {
    const extensions = [...getBaseExtensions(), MentionExtension];
    const href = 'dnaforge-chat://reference/e18c3ba4-9448-4589-8309-710c13a0261b';
    const content = generateJSON(
      `<table><thead><tr><th>Primer</th><th>Sequence</th></tr></thead><tbody><tr><td><a href="${href}">R51-P01</a></td><td>ACGTAATTG</td></tr></tbody></table>`,
      extensions
    );
    const table = content.content?.find((node) => node.type === 'table');
    expect(table?.content).toHaveLength(2);
    expect(table?.content?.map((row) => row.content?.length)).toEqual([2, 2]);
    const written = serializeNotebookMarkdown({
      identity: { id: 'protocol-table', title: 'Protocol', formatVersion: 2 },
      content,
    });
    const reopened = parseNotebookMarkdown({
      markdown: written.markdown,
      payloads: new Map(written.payloads.map((payload) => [payload.relativePath, payload.content])),
    }).content;
    const schema = getSchema(extensions);
    const node = schema.nodeFromJSON(reopened);
    expect(node.firstChild?.type.name).toBe('table');
    expect(node.firstChild?.childCount).toBe(2);
    expect(node.textBetween(0, node.content.size, '', (leaf) => leaf.attrs.label ?? '')).toContain(
      'R51-P01'
    );
    expect(JSON.stringify(reopened)).toContain(href);
  });
});

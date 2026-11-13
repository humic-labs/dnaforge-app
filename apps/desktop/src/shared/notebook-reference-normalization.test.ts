import { describe, expect, it } from 'vitest';
import type { JSONContent } from '@tiptap/core';

import { normalizeNotebookReferences } from './notebook-reference-normalization';
import { nativeEntityReferenceHref } from './native-entity-reference';
import { savedReferenceHref, savedReferenceIdFromHref } from './saved-reference-url';

const id = '9c70fcfb-78a4-4fd7-8131-028f1d92cfe5';
const href = savedReferenceHref(id);
const link = (text: string, target = href): JSONContent => ({
  type: 'text',
  text,
  marks: [{ type: 'link', attrs: { href: target } }],
});

describe('canonical notebook references', () => {
  it('joins one reference split across formatting spans and keeps its surrounding sentence', () => {
    const normalized = normalizeNotebookReferences({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'See ' },
        link('derived '),
        { ...link('signal'), marks: [...link('').marks!, { type: 'bold' }] },
        { type: 'text', text: ' for evidence.' },
      ],
    });
    expect(normalized.content).toMatchObject([
      { type: 'text', text: 'See ' },
      { type: 'mention', attrs: { referenceUri: href, label: 'derived signal' } },
      { type: 'text', text: ' for evidence.' },
    ]);
    expect(normalized.content).toHaveLength(3);
    expect(normalizeNotebookReferences(normalized)).toBe(normalized);
  });

  it('retains separate references and normalizes inside list blocks', () => {
    const normalized = normalizeNotebookReferences({
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                link('one'),
                link('two', savedReferenceHref('e8a02a98-2484-4080-9c6b-04ade0763803')),
              ],
            },
          ],
        },
      ],
    });
    expect(normalized.content?.[0].content?.[0].content).toMatchObject([
      { type: 'mention', attrs: { referenceUri: href, label: 'one' } },
      { type: 'mention', attrs: { label: 'two' } },
    ]);
  });

  it('keeps a native workspace entity identity instead of storing an internal anchor', () => {
    const entityId = 'workspace::sequence-1';
    const result = normalizeNotebookReferences({
      type: 'paragraph',
      content: [link('pUC19', nativeEntityReferenceHref(entityId)!)],
    });
    expect(result.content).toMatchObject([
      { type: 'mention', attrs: { entityType: 'native-catalog', entityId, label: 'pUC19' } },
    ]);
  });

  it.each([
    `dnaforge-chat://reference/missing`,
    `${href}?other=1`,
    `entity://workspace/%ZZ`,
    `${href}%0a`,
  ])(
    'preserves invalid internal target %s as an unavailable chip, never a misleading hyperlink',
    (target) => {
      const result = normalizeNotebookReferences({
        type: 'paragraph',
        content: [link('Unavailable result', target)],
      });
      expect(result.content).toMatchObject([
        { type: 'mention', attrs: { referenceUri: target, label: 'Unavailable result' } },
      ]);
      expect(savedReferenceIdFromHref(target)).toBeNull();
    }
  );

  it('does not rewrite code examples, raw Markdown compatibility blocks or external websites', () => {
    const codeBlock = { type: 'codeBlock', content: [link('example')] };
    const raw = { type: 'rawMarkdown', attrs: { source: `[example](${href})` } };
    const inlineCode = {
      type: 'paragraph',
      content: [{ ...link('example'), marks: [...link('').marks!, { type: 'code' }] }],
    };
    const external = { type: 'paragraph', content: [link('paper', 'https://example.org/paper')] };
    for (const content of [codeBlock, raw, inlineCode, external])
      expect(normalizeNotebookReferences(content)).toBe(content);
    expect(() => savedReferenceHref(id + '\n')).toThrow('Invalid saved reference');
  });
});

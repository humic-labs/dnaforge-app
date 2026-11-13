import { describe, expect, it } from 'vitest';
import { parsePlainNotebookMarkdown, parseNotebookMarkdown } from './notebook-markdown-codec';

describe('ordinary Markdown notebook interoperability', () => {
  it('imports the document title, rich text, code and images as editable notebook content', () => {
    const parsed = parsePlainNotebookMarkdown({
      markdown:
        '# Agent report\n\n**Result**\n\n```python\nprint(1)\n```\n\n![Gel](figures/gel.png)\n',
      id: 'report-id',
      title: 'report',
    });
    expect(parsed.id).toBe('report-id');
    expect(parsed.title).toBe('Agent report');
    expect(parsed.content.content).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'Result', marks: [{ type: 'bold' }] }] },
      {
        type: 'codeBlock',
        attrs: { language: 'python' },
        content: [{ type: 'text', text: 'print(1)' }],
      },
      expect.objectContaining({
        type: 'embed',
        attrs: expect.objectContaining({
          type: 'image',
          data: expect.objectContaining({ src: 'figures/gel.png', alt: 'Gel' }),
        }),
      }),
    ]);
  });
  it('retains the identity of a known package after an outside editor replaces its Markdown', () => {
    const parsed = parseNotebookMarkdown({
      markdown: '# Revised report\n\nA fresh external edit.\n',
      expected: { id: 'retained-id', title: 'Old title', formatVersion: 2 },
    });
    expect(parsed.id).toBe('retained-id');
    expect(parsed.title).toBe('Revised report');
    expect(parsed.content.content?.[0]).toMatchObject({ type: 'paragraph' });
  });
  it('keeps unknown source and does not turn ordinary list items into checkboxes', () => {
    const parsed = parsePlainNotebookMarkdown({
      markdown:
        '---\nauthor: external\n---\n\n- plain\n- [x] checked\n\n:::unknown\npreserve me\n:::\n',
      id: 'mixed',
      title: 'Mixed',
    });
    expect(parsed.preservedPreamble).toBe('---\nauthor: external\n---\n');
    expect(parsed.content.content?.some((node) => node.type === 'rawMarkdown')).toBe(true);
    expect(parsed.content.content?.[0].type).not.toBe('taskList');
  });
  it('does not accept a damaged identity marker as ordinary Markdown', () => {
    expect(() =>
      parseNotebookMarkdown({
        markdown: '<!-- dnaforge:notebook {bad} -->\n',
        expected: { id: 'retained-id', title: 'Title', formatVersion: 2 },
      })
    ).toThrow();
  });
  it('accepts an opening horizontal rule as ordinary Markdown', () => {
    const parsed = parsePlainNotebookMarkdown({
      markdown: '---\n\nAn ordinary report.\n',
      id: 'rule',
      title: 'Report',
    });
    expect(parsed.preservedPreamble).toBe('');
    expect(JSON.stringify(parsed.content)).toContain('An ordinary report.');
  });
  it('keeps an example notebook marker inside code as document content', () => {
    const markdown = '# Example\n\n```html\n<!-- dnaforge:notebook {example} -->\n```\n';
    const parsed = parsePlainNotebookMarkdown({ markdown, id: 'code', title: 'Example' });
    expect(parsed.content.content?.[0]).toMatchObject({
      type: 'codeBlock',
      content: [{ type: 'text', text: '<!-- dnaforge:notebook {example} -->' }],
    });
    expect(
      parseNotebookMarkdown({
        markdown,
        expected: { id: 'code', title: 'Example', formatVersion: 2 },
      }).content
    ).toEqual(parsed.content);
  });
});

// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  NotebookMarkdownCodecError,
  parseNotebookMarkdown,
  serializeNotebookMarkdown,
} from './notebook-markdown-codec';
import { isUnknownRecord } from '../shared/notebook-content-extension';

const RICH_DOCUMENT = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      attrs: { indent: 2 },
      content: [
        { type: 'text', text: 'ATP', marks: [{ type: 'bold' }] },
        {
          type: 'text',
          text: '4',
          marks: [{ type: 'subscript' }, { type: 'highlight', attrs: { color: '#BFDBFE' } }],
        },
        {
          type: 'mention',
          attrs: {
            id: 'occurrence-1',
            entityId: 'sequence-1',
            entityType: 'sequence',
            label: 'pUC19',
            path: 'plasmids/pUC19.gb',
            objectUuid: 'object-1',
            contentHash: 'sha256:abc',
          },
        },
      ],
    },
    {
      type: 'embed',
      attrs: {
        type: 'table',
        refId: 'table-1',
        data: {
          rows: 2,
          cols: 2,
          cells: { A1: { value: '=B1+1', format: { textColor: '#D10E0E' } } },
          attachmentPath: 'assets/results.csv',
        },
      },
    },
  ],
};

function payloadMap(
  payloads: Array<{ relativePath: string; content: string }>
): ReadonlyMap<string, string> {
  return new Map(payloads.map((payload) => [payload.relativePath, payload.content]));
}

function tableDocument(version: number | undefined = undefined) {
  return {
    type: 'doc',
    content: [
      {
        type: 'embed',
        attrs: {
          type: 'table',
          refId: 'table-gfm',
          ...(version === undefined ? {} : { version }),
          data: {
            columnLabels: ['Sample', 'Yield'],
            cells: [
              [
                { value: 'A', type: 'text' },
                { value: '=1+1', type: 'formula' },
              ],
            ],
          },
        },
      },
    ],
  };
}

function replaceOnlyVisibleBlock(markdown: string, replacement: string): string {
  const marker = '<!-- dnaforge:block ';
  const start = markdown.indexOf(marker);
  const contentStart = markdown.indexOf('\n', start) + 1;
  const end = markdown.indexOf('<!-- /dnaforge:block -->', contentStart);
  if (start < 0 || contentStart <= 0 || end < 0) throw new Error('Expected one notebook block');
  return `${markdown.slice(0, contentStart)}${replacement}\n${markdown.slice(end)}`;
}

describe('notebook Markdown authority codec', () => {
  it('round-trips exact rich TipTap nodes through canonical Markdown payload references', () => {
    const serialized = serializeNotebookMarkdown({
      identity: { id: 'notebook-1', title: 'Expression run', formatVersion: 2 },
      content: RICH_DOCUMENT,
      roots: { workspaceRoot: '/workspace', packageRoot: '/workspace/Expression run' },
    });

    expect(serialized.markdown).toContain('# Expression run');
    expect(serialized.markdown).toContain('<!-- dnaforge:notebook ');
    expect(serialized.markdown).toContain('<!-- dnaforge:block ');
    expect(serialized.markdown).toContain('[pUC19](<../plasmids/pUC19.gb>)');
    expect(serialized.payloads).toHaveLength(2);
    expect(serialized.payloads[1].content).toContain('assets/results.csv');

    const parsed = parseNotebookMarkdown({
      markdown: serialized.markdown,
      payloads: payloadMap(serialized.payloads),
      expected: { id: 'notebook-1', formatVersion: 2 },
    });
    expect(parsed.content).toEqual(RICH_DOCUMENT);
  });

  it('keeps a link destination in canonical Markdown when the visible paragraph is edited', () => {
    const document = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'See ' },
            {
              type: 'text',
              text: 'source',
              marks: [
                {
                  type: 'link',
                  attrs: {
                    href: 'https://example.com/results?id=7#yield',
                    target: '_blank',
                    rel: 'noopener noreferrer',
                    providerStableId: 'record-7',
                  },
                },
              ],
            },
            { type: 'text', text: ' before' },
          ],
        },
      ],
    };
    const serialized = serializeNotebookMarkdown({
      identity: { id: 'notebook-link', title: 'Linked result', formatVersion: 2 },
      content: document,
    });

    expect(serialized.markdown).toContain(
      'See [source](<https://example.com/results?id=7#yield>) before'
    );
    expect(
      parseNotebookMarkdown({
        markdown: serialized.markdown,
        payloads: payloadMap(serialized.payloads),
      }).content
    ).toEqual(document);

    const edited = serialized.markdown.replace(' before', ' after');
    expect(
      parseNotebookMarkdown({
        markdown: edited,
        payloads: payloadMap(serialized.payloads),
      }).content
    ).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'See ' },
            {
              type: 'text',
              text: 'source',
              marks: [
                {
                  type: 'link',
                  attrs: {
                    href: 'https://example.com/results?id=7#yield',
                    title: null,
                    target: null,
                  },
                },
              ],
            },
            { type: 'text', text: ' after' },
          ],
        },
      ],
    });
  });

  it('stores a versioned extension descriptor and readable GFM for a rich table', () => {
    const serialized = serializeNotebookMarkdown({
      identity: { id: 'notebook-table', title: 'Table', formatVersion: 2 },
      content: tableDocument(),
    });

    expect(serialized.markdown).toContain('| Sample | Yield |');
    expect(serialized.markdown).toContain('| A | =1+1 |');
    expect(serialized.payloads).toHaveLength(1);
    expect(serialized.payloads[0]?.content).toContain(
      '"extension": {\n    "kind": "rich-block",\n    "type": "table",\n    "version": 1\n  }'
    );
    expect(
      parseNotebookMarkdown({
        markdown: serialized.markdown,
        payloads: payloadMap(serialized.payloads),
      }).content
    ).toEqual(tableDocument());
  });

  it('rebuilds a rich table when an external edit changes its visible GFM', () => {
    const serialized = serializeNotebookMarkdown({
      identity: { id: 'notebook-table-edit', title: 'Table edit', formatVersion: 2 },
      content: tableDocument(),
    });
    const edited = replaceOnlyVisibleBlock(
      serialized.markdown,
      [
        '| Construct | Colonies |',
        '| --- | ---: |',
        '| pUC19 | 12 |',
        '| pBR322 | =6+7 |',
        '| Notes | line<br>two |',
      ].join('\n')
    );

    expect(
      parseNotebookMarkdown({ markdown: edited, payloads: payloadMap(serialized.payloads) }).content
    ).toEqual({
      type: 'doc',
      content: [
        {
          type: 'embed',
          attrs: {
            type: 'table',
            version: 1,
            refId: expect.stringMatching(/^markdown-table-[a-f0-9]{16}$/),
            data: {
              rows: 3,
              cols: 2,
              columnLabels: ['Construct', 'Colonies'],
              cells: [
                [
                  { value: 'pUC19', type: 'text' },
                  { value: '12', type: 'text', format: { align: 'right' } },
                ],
                [
                  { value: 'pBR322', type: 'text' },
                  { value: '=6+7', type: 'formula', format: { align: 'right' } },
                ],
                [
                  { value: 'Notes', type: 'text' },
                  { value: 'line\ntwo', type: 'text', format: { align: 'right' } },
                ],
              ],
            },
          },
        },
      ],
    });
  });

  it('continues to read v1 payload records that predate extension descriptors', () => {
    const serialized = serializeNotebookMarkdown({
      identity: { id: 'notebook-legacy-payload', title: 'Legacy payload', formatVersion: 2 },
      content: tableDocument(),
    });
    const legacyPayloads = serialized.payloads.map((payload) => {
      const parsed: unknown = JSON.parse(payload.content);
      if (!isUnknownRecord(parsed)) throw new Error('Expected a payload object');
      const { extension: _extension, ...legacy } = parsed;
      return { ...payload, content: `${JSON.stringify(legacy, null, 2)}\n` };
    });

    expect(
      parseNotebookMarkdown({
        markdown: serialized.markdown,
        payloads: payloadMap(legacyPayloads),
      }).content
    ).toEqual(tableDocument());
  });

  it('fails closed when a payload descriptor disagrees with its exact node', () => {
    const serialized = serializeNotebookMarkdown({
      identity: { id: 'notebook-mismatch', title: 'Mismatch', formatVersion: 2 },
      content: tableDocument(),
    });
    const mismatched = serialized.payloads.map((payload) => {
      const parsed: unknown = JSON.parse(payload.content);
      if (!isUnknownRecord(parsed) || !isUnknownRecord(parsed.extension)) {
        throw new Error('Expected a versioned extension descriptor');
      }
      return {
        ...payload,
        content: `${JSON.stringify(
          { ...parsed, extension: { ...parsed.extension, type: 'diagram' } },
          null,
          2
        )}\n`,
      };
    });

    expect(() =>
      parseNotebookMarkdown({
        markdown: serialized.markdown,
        payloads: payloadMap(mismatched),
      })
    ).toThrowError(expect.objectContaining({ code: 'NOTEBOOK_BLOCK_PAYLOAD_INVALID' }));
  });

  it('fails closed on invalid data for a supported rich-block version', () => {
    expect(() =>
      serializeNotebookMarkdown({
        identity: { id: 'notebook-invalid-table', title: 'Invalid table', formatVersion: 2 },
        content: {
          type: 'doc',
          content: [
            {
              type: 'embed',
              attrs: {
                type: 'table',
                refId: 'invalid-table',
                version: 1,
                data: { cells: [[{ value: 'A1', type: 'invalid-cell-type' }]] },
              },
            },
          ],
        },
      })
    ).toThrowError(expect.objectContaining({ code: 'NOTEBOOK_BLOCK_PAYLOAD_INVALID' }));
  });

  it.each([
    { type: 'future-diagram', version: 4, expected: 'future-diagram block (version 4)' },
    { type: 'table', version: 2, expected: 'table block (version 2; this app supports 1)' },
  ])(
    'preserves $type version $version as an opaque readable block',
    ({ type, version, expected }) => {
      const content = {
        type: 'doc',
        content: [
          {
            type: 'embed',
            attrs: { type, refId: `${type}-1`, version, data: { futureShape: true } },
          },
        ],
      };
      const serialized = serializeNotebookMarkdown({
        identity: { id: `notebook-${type}`, title: type, formatVersion: 2 },
        content,
      });

      expect(serialized.markdown).toContain(expected);
      expect(
        parseNotebookMarkdown({
          markdown: serialized.markdown,
          payloads: payloadMap(serialized.payloads),
        }).content
      ).toEqual(content);
    }
  );

  it('preserves unknown frontmatter and unsupported Markdown byte-for-byte', () => {
    const preamble = '---\nowner: outside-tool\ncustom:\n  keep: exactly\n---\n';
    const unknown = ':::future-directive{alpha="beta"}\ninside\n:::\n';
    const first = serializeNotebookMarkdown({
      identity: { id: 'notebook-raw', title: 'Raw', formatVersion: 2 },
      preservedPreamble: preamble,
      content: { type: 'doc', content: [{ type: 'rawMarkdown', attrs: { source: unknown } }] },
    });

    const parsed = parseNotebookMarkdown({ markdown: first.markdown });
    expect(parsed.preservedPreamble).toBe(preamble);
    expect(parsed.content.content).toContainEqual({
      type: 'rawMarkdown',
      attrs: { source: unknown },
    });

    const second = serializeNotebookMarkdown({
      identity: { id: parsed.id, title: parsed.title, formatVersion: parsed.formatVersion },
      preservedPreamble: parsed.preservedPreamble,
      content: parsed.content,
    });
    expect(second.markdown).toContain(preamble);
    expect(second.markdown).toContain(unknown);
  });

  it('preserves opaque Markdown bytes without normalizing blank runs, CRLF, Unicode, or marker-looking text', () => {
    const opaque =
      'alpha\n\n\n\n\nβeta\r\n\r\n\r\n\r\n\r\n<!-- dnaforge:block inert-looking-text -->\r\nomega';
    const first = serializeNotebookMarkdown({
      identity: { id: 'notebook-opaque', title: 'Opaque', formatVersion: 2 },
      content: { type: 'doc', content: [{ type: 'rawMarkdown', attrs: { source: opaque } }] },
    });

    const parsed = parseNotebookMarkdown({ markdown: first.markdown });
    expect(parsed.content.content).toContainEqual({
      type: 'rawMarkdown',
      attrs: { source: opaque },
    });

    const second = serializeNotebookMarkdown({
      identity: { id: parsed.id, title: parsed.title, formatVersion: parsed.formatVersion },
      preservedPreamble: parsed.preservedPreamble,
      preservedTitleProjection: parsed.preservedTitleProjection,
      content: parsed.content,
    });
    expect(second.markdown).toContain(opaque);
    expect(parseNotebookMarkdown({ markdown: second.markdown }).content).toEqual(parsed.content);
  });

  it('preserves external bytes inserted before the identity marker', () => {
    const first = serializeNotebookMarkdown({
      identity: { id: 'notebook-header-extension', title: 'Header extension', formatVersion: 2 },
      content: { type: 'doc', content: [] },
    });
    const extension =
      '<!-- outside-tool: keep -->\r\n:::future-header{mode="exact"}\r\ninside\r\n:::\r\n';
    const edited = first.markdown.replace(
      '<!-- dnaforge:notebook ',
      `${extension}<!-- dnaforge:notebook `
    );

    const parsed = parseNotebookMarkdown({ markdown: edited });
    const second = serializeNotebookMarkdown({
      identity: { id: parsed.id, title: parsed.title, formatVersion: parsed.formatVersion },
      preservedPreamble: parsed.preservedPreamble,
      preservedTitleProjection: parsed.preservedTitleProjection,
      content: parsed.content,
    });

    expect(second.markdown).toContain(extension);
    expect(
      parseNotebookMarkdown({
        markdown: second.markdown,
        payloads: payloadMap(second.payloads),
      }).preservedTitleProjection
    ).toEqual(parsed.preservedTitleProjection);
  });

  it('parks fenced-code language and metadata as opaque Markdown instead of dropping it', () => {
    const first = serializeNotebookMarkdown({
      identity: { id: 'notebook-code', title: 'Code', formatVersion: 2 },
      content: { type: 'doc', content: [] },
    });
    const fenced = '```python linenos=true\nprint("β")\n```';
    const markerStart = first.markdown.indexOf('<!-- dnaforge:notebook ');
    const markerEnd = first.markdown.indexOf('\n', markerStart);
    const edited = `${first.markdown.slice(0, markerEnd + 1)}\n${fenced}\n${first.markdown.slice(markerEnd + 1)}`;

    const parsed = parseNotebookMarkdown({ markdown: edited });
    expect(parsed.content.content).toContainEqual({
      type: 'rawMarkdown',
      attrs: { source: fenced },
    });

    const second = serializeNotebookMarkdown({
      identity: { id: parsed.id, title: parsed.title, formatVersion: parsed.formatVersion },
      preservedPreamble: parsed.preservedPreamble,
      preservedTitleProjection: parsed.preservedTitleProjection,
      content: parsed.content,
    });
    expect(second.markdown).toContain(fenced);
  });

  it('uses externally edited visible Markdown instead of a stale exact-node payload', () => {
    const first = serializeNotebookMarkdown({
      identity: { id: 'notebook-1', title: 'Edit me', formatVersion: 2 },
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'before' }] }],
      },
    });
    const edited = first.markdown.replace('before', '**after**');

    const parsed = parseNotebookMarkdown({
      markdown: edited,
      payloads: payloadMap(first.payloads),
    });
    expect(parsed.content).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'after', marks: [{ type: 'bold' }] }],
        },
      ],
    });
  });

  it.each([
    ['malformed JSON', () => '{'],
    ['non-object JSON', () => '[]'],
    [
      'wrong payload schema',
      (payload: string) => {
        const parsed: unknown = JSON.parse(payload);
        if (!isUnknownRecord(parsed)) throw new Error('Expected payload record');
        return `${JSON.stringify({ ...parsed, schema: 'waypoint.notebook.block.v99' })}\n`;
      },
    ],
    [
      'node fingerprint mismatch',
      (payload: string) => {
        const parsed: unknown = JSON.parse(payload);
        if (!isUnknownRecord(parsed)) throw new Error('Expected payload record');
        return `${JSON.stringify({
          ...parsed,
          node: { type: 'paragraph', content: [{ type: 'text', text: 'tampered' }] },
        })}\n`;
      },
    ],
  ])('fails closed on unchanged generated Markdown with %s', (_label, corrupt) => {
    const serialized = serializeNotebookMarkdown({
      identity: { id: 'notebook-corrupt', title: 'Corrupt', formatVersion: 2 },
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'before' }] }],
      },
    });
    const payload = serialized.payloads[0];
    if (!payload) throw new Error('Expected exact-node payload');

    expect(() =>
      parseNotebookMarkdown({
        markdown: serialized.markdown,
        payloads: new Map([[payload.relativePath, corrupt(payload.content)]]),
      })
    ).toThrowError(
      expect.objectContaining<Partial<NotebookMarkdownCodecError>>({
        code: 'NOTEBOOK_BLOCK_PAYLOAD_INVALID',
      })
    );
  });

  it.each([
    ['missing payload', 'missing'],
    ['malformed stale payload', 'malformed'],
  ] as const)('uses externally edited visible Markdown with a %s', (_label, payloadState) => {
    const serialized = serializeNotebookMarkdown({
      identity: { id: 'notebook-visible-wins', title: 'Visible wins', formatVersion: 2 },
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'before' }] }],
      },
    });
    const edited = serialized.markdown.replace('before', '**after**');
    const payload = serialized.payloads[0];
    if (!payload) throw new Error('Expected exact-node payload');
    const payloads =
      payloadState === 'missing'
        ? new Map<string, string>()
        : new Map([[payload.relativePath, '{']]);

    expect(parseNotebookMarkdown({ markdown: edited, payloads }).content).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'after', marks: [{ type: 'bold' }] }],
        },
      ],
    });
  });

  it('fails closed when an unchanged generated block has no exact payload', () => {
    const serialized = serializeNotebookMarkdown({
      identity: { id: 'notebook-1', title: 'Missing', formatVersion: 2 },
      content: RICH_DOCUMENT,
    });
    expect(() => parseNotebookMarkdown({ markdown: serialized.markdown })).toThrowError(
      expect.objectContaining<Partial<NotebookMarkdownCodecError>>({
        code: 'NOTEBOOK_BLOCK_PAYLOAD_INVALID',
      })
    );
  });

  it('fails closed on a future Markdown codec version', () => {
    const serialized = serializeNotebookMarkdown({
      identity: { id: 'notebook-1', title: 'Future', formatVersion: 2 },
      content: { type: 'doc', content: [] },
    });
    const future = serialized.markdown.replace('"codecVersion":1', '"codecVersion":99');
    expect(() => parseNotebookMarkdown({ markdown: future })).toThrowError(
      expect.objectContaining<Partial<NotebookMarkdownCodecError>>({
        code: 'NOTEBOOK_MARKDOWN_NEWER_CODEC',
      })
    );
  });
});

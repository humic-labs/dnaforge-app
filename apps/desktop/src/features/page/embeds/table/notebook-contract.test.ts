// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { notebookContentExtensions } from '../../../../db/notebook-content-extensions';
import { TABLE_NOTEBOOK_BLOCK } from './notebook-contract';

describe('table notebook content contract', () => {
  it('round-trips legacy saved-formula payloads without losing source evidence', () => {
    const data = {
      cells: [
        [
          {
            value: '42',
            type: 'text',
            sourceFormula: '=BENCHLING(A1)',
            sourceRenderedValue: '42',
            formulaCompatibility: 'unsupported',
            stale: true,
          },
        ],
      ],
    };
    const persisted = JSON.parse(JSON.stringify(data));
    expect(TABLE_NOTEBOOK_BLOCK.parseData(persisted)).toEqual({ ok: true, data });
    expect(TABLE_NOTEBOOK_BLOCK.toMarkdown({ refId: 'saved-result', data })).toContain('| 42 |');
    expect(
      TABLE_NOTEBOOK_BLOCK.parseData({ cells: [[{ ...data.cells[0][0], stale: 'yes' }]] })
    ).toMatchObject({ ok: false });
  });
  it('writes a readable GFM table while escaping cell syntax', () => {
    expect(
      TABLE_NOTEBOOK_BLOCK.toMarkdown({
        refId: 'table-1',
        data: {
          columnLabels: ['Sample', 'Yield'],
          cells: [
            [
              { value: 'A | B', type: 'text' },
              { value: '=SUM(B2:B3)', type: 'formula' },
            ],
            [
              { value: 'line\ntwo', type: 'text' },
              { value: '42', type: 'number' },
            ],
          ],
        },
      })
    ).toBe(
      [
        '| Sample | Yield |',
        '| --- | --- |',
        '| A \\| B | =SUM(B2:B3) |',
        '| line<br>two | 42 |',
      ].join('\n')
    );
  });

  it('uses spreadsheet letters when a table has no user labels', () => {
    expect(
      TABLE_NOTEBOOK_BLOCK.toMarkdown({
        refId: 'table-letters',
        data: {
          cells: [
            [
              { value: 'one', type: 'text' },
              { value: 'two', type: 'text' },
            ],
          ],
        },
      })
    ).toContain('| A | B |');
  });

  it('distinguishes literal HTML-looking text from projected line breaks', () => {
    expect(
      TABLE_NOTEBOOK_BLOCK.toMarkdown({
        refId: 'table-html-text',
        data: {
          cells: [
            [
              { value: 'literal <br> & text', type: 'text' },
              { value: 'line\ntwo', type: 'text' },
            ],
          ],
        },
      })
    ).toContain('| literal &lt;br&gt; &amp; text | line<br>two |');
  });

  it('rebuilds a rectangular rich table from a GFM table AST', () => {
    const parsed = TABLE_NOTEBOOK_BLOCK.fromMarkdown?.({
      refId: 'markdown-table-1234',
      node: {
        type: 'table',
        align: [null, 'right'],
        children: [
          {
            type: 'tableRow',
            children: [
              { type: 'tableCell', children: [{ type: 'text', value: 'Sample' }] },
              { type: 'tableCell', children: [{ type: 'text', value: 'Yield' }] },
            ],
          },
          {
            type: 'tableRow',
            children: [
              { type: 'tableCell', children: [{ type: 'text', value: 'A' }] },
              { type: 'tableCell', children: [{ type: 'text', value: '=1+1' }] },
            ],
          },
          {
            type: 'tableRow',
            children: [{ type: 'tableCell', children: [{ type: 'text', value: 'B' }] }],
          },
        ],
      },
    });

    expect(parsed).toEqual({
      refId: 'markdown-table-1234',
      data: {
        rows: 2,
        cols: 2,
        columnLabels: ['Sample', 'Yield'],
        cells: [
          [
            { value: 'A', type: 'text' },
            { value: '=1+1', type: 'formula', format: { align: 'right' } },
          ],
          [
            { value: 'B', type: 'text' },
            { value: '', type: 'text', format: { align: 'right' } },
          ],
        ],
      },
    });
  });

  it('restores Markdown line breaks inside table cells', () => {
    const parsed = TABLE_NOTEBOOK_BLOCK.fromMarkdown?.({
      refId: 'markdown-table-line-break',
      node: {
        type: 'table',
        children: [
          {
            type: 'tableRow',
            children: [{ type: 'tableCell', children: [{ type: 'text', value: 'Notes' }] }],
          },
          {
            type: 'tableRow',
            children: [
              {
                type: 'tableCell',
                children: [
                  { type: 'text', value: 'line' },
                  { type: 'html', value: '<br />' },
                  { type: 'text', value: 'two' },
                ],
              },
            ],
          },
        ],
      },
    });

    expect(parsed?.data.cells).toEqual([[{ value: 'line\ntwo', type: 'text' }]]);
  });

  it('validates data at the extension boundary', () => {
    expect(TABLE_NOTEBOOK_BLOCK.parseData('not-an-object')).toEqual({
      ok: false,
      reason: 'table data must be an object',
    });
    expect(TABLE_NOTEBOOK_BLOCK.parseData({ cells: 'not-a-grid' })).toEqual({
      ok: false,
      reason: 'table cells must be a rectangular array of valid cells',
    });
    expect(
      TABLE_NOTEBOOK_BLOCK.parseData({
        cells: [[{ value: 'A1', type: 'unsupported' }]],
      })
    ).toEqual({
      ok: false,
      reason: 'table cells must be a rectangular array of valid cells',
    });
    expect(TABLE_NOTEBOOK_BLOCK.parseData({ columnLabels: ['Sample', 42] })).toEqual({
      ok: false,
      reason: 'table columnLabels must contain only strings',
    });
    expect(TABLE_NOTEBOOK_BLOCK.parseData({ cells: [] })).toEqual({
      ok: true,
      data: { cells: [] },
    });
    expect(TABLE_NOTEBOOK_BLOCK.parseData({ rows: 2, cols: 3, cells: {} })).toEqual({
      ok: true,
      data: { rows: 2, cols: 3, cells: {} },
    });
  });

  it('is present in the React-free built-in registry', () => {
    expect(notebookContentExtensions.richBlock('table')).toBe(TABLE_NOTEBOOK_BLOCK);
  });
});

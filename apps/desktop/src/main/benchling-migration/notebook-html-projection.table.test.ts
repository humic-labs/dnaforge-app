import type { SourceObject } from '../../shared/benchling-migration';

import { buildNotebookHtmlProjection } from './notebook-html-projection';

function notebookSource(html: string): SourceObject {
  return {
    id: 'source-entry',
    stableId: 'etr_TableEntry',
    sourceType: 'notebook_entry',
    name: 'Table entry',
    aliases: [],
    sourceUrl: 'https://benchling.com/exampleuser/etr_TableEntry',
    attachmentHashes: [],
    memberships: [],
    metadata: {},
    content: { html },
    relationships: [],
  };
}

describe('Benchling notebook table projection', () => {
  it('keeps cell placements aligned after removing an axis-only row', () => {
    const projection = buildNotebookHtmlProjection(
      notebookSource(`
        <html><body>
          <table data-test-component="TableEditable" data-test-element="table">
            <tr>
              <th data-test-element="columnheader">A</th>
              <th data-test-element="columnheader">B</th>
              <th data-test-element="columnheader">C</th>
            </tr>
            <tr><th data-test-element="rowheader">unused axis row</th></tr>
            <tr>
              <th data-test-element="rowheader">1</th>
              <td rowspan="2" colspan="2">anchor</td>
              <td data-formula="=1+1">2</td>
            </tr>
            <tr>
              <th data-test-element="rowheader">2</th>
              <td>tail</td>
            </tr>
          </table>
        </body></html>
      `),
      {
        capturedAt: '2026-08-14T00:00:00.000Z',
        converterVersion: 'test',
        attachments: [],
        supportedFormulaNames: [],
      }
    );

    const document = projection.document.content as {
      content?: Array<{ type?: string; attrs?: { data?: Record<string, unknown> } }>;
    };
    const table = document.content?.find(
      (node) => node.type === 'embed' && node.attrs?.data?.source === 'benchling-notebook-html'
    );
    const data = table?.attrs?.data as
      | { rows?: number; cols?: number; cells?: Array<Array<Record<string, unknown>>> }
      | undefined;

    expect(data).toMatchObject({ rows: 2, cols: 3 });
    expect(data?.cells?.[0]).toMatchObject([
      { type: 'text', value: 'anchor', span: { rows: 2, cols: 2 } },
      { type: 'text', value: '', covered: true },
      {
        type: 'formula',
        value: '=1+1',
        computed: 2,
        formulaCompatibility: 'supported',
        sourceRenderedValue: '2',
      },
    ]);
    expect(data?.cells?.[1]).toMatchObject([
      { type: 'text', value: '', covered: true },
      { type: 'text', value: '', covered: true },
      { type: 'text', value: 'tail' },
    ]);
    expect(projection.formulas).toEqual([expect.objectContaining({ cell: 'C1', formula: '=1+1' })]);
  });

  it('does not turn fully transparent inline colors into invisible text marks', () => {
    const projection = buildNotebookHtmlProjection(
      notebookSource(`
        <html><body>
          <p>
            <span style="color: transparent; background-color: rgba(1, 2, 3, 0)">Visible</span>
            <span style="color: #ff0000">Red annotation</span>
          </p>
        </body></html>
      `),
      {
        capturedAt: '2026-08-14T00:00:00.000Z',
        converterVersion: 'test',
        attachments: [],
        supportedFormulaNames: [],
      }
    );

    const serialized = JSON.stringify(projection.document.content);
    expect(serialized).toContain('Visible');
    expect(serialized).not.toContain('transparent');
    expect(serialized).not.toContain('rgba(1, 2, 3, 0)');
    expect(serialized).toContain('"color":"#ff0000"');
  });
});

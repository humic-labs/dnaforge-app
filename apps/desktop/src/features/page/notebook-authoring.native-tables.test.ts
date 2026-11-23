import { describe, expect, it } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import { parseNotebookMarkdown, serializeNotebookMarkdown } from '../../db/notebook-markdown-codec';
import { TABLE_NOTEBOOK_BLOCK } from '../../shared/table-notebook-contract';
import { NotebookDocumentModel } from '../../shared/notebook-model/document';
import { compileNotebookBlocks } from './notebook-authoring-content';

const firstReference = 'e18c3ba4-9448-4589-8309-710c13a0261b';
const secondReference = 'e28c3ba4-9448-4589-8309-710c13a0261b';
const blocks = [
  {
    type: 'table' as const,
    header: true,
    rows: [
      [[{ text: 'Primer' }], [{ text: 'Exact bases' }]],
      [
        [
          { text: 'first', referenceId: firstReference, bold: true },
          { text: ' and ', italic: true },
          { text: 'second', referenceId: secondReference },
        ],
        [{ text: 'CAGCTTTTGTTCCCTTTAGTGAGGGTTAATTG' }],
      ],
    ],
  },
];

function nativeTable(content: JSONContent) {
  const table = content.content?.[0];
  expect(table?.type).toBe('embed');
  expect(table?.attrs?.type).toBe('table');
  expect(TABLE_NOTEBOOK_BLOCK.parseData(table!.attrs!.data).ok).toBe(true);
  return table!;
}

describe('authored native notebook tables', () => {
  it('bulk-creates the editable native block while retaining all rich runs and saved targets', () => {
    const table = nativeTable(compileNotebookBlocks(blocks));
    const data = table.attrs!.data;
    expect(data.rows).toBe(2);
    expect(data.cols).toBe(2);
    expect(data.cells[0][0].format.bold).toBe(true);
    expect(data.cells[1][0].value).toBe('first and second');
    expect(data.cells[1][1].value).toBe('CAGCTTTTGTTCCCTTTAGTGAGGGTTAATTG');
    expect(data.cells[1][0].content).toEqual([
      {
        type: 'mention',
        attrs: {
          entityType: 'reference',
          referenceUri: `dnaforge-chat://reference/${firstReference}`,
          label: 'first',
        },
        marks: [{ type: 'bold' }],
      },
      { type: 'text', text: ' and ', marks: [{ type: 'italic' }] },
      {
        type: 'mention',
        attrs: {
          entityType: 'reference',
          referenceUri: `dnaforge-chat://reference/${secondReference}`,
          label: 'second',
        },
      },
    ]);
  });

  it('retains stable identities on identical compilation and distinct identities for separate blocks', () => {
    const first = compileNotebookBlocks([...blocks, ...blocks]);
    const retry = compileNotebookBlocks([...blocks, ...blocks]);
    expect(retry).toEqual(first);
    expect(first.content?.[0].attrs?.refId).toBeTruthy();
    expect(first.content?.[1].attrs?.refId).not.toBe(first.content?.[0].attrs?.refId);
  });

  it('retains saved links and inline formatting in the readable Markdown projection', () => {
    const table = nativeTable(compileNotebookBlocks(blocks));
    const markdown = TABLE_NOTEBOOK_BLOCK.toMarkdown({
      refId: table.attrs!.refId,
      data: table.attrs!.data,
    });
    expect(markdown).toContain(`**[first](<dnaforge-chat://reference/${firstReference}>)**`);
    expect(markdown).toContain(`*and*`);
    expect(markdown).toContain(`[second](<dnaforge-chat://reference/${secondReference}>)`);
  });

  it('preserves existing bulk authoring bounds rather than applying blank-table initial limits', () => {
    const rows = Array.from({ length: 500 }, (_, row) =>
      Array.from({ length: 40 }, (_, column) => [{ text: `${row}:${column}` }])
    );
    const table = nativeTable(compileNotebookBlocks([{ type: 'table', header: false, rows }]));
    expect(table.attrs!.data.rows).toBe(500);
    expect(table.attrs!.data.cols).toBe(40);
    expect(table.attrs!.data.cells[499][39].value).toBe('499:39');
  });

  it('round-trips rich cells through native payloads and clears only the cell a person replaces', () => {
    const content = compileNotebookBlocks(blocks);
    const table = nativeTable(content);
    const serialized = serializeNotebookMarkdown({
      identity: { id: 'native-authored-table', title: 'Primer plan', formatVersion: 2 },
      content,
    });
    const reopened = parseNotebookMarkdown({
      markdown: serialized.markdown,
      payloads: new Map(
        serialized.payloads.map((payload) => [payload.relativePath, payload.content])
      ),
      expected: { id: 'native-authored-table', title: 'Primer plan', formatVersion: 2 },
    });
    expect(reopened.content.content?.[0].attrs?.data).toEqual(table.attrs!.data);
    const model = new NotebookDocumentModel(reopened.content, 'Primer plan');
    model.execute({
      kind: 'table',
      tableId: table.attrs!.refId,
      command: { kind: 'set-cell', row: 1, column: 1, value: 'Edited bases' },
    });
    expect(model.content.content?.[0].attrs?.data.cells[1][0]).toEqual(
      table.attrs!.data.cells[1][0]
    );
    model.execute({
      kind: 'table',
      tableId: table.attrs!.refId,
      command: { kind: 'set-cell', row: 1, column: 0, value: 'Plain replacement' },
    });
    const replacement = model.content.content?.[0].attrs?.data.cells[1][0];
    expect(replacement.value).toBe('Plain replacement');
    expect(replacement.content).toBeUndefined();
    model.execute({ kind: 'undo' });
    expect(model.content.content?.[0].attrs?.data.cells[1][0]).toEqual(
      table.attrs!.data.cells[1][0]
    );
  });
});

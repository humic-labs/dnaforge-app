// @vitest-environment node

import { describe, expect, it } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import { TABLE_NOTEBOOK_BLOCK } from '../../table-notebook-contract';
import type { TableData } from '../../table-document-types';
import { createTableDataMemory, tableDataModel } from './table-data-model';
import { NotebookDocumentModel } from '../document';

function legacyData(): TableData {
  return {
    id: 'retained-legacy-table',
    rows: 3,
    cols: 3,
    name: 'Legacy samples',
    cells: {
      A1: {
        value: 'sample-unchanged',
        format: { bold: true, bgColor: '#abcdef' },
        reference: { kind: 'native-entity', entityId: 'sample-42' },
        retainedExtension: { schema: 9, exact: ['opaque', 42] },
      },
      B2: { value: '=2+3', type: 'formula', computed: 5 },
      C3: { value: 'tail-unchanged', type: 'text', span: { rows: 1, cols: 1 } },
    } as unknown as TableData['cells'],
    retainedTableExtension: { exact: 'do not replace' },
  };
}

function notebook(data: TableData, extra: JSONContent[] = []): JSONContent {
  return {
    type: 'doc',
    content: [
      { type: 'embed', attrs: { type: 'table', version: 1, refId: 'legacy-block', data } },
      ...extra,
    ],
  };
}

describe('legacy sparse table migration', () => {
  it('reads every accepted legacy cell without rewriting the source', () => {
    const data = legacyData();
    const before = structuredClone(data);
    expect(TABLE_NOTEBOOK_BLOCK.parseData(data).ok).toBe(true);
    const model = tableDataModel({ data, memory: createTableDataMemory(data), changed() {} });
    expect(model.cells[0][0]).toMatchObject({ value: 'sample-unchanged', type: 'text' });
    expect(model.cells[1][1]).toMatchObject({ value: '=2+3', type: 'formula', computed: 5 });
    expect(model.cells[2][2].value).toBe('tail-unchanged');
    expect(data).toEqual(before);
  });

  it('preserves untouched cells and opaque metadata through a first native edit and undo', () => {
    const data = legacyData();
    const original = notebook(data);
    const model = new NotebookDocumentModel(original, 'Legacy migration');
    const before = structuredClone(model.content);
    model.execute({
      kind: 'table',
      tableId: 'legacy-block',
      command: { kind: 'set-cell', row: 0, column: 1, value: 'new-neighbor' },
    });
    const updated = model.content.content![0].attrs!.data as TableData;
    const source = data.cells as unknown as Record<string, unknown>;
    expect(updated.cells![0][0]).toMatchObject(source.A1 as object);
    expect(updated.cells![1][1]).toEqual(source.B2);
    expect(updated.cells![2][2]).toEqual(source.C3);
    expect(updated.cells![0][1].value).toBe('new-neighbor');
    expect(updated.retainedTableExtension).toEqual(data.retainedTableExtension);
    model.execute({ kind: 'undo' });
    expect(model.content).toEqual(before);
    expect(original).toEqual(notebook(data));
  });

  it('includes populated coordinates beyond missing legacy dimensions', () => {
    const data = { cells: { Z28: { value: 'outside-default-grid' } } } as unknown as TableData;
    expect(TABLE_NOTEBOOK_BLOCK.parseData(data).ok).toBe(true);
    const model = tableDataModel({ data, memory: createTableDataMemory(data), changed() {} });
    expect(model.cells[27][25]).toMatchObject({ value: 'outside-default-grid', type: 'text' });
    expect(data).toEqual({ cells: { Z28: { value: 'outside-default-grid' } } });
  });

  it('refuses ambiguous legacy identities before changing either table', () => {
    const data = legacyData();
    const duplicate = {
      type: 'embed',
      attrs: { type: 'table', version: 1, refId: 'duplicate-block', data },
    };
    const model = new NotebookDocumentModel(notebook(data, [duplicate]), 'Ambiguous legacy');
    const before = structuredClone(model.content);
    expect(() =>
      model.execute({
        kind: 'table',
        tableId: data.id!,
        command: { kind: 'set-cell', row: 0, column: 0, value: 'wrong' },
      })
    ).toThrow(/unique/);
    expect(model.content).toEqual(before);
  });
});

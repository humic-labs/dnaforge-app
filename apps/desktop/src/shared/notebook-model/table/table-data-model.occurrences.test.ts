import { describe, expect, it } from 'vitest';
import type { TableData, Cell, SelectionRange } from '../../table-document-types';
import { createTableDataMemory, tableDataModel } from './table-data-model';

const id = '10000000-0000-4000-8000-000000000001';
const range: SelectionRange = { startRow: 0, startCol: 0, endRow: 0, endCol: 0 };
const linked: Cell = {
  value: 'Target',
  type: 'text',
  reference: { kind: 'native-entity', entityId: 'repo::target', occurrenceId: id },
};
function fixture(cell: Cell = linked) {
  let data: TableData = { cells: [[structuredClone(cell), { value: '', type: 'text' }]] };
  const memory = createTableDataMemory(data);
  return {
    get data() {
      return data;
    },
    model: () =>
      tableDataModel({
        data,
        memory,
        changed: () => {},
        onUpdateAttrs: (attrs) => {
          data = { ...data, ...attrs };
        },
      }),
  };
}
describe('table clipboard occurrence ownership', () => {
  it('renews copied link identity even when its original cell is deleted before paste', () => {
    const f = fixture();
    const copied = f.model().copyCells(range);
    f.model().deleteRange(range);
    f.model().pasteCells(0, 1, copied);
    const reference = f.data.cells![0][1].reference;
    expect(reference).toMatchObject({ kind: 'native-entity', entityId: 'repo::target' });
    expect(reference).toHaveProperty('occurrenceId');
    expect((reference as typeof linked.reference & { occurrenceId: string }).occurrenceId).not.toBe(
      id
    );
    expect(copied[0][0].reference).toEqual(linked.reference);
  });
  it('preserves the exact occurrence during a proven cut move', () => {
    const f = fixture();
    const cut = f.model().cutCells(range);
    f.model().pasteCells(0, 1, cut, true, range);
    expect(f.data.cells![0][0].reference).toBeUndefined();
    expect(f.data.cells![0][1].reference).toEqual(linked.reference);
  });
  it('renews saved references in copied rich cell content and keeps external links intact', () => {
    const f = fixture({
      value: 'Saved range',
      type: 'text',
      reference: { kind: 'external-url', href: 'https://example.com' },
      content: [
        {
          type: 'mention',
          attrs: {
            entityType: 'reference',
            label: 'Saved range',
            referenceUri: 'dnaforge-chat://reference/30000000-0000-4000-8000-000000000001',
            occurrenceId: id,
          },
        },
      ],
    });
    const copied = f.model().copyCells(range);
    f.model().pasteCells(0, 1, copied);
    expect(f.data.cells![0][1].content![0].attrs?.occurrenceId).not.toBe(id);
    expect(f.data.cells![0][1].reference).toEqual({
      kind: 'external-url',
      href: 'https://example.com',
    });
    expect(f.data.cells![0][0].content![0].attrs?.occurrenceId).toBe(id);
  });
});

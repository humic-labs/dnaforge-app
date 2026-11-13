import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TableRenderer } from './Renderer';
import { useTableStore } from './store/tableStore';
import type { TableData } from './types';

vi.mock('../../store', async () => {
  const { create } = await import('zustand');
  return { usePageStore: create(() => ({ dirtyIds: new Set<string>() })) };
});
vi.mock('../../../canvas/public/store', async () => {
  const { create } = await import('zustand');
  return { useCanvasStore: create(() => ({ panels: {}, openWithSmartPlacement: vi.fn() })) };
});

beforeEach(() => {
  useTableStore.setState({ expandedTables: {} });
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('PointerEvent', MouseEvent);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () =>
      ({
        font: '',
        measureText: (text: string) => ({ width: text.length * 8 }),
      }) as CanvasRenderingContext2D
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('editable notebook table width controls', () => {
  it.each([
    ['spreadsheet', false, []],
    ['document', false, []],
    ['document', true, []],
    ['document', false, ['Sample', 'Count']],
  ] as const)(
    'resizes and fits a %s table when selected=%s and labels=%j',
    (presentation, selected, labels) => {
      const data: TableData = {
        id: 'width-controls',
        name: 'Samples',
        rows: 1,
        cols: 2,
        presentation,
        columnLabels: [...labels],
        columnWidths: { 0: 120, 1: 180 },
        cells: [
          [
            { type: 'text', value: 'A long sample description that needs fitting' },
            { type: 'number', value: '10' },
          ],
        ],
      };
      const update = vi.fn();
      render(
        <TableRenderer
          type="table"
          refId={data.id}
          attrs={data}
          selected={selected}
          onRemove={vi.fn()}
          onUpdateAttrs={update}
        />
      );

      const headers = screen.getByTestId('table-column-letters-row');
      expect(headers).toBeVisible();
      const handles = headers.querySelectorAll('[data-column-resize-handle]');
      expect(handles).toHaveLength(2);
      expect(handles[0]).toBeVisible();
      fireEvent.pointerDown(handles[0], { clientX: 120 });
      fireEvent.pointerMove(document, { clientX: 200 });
      expect(update).not.toHaveBeenCalled();
      fireEvent.pointerUp(document);
      expect(update).toHaveBeenLastCalledWith(
        expect.objectContaining({ columnWidths: { 0: 200, 1: 180 } })
      );
      fireEvent.doubleClick(handles[0]);
      const fitted = update.mock.calls.at(-1)![0] as TableData;
      expect(fitted.columnWidths![0]).toBeGreaterThan(200);
      expect(fitted.columnWidths![1]).toBe(180);
      expect(fitted.cells).toEqual(data.cells);
    }
  );

  it('keeps a document table without a writer read-only', () => {
    render(
      <TableRenderer
        type="table"
        refId="read-only-widths"
        attrs={{
          id: 'read-only-widths',
          rows: 1,
          cols: 1,
          presentation: 'document',
          cells: [[{ type: 'text', value: 'Preserved' }]],
          columnWidths: { 0: 137 },
        }}
        selected={false}
        onRemove={vi.fn()}
      />
    );
    expect(document.querySelector('[data-column-resize-handle]')).toBeNull();
    expect(document.querySelectorAll('colgroup col')[1]).toHaveStyle({ width: '137px' });
  });
});

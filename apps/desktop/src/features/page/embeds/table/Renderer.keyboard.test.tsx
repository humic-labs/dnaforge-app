import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { TableRenderer } from './Renderer';
import type { TableData } from './types';

vi.mock('../../../../lib/analytics', async (original) => ({
  ...(await original<typeof import('../../../../lib/analytics')>()),
  isAnalyticsCaptureReady: () => false,
  captureAnalyticsOptionalOrigin: () => null,
}));
vi.mock('../../store', async () => {
  const { create } = await import('zustand');
  return { usePageStore: create(() => ({ dirtyIds: new Set<string>() })) };
});
vi.mock('../../../canvas/public/store', async () => {
  const { create } = await import('zustand');
  return { useCanvasStore: create(() => ({ panels: {}, openWithSmartPlacement: vi.fn() })) };
});

const scrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
beforeAll(() => {
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
});
afterAll(() => {
  if (scrollIntoView) Object.defineProperty(Element.prototype, 'scrollIntoView', scrollIntoView);
  else Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
});

it('hands dimension confirmation to the first cell and accepts typing without a click', async () => {
  function NotebookTable() {
    const [data, setData] = useState<TableData>({});
    return (
      <>
        <TableRenderer
          type="table"
          refId="keyboard-created-table"
          attrs={data}
          selected
          onRemove={vi.fn()}
          onUpdateAttrs={(next) => setData((previous) => ({ ...previous, ...next }))}
        />
        <output data-testid="saved-table">{JSON.stringify(data)}</output>
      </>
    );
  }
  render(<NotebookTable />);
  const rows = screen.getByLabelText('rows');
  const cols = screen.getByLabelText('cols');
  act(() => rows.focus());
  fireEvent.change(rows, { target: { value: '2' } });
  fireEvent.change(cols, { target: { value: '3' } });
  act(() => cols.focus());

  fireEvent.keyDown(cols, { key: 'Enter' });

  const grid = screen.getByTestId('table-grid');
  const sink = screen.getByLabelText('Table keyboard navigation');
  await waitFor(() => expect(sink).toHaveFocus(), { onTimeout: (error) => error });
  expect(
    grid.querySelector('[data-testid="cell-focus-ring"]')?.closest('[data-cell-position]')
  ).toHaveAttribute('data-cell-position', '0,0');
  fireEvent.keyDown(sink, { key: 'S' });
  const input = grid.querySelector<HTMLInputElement>('[data-cell-position="0,0"] input');
  expect(input).not.toBeNull();
  await waitFor(() => expect(input).toHaveFocus(), { onTimeout: (error) => error });
  fireEvent.change(input!, { target: { value: 'Sample A' } });
  fireEvent.keyDown(input!, { key: 'Enter' });

  await waitFor(() => {
    const saved = JSON.parse(screen.getByTestId('saved-table').textContent!) as TableData;
    expect(saved.rows).toBe(2);
    expect(saved.cols).toBe(3);
    expect(saved.cells?.[0]?.[0]?.value).toBe('Sample A');
  });
});

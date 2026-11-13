// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installAnalyticsFirehose } from '../../../../../lib/analytics-firehose';
import { TableGrid } from './TableGrid';
import type { Cell } from '../types';

let scroll: PropertyDescriptor | undefined;
beforeEach(() => {
  scroll = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(() => {
  if (scroll) Object.defineProperty(Element.prototype, 'scrollIntoView', scroll);
  else Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
});

describe('T-N5 table data authored-ingress dependency gate', () => {
  it('blocks actual cells, labels, formula editor, descendants and aggregate parents before reads', () => {
    const data: Cell[][] = [
      [
        {
          value: '=NONFUNCTIONAL_TABLE_FORMULA()',
          type: 'formula',
          computed: 'NONFUNCTIONAL_TABLE_RESULT',
        },
      ],
    ];
    render(
      <TableGrid
        cells={data}
        displayCells={data}
        visibleRowIndices={[0]}
        sort={null}
        filters={{}}
        columnLabels={['NONFUNCTIONAL_TABLE_LABEL']}
        showColumnLabels
        showGhostCols={false}
        showGhostRows={false}
        onCellChange={vi.fn()}
        onExpandAndSetCell={vi.fn()}
        onFillRange={vi.fn()}
        onDeleteRange={vi.fn()}
        onSort={vi.fn()}
        onFilter={vi.fn()}
        onPaste={() => false}
      />
    );
    const cell = document.querySelector('[data-cell-position="0,0"]')!;
    fireEvent.mouseDown(cell);
    fireEvent.mouseUp(document);
    fireEvent.keyDown(screen.getByLabelText('Table keyboard navigation'), { key: 'Enter' });
    const editor = cell.querySelector('input')!;
    expect(editor).not.toBeNull();
    const root = screen.getByTestId('table-grid');
    expect(root).toHaveClass('ph-no-capture');
    expect(root).toHaveAttribute('data-analytics-block', 'true');
    const label = screen.getByTestId('table-column-label-0');
    const child = document.createElement('span');
    child.textContent = 'NONFUNCTIONAL_TABLE_CHILD';
    root.appendChild(child);
    const publicControl = document.createElement('button');
    publicControl.dataset.testid = 'f28-public-grid-control';
    publicControl.textContent = 'Open';
    document.body.appendChild(publicControl);
    const capture = vi.fn();
    const privateRead = vi.fn(() => 'NONFUNCTIONAL_TABLE_PRIVATE_SENTINEL');
    const restorations: Array<() => void> = [];
    let clock = 7_000;
    const uninstall = installAnalyticsFirehose({
      capture,
      now: () => {
        clock += 1_000;
        return clock;
      },
    });
    const types = ['click', 'focusin', 'wheel', 'keydown'];
    const stopAfterIngress = (event: Event) => event.stopImmediatePropagation();
    for (const type of types) window.addEventListener(type, stopAfterIngress, { capture: true });
    try {
      fireEvent.click(publicControl);
      expect(capture).toHaveBeenCalledTimes(1);
      expect(capture).toHaveBeenCalledWith(
        'interaction_observed',
        expect.objectContaining({ target_test_id: 'f28-public-grid-control' })
      );
      capture.mockClear();
      for (const target of [cell, editor, root, label, child, root.parentElement!]) {
        for (const property of ['textContent', 'ariaLabel', 'value']) {
          const original = Object.getOwnPropertyDescriptor(target, property);
          Object.defineProperty(target, property, { configurable: true, get: privateRead });
          restorations.push(() => {
            if (original) Object.defineProperty(target, property, original);
            else Reflect.deleteProperty(target, property);
          });
        }
        for (const type of types) {
          const event =
            type === 'keydown'
              ? new KeyboardEvent(type, {
                  bubbles: true,
                  composed: true,
                  key: 'NONFUNCTIONAL_TABLE_PRIVATE_KEY',
                })
              : new Event(type, { bubbles: true, composed: true });
          if (type === 'keydown') Object.defineProperty(event, 'key', { get: privateRead });
          fireEvent(target, event);
        }
      }
      expect(privateRead).not.toHaveBeenCalled();
      expect(capture).not.toHaveBeenCalled();
    } finally {
      uninstall();
      for (const type of types)
        window.removeEventListener(type, stopAfterIngress, { capture: true });
      for (const restore of restorations.reverse()) restore();
      child.remove();
      publicControl.remove();
    }
  });
});

import { render } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TableGrid } from './TableGrid';
import type { Cell } from '../types';

vi.mock('../hooks/useOverflowXWhenNeeded', () => ({
  useOverflowXWhenNeeded: () => true,
}));

const cells: Cell[][] = [
  [
    { type: 'text', value: 'sample-a' },
    { type: 'text', value: 'control' },
  ],
  [
    { type: 'text', value: 'sample-b' },
    { type: 'text', value: 'treated' },
  ],
];

type WheelReg = { target: EventTarget; options: boolean | AddEventListenerOptions | undefined };
let wheelRegs: WheelReg[] = [];
let originalAdd: typeof EventTarget.prototype.addEventListener;

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  wheelRegs = [];
  originalAdd = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (
    this: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions
  ) {
    if (type === 'wheel') wheelRegs.push({ target: this, options });
    return originalAdd.call(this, type, listener, options as never);
  } as typeof EventTarget.prototype.addEventListener;
});

afterEach(() => {
  EventTarget.prototype.addEventListener = originalAdd;
});

function isNonPassive(options: WheelReg['options']): boolean {
  return typeof options === 'object' && options !== null && options.passive === false;
}

describe('TableGrid wheel passivity', () => {
  it('attaches no { passive:false } wheel listener on the grid scroll element when overflow-x is active', () => {
    const { container } = render(
      <TableGrid
        displayCells={cells}
        cells={cells}
        visibleRowIndices={[0, 1]}
        sort={null}
        filters={{}}
        onCellChange={vi.fn()}
        onExpandAndSetCell={vi.fn()}
        onFillRange={vi.fn()}
        onDeleteRange={vi.fn()}
        onSort={vi.fn()}
        onFilter={vi.fn()}
        onPaste={vi.fn(() => false)}
      />
    );

    const gridScroll = container.querySelector('[data-testid="table-grid-scroll"]');
    expect(gridScroll, 'grid scroll element renders').not.toBeNull();

    const offenders = wheelRegs.filter(
      (reg) =>
        (reg.target === gridScroll || (gridScroll?.contains(reg.target as Node) ?? false)) &&
        isNonPassive(reg.options)
    );

    expect(
      offenders.length,
      'TableGrid attached a { passive:false } wheel listener on the grid scroll element — ' +
        'this kills compositor trackpad momentum (). Let vertical wheels chain natively.'
    ).toBe(0);
  });

  it('the spy would detect a non-passive wheel listener (meta — proves the assertion)', () => {
    const el = document.createElement('div');
    el.addEventListener('wheel', () => {}, { passive: false });
    const detected = wheelRegs.some((reg) => reg.target === el && isNonPassive(reg.options));
    expect(detected).toBe(true);
  });
});

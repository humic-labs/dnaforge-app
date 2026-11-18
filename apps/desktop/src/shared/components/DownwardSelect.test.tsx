import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { DownwardSelect } from './DownwardSelect';

const MENU_WIDTH = 400;

function stubViewport(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
}

function stubMenuWidth(width: number) {
  const original = HTMLElement.prototype.getBoundingClientRect;
  const rect = vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute('role') !== 'listbox') return original.call(this);
      const left = Number.parseFloat(this.style.left) || 0;
      const top = Number.parseFloat(this.style.top) || 0;
      return {
        x: left,
        y: top,
        top,
        bottom: top + 100,
        left,
        right: left + width,
        width,
        height: 100,
        toJSON: () => ({}),
      };
    });
  return () => rect.mockRestore();
}

function openAt(triggerLeft: number) {
  const trigger = screen.getByTestId('pick');
  trigger.getBoundingClientRect = () =>
    ({
      left: triggerLeft,
      right: triggerLeft + 80,
      top: 20,
      bottom: 40,
      width: 80,
      height: 20,
    }) as DOMRect;
  fireEvent.click(trigger);
  return screen.getByTestId('pick-menu');
}

function renderSelect() {
  return render(
    <DownwardSelect
      value="a"
      label="A"
      testId="pick"
      options={[
        { value: 'a', label: 'A', detail: 'in force', emphasis: true },
        { value: 'b', label: 'B' },
      ]}
      onChange={vi.fn()}
    />
  );
}

describe('DownwardSelect placement', () => {
  const restores: Array<() => void> = [];
  afterEach(() => {
    while (restores.length) restores.pop()?.();
  });

  it('keeps the whole menu on screen when the trigger sits near the right edge', () => {
    stubViewport(1000, 800);
    restores.push(stubMenuWidth(MENU_WIDTH));
    renderSelect();
    const menu = openAt(900);
    expect(Number.parseFloat(menu.style.left)).toBe(1000 - MENU_WIDTH - 8);
    expect(Number.parseFloat(menu.style.left) + MENU_WIDTH).toBeLessThanOrEqual(1000);
  });

  it('still opens under the trigger when there is room', () => {
    stubViewport(1000, 800);
    restores.push(stubMenuWidth(MENU_WIDTH));
    renderSelect();
    const menu = openAt(120);
    expect(Number.parseFloat(menu.style.left)).toBe(120);
    expect(Number.parseFloat(menu.style.top)).toBe(44);
  });

  it('never grows wider than the window or below its bottom', () => {
    stubViewport(360, 500);
    restores.push(stubMenuWidth(MENU_WIDTH));
    renderSelect();
    const menu = openAt(300);
    expect(Number.parseFloat(menu.style.maxWidth)).toBeLessThanOrEqual(360);
    expect(
      Number.parseFloat(menu.style.top) + Number.parseFloat(menu.style.maxHeight)
    ).toBeLessThanOrEqual(500);
  });
});

describe('DownwardSelect rows', () => {
  it('marks the row in force apart from the row merely selected', () => {
    render(
      <DownwardSelect
        value="b"
        label="B"
        testId="pick"
        options={[
          { value: 'a', label: 'A', emphasis: true, testId: 'row-a' },
          { value: 'b', label: 'B', testId: 'row-b' },
        ]}
        onChange={vi.fn()}
      />
    );
    fireEvent.click(screen.getByTestId('pick'));
    expect(within(screen.getByTestId('row-a')).getByText('A')).toHaveClass(
      'font-medium',
      'text-accent'
    );
    expect(within(screen.getByTestId('row-b')).getByText('B')).not.toHaveClass('text-accent');
    expect(screen.getByTestId('row-a')).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByTestId('row-a').className).not.toContain('bg-accent/10');
    expect(screen.getByTestId('row-b').className).not.toContain('bg-accent/10');
    expect(screen.getByTestId('row-b')).toHaveAttribute('aria-selected', 'true');
  });

  it('renders rich row content but keeps the plain label on the trigger', () => {
    render(
      <DownwardSelect
        value="a"
        label="3 — Yeast Mitochondrial"
        testId="pick"
        options={[
          {
            value: 'a',
            label: '3 — Yeast Mitochondrial',
            labelNode: (
              <span>
                <span data-testid="id-col">3</span>
                <span>Yeast Mitochondrial</span>
              </span>
            ),
            testId: 'row-a',
          },
        ]}
        onChange={vi.fn()}
      />
    );
    expect(screen.getByTestId('pick').textContent).toBe('3 — Yeast Mitochondrial');
    fireEvent.click(screen.getByTestId('pick'));
    expect(screen.getByTestId('id-col').textContent).toBe('3');
  });
});

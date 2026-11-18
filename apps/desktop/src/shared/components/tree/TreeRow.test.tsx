import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { INTERACTION_CLASS } from '@waypoint/ui-components';

import { TreeRow } from './TreeRow';

function renderRow(props: Partial<React.ComponentProps<typeof TreeRow>> = {}) {
  const result = render(
    <TreeRow
      depth={0}
      isSelected={false}
      icon={<span data-testid="glyph" />}
      label="rubisco.gb"
      data-testid="row"
      {...props}
    />
  );
  const row = result.container.querySelector('[data-testid="row"]') as HTMLElement;
  return { ...result, row };
}

describe('TreeRow', () => {
  describe('indent math (8 + depth * 16)', () => {
    it.each([
      [0, '8px'],
      [1, '24px'],
      [3, '56px'],
    ])('depth %i → paddingLeft %s', (depth, expected) => {
      const { row } = renderRow({ depth });
      expect(row.style.paddingLeft).toBe(expected);
    });

    it('indent wins over a caller-supplied style (still merges other style keys)', () => {
      const { row } = renderRow({ depth: 2, style: { paddingLeft: '999px', color: 'red' } });
      expect(row.style.paddingLeft).toBe('40px');
      expect(row.style.color).toBe('red');
    });
  });

  describe('chevron / spinner slot', () => {
    it('renders a chevron that rotates only when expanded', () => {
      const { row: collapsed } = renderRow({ isExpanded: false });
      const collapsedSvg = collapsed.querySelector('svg');
      expect(collapsedSvg).not.toBeNull();
      expect(collapsedSvg?.getAttribute('class')).not.toContain('rotate-90');

      const { row: expanded } = renderRow({ isExpanded: true });
      expect(expanded.querySelector('svg')?.getAttribute('class')).toContain('rotate-90');
    });

    it('renders NO chevron for a leaf (isExpanded undefined) — empty w-3 spacer', () => {
      const { row } = renderRow();
      expect(row.querySelector('svg')).toBeNull();
      expect(row.querySelector('.w-3')).not.toBeNull();
    });

    it('renders a spinner instead of the chevron while loading', () => {
      const { row } = renderRow({ isExpanded: false, isLoading: true });
      expect(row.querySelector('.animate-spin')).not.toBeNull();
      expect(row.querySelector('svg')).toBeNull();
    });

    it('makes the chevron an interactive button that toggles WITHOUT selecting', () => {
      const onToggleExpand = vi.fn();
      const onClick = vi.fn();
      const { row } = renderRow({
        isExpanded: false,
        onToggleExpand,
        onClick,
        toggleLabel: 'Expand src',
      });
      const button = row.querySelector('button');
      expect(button).not.toBeNull();
      expect(button?.getAttribute('aria-label')).toBe('Expand src');
      fireEvent.click(button as HTMLButtonElement);
      expect(onToggleExpand).toHaveBeenCalledTimes(1);
      expect(onClick).not.toHaveBeenCalled();
    });

    it('leaves the chevron presentational (no button) when onToggleExpand is omitted', () => {
      const { row } = renderRow({ isExpanded: false });
      expect(row.querySelector('button')).toBeNull();
    });
  });

  describe('state chrome', () => {
    it('applies selected classes when isSelected', () => {
      const { row } = renderRow({ isSelected: true });
      const cls = row.getAttribute('class') ?? '';
      expect(cls).toContain(INTERACTION_CLASS);
      expect(row.getAttribute('data-selected')).toBe('true');
      expect(cls).toContain('text-accent');
    });

    it('applies unselected/hover classes when not selected', () => {
      const { row } = renderRow({ isSelected: false });
      const cls = row.getAttribute('class') ?? '';
      expect(cls).toContain('text-fg');
      expect(cls).toContain(INTERACTION_CLASS);
      expect(row.getAttribute('data-selected')).not.toBe('true');
    });

    it('sets data-drop-active + the canonical drop-active class set when isDropActive', () => {
      const { row } = renderRow({ isDropActive: true });
      expect(row.getAttribute('data-drop-active')).toBe('true');
      expect(row.getAttribute('class')).toContain('data-[drop-active=true]:bg-accent/25');
    });

    it('does NOT set data-drop-active when isDropActive is falsy (external drag system owns it)', () => {
      const { row } = renderRow({ isDropActive: false });
      expect(row.hasAttribute('data-drop-active')).toBe(false);
    });
  });

  describe('slots', () => {
    it('renders the icon, label, and trailing slots', () => {
      const { row, getByTestId } = renderRow({
        label: 'rubisco.gb',
        trailing: <span data-testid="badge">GB</span>,
      });
      expect(getByTestId('glyph')).toBeInTheDocument();
      expect(row.textContent).toContain('rubisco.gb');
      expect(getByTestId('badge')).toBeInTheDocument();
    });

    it('wraps the label in a truncation span and applies labelClassName', () => {
      const { getByText } = renderRow({ label: 'long.gb', labelClassName: 'text-yellow-300' });
      const label = getByText('long.gb');
      const cls = label.getAttribute('class') ?? '';
      expect(cls).toContain('truncate');
      expect(cls).toContain('text-yellow-300');
    });
  });

  describe('rowProps passthrough', () => {
    it('forwards onClick', () => {
      const onClick = vi.fn();
      const { row } = renderRow({ onClick });
      fireEvent.click(row);
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('forwards draggable + drag handlers', () => {
      const onDragStart = vi.fn();
      const { row } = renderRow({ draggable: true, onDragStart });
      expect(row.getAttribute('draggable')).toBe('true');
      fireEvent.dragStart(row);
      expect(onDragStart).toHaveBeenCalledTimes(1);
    });

    it('forwards data-*, role, aria, and tabIndex', () => {
      const { row } = renderRow({
        'data-entry-path': '/ws/rubisco.gb',
        role: 'treeitem',
        'aria-selected': true,
        tabIndex: 0,
      });
      expect(row.getAttribute('data-entry-path')).toBe('/ws/rubisco.gb');
      expect(row.getAttribute('role')).toBe('treeitem');
      expect(row.getAttribute('aria-selected')).toBe('true');
      expect(row.getAttribute('tabindex')).toBe('0');
    });

    it('forwards a ref to the row element', () => {
      const ref = vi.fn();
      render(
        <TreeRow depth={0} isSelected={false} icon={null} label="x" ref={ref} data-testid="r" />
      );
      expect(ref).toHaveBeenCalledWith(expect.any(HTMLDivElement));
    });

    it('merges caller className after the base/state classes', () => {
      const { row } = renderRow({ className: 'font-medium' });
      const cls = row.getAttribute('class') ?? '';
      expect(cls).toContain('font-medium');
      expect(cls).toContain('flex');
    });
  });
});

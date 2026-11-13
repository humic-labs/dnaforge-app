import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MolecularViewNavigation } from './MolecularViewNavigation';
import { MolecularViewWorkspace } from './MolecularViewWorkspace';
import { ColorLegend } from './ColorLegend';
import { Color } from 'molstar/lib/mol-util/color';

beforeEach(() =>
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  )
);

const scene = JSON.stringify({
  kind: 'multiple',
  snapshots: Array.from({ length: 10000 }, (_, index) => ({
    root: { kind: 'root' },
    metadata: {
      title: index === 9999 ? 'Final catalytic pocket' : `Perspective ${index + 1}`,
      description: index === 9999 ? 'Distinctive magnesium coordination' : '',
    },
  })),
});
function setup(activeIndex = 0, disabled = false) {
  const onSelect = vi.fn();
  const props = { scene, activeIndex, disabled, onSelect };
  const result = render(
    <MolecularViewWorkspace>
      <div data-molecular-view-viewport className="relative">
        <MolecularViewNavigation {...props} />
      </div>
    </MolecularViewWorkspace>
  );
  return { ...result, onSelect, props };
}

describe('scalable molecular view library', () => {
  it('puts a thin view strip below the molecular key and browses over that same key', () => {
    render(
      <MolecularViewWorkspace>
        <MolecularViewNavigation scene={scene} activeIndex={0} onSelect={vi.fn()} />
        <ColorLegend legends={[{ kind: 'table-legend', table: [['Peptide', Color(0xaabbcc)]] }]} />
      </MolecularViewWorkspace>
    );
    const key = screen.getByTestId('molecular-view-footer');
    expect(within(key).getByTestId('molecular-view-key-title')).toHaveTextContent('Perspective 1');
    expect(within(key).getByRole('toolbar', { name: 'Visualization views' })).toBeInTheDocument();
    const body = key.querySelector('.molecular-view-key-body')!;
    const strip = screen.getByTestId('molecular-view-navigation-surface');
    expect(body.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(key).toContainElement(screen.getByTestId('structure-color-legend'));
    fireEvent.click(screen.getByRole('button', { name: 'Browse 10000 views' }));
    expect(key).toContainElement(screen.getByRole('region', { name: 'View library' }));
    expect(screen.queryByTestId('molecular-view-popup')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('keeps a regular structure key free of invented view navigation', () => {
    render(
      <MolecularViewWorkspace>
        <div data-molecular-view-viewport />
        <ColorLegend legends={[{ kind: 'table-legend', table: [['Chain A', Color(0xaabbcc)]] }]} />
      </MolecularViewWorkspace>
    );
    expect(screen.getByTestId('molecular-view-footer')).toContainElement(
      screen.getByTestId('structure-color-legend')
    );
    expect(screen.queryByTestId('molecular-view-navigation')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });

  it('removes the transient browser when an edit removes collection navigation', () => {
    const { rerender, props } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Browse 10000 views' }));
    rerender(
      <MolecularViewWorkspace>
        <div data-molecular-view-viewport>
          <MolecularViewNavigation {...props} scene='{"root":{"kind":"root"}}' />
        </div>
      </MolecularViewWorkspace>
    );
    expect(screen.queryByRole('region', { name: 'View library' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('molecular-view-library-dock')).not.toBeInTheDocument();
  });
  it('keeps the closed control bounded and searches all 10000 entries without mounting them all', () => {
    const { onSelect } = setup();
    expect(screen.queryByTestId('molecular-view-library-dock')).not.toBeInTheDocument();
    expect(screen.getByTestId('molecular-view-footer')).toContainElement(
      screen.getByTestId('molecular-view-navigation')
    );
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Compare view navigation')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Browse 10000 views' }));
    const library = screen.getByRole('region', { name: 'View library' });
    expect(document.querySelector('[data-molecular-view-viewport]')?.contains(library)).toBe(false);
    expect(within(library).getAllByRole('option').length).toBeLessThan(30);
    fireEvent.change(screen.getByRole('combobox', { name: 'Search views' }), {
      target: { value: 'magnesium' },
    });
    const entry = screen.getByRole('option', { name: /Final catalytic pocket/ });
    expect(entry).toHaveAttribute('data-view-index', '9999');
    expect(within(entry).getByText('10000')).toBeInTheDocument();
    fireEvent.click(entry);
    expect(onSelect).toHaveBeenCalledWith(9999);
    expect(library).not.toBeInTheDocument();
  });

  it('supports keyboard search and activation, and restores focus on Escape', () => {
    const { onSelect } = setup();
    const trigger = screen.getByRole('button', { name: 'Browse 10000 views' });
    fireEvent.click(trigger);
    const search = screen.getByRole('combobox', { name: 'Search views' });
    fireEvent.change(search, { target: { value: 'final catalytic' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith(9999);
    expect(screen.queryByRole('region', { name: 'View library' })).not.toBeInTheDocument();
    fireEvent.click(trigger);
    const reopenedSearch = screen.getByRole('combobox', { name: 'Search views' });
    fireEvent.change(reopenedSearch, { target: { value: 'does not exist' } });
    expect(screen.getByText('No matching views')).toBeInTheDocument();
    fireEvent.keyDown(reopenedSearch, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(reopenedSearch, { key: 'Escape' });
    expect(screen.queryByRole('region', { name: 'View library' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('browses a small collection with the keyboard without an unnecessary search field', () => {
    const onSelect = vi.fn();
    const smallScene = JSON.stringify({
      kind: 'multiple',
      snapshots: [
        { root: { kind: 'root' }, metadata: { title: 'Overview · Whole structure' } },
        { root: { kind: 'root' }, metadata: { title: 'Binding detail · Peptide contacts' } },
      ],
    });
    render(
      <MolecularViewWorkspace>
        <MolecularViewNavigation scene={smallScene} activeIndex={0} onSelect={onSelect} />
      </MolecularViewWorkspace>
    );
    const trigger = screen.getByRole('button', { name: 'Browse 2 views' });
    fireEvent.click(trigger);
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    const list = screen.getByRole('listbox', { name: 'Visualization views' });
    expect(list).toHaveFocus();
    expect(screen.getByRole('option', { name: 'Overview · Whole structure' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(
      within(screen.getByRole('option', { name: 'Overview · Whole structure' })).getByText('1')
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('option', { name: 'Binding detail · Peptide contacts' })).getByText(
        '2'
      )
    ).toBeInTheDocument();
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(list).toHaveAttribute(
      'aria-activedescendant',
      screen.getByRole('option', { name: 'Binding detail · Peptide contacts' }).id
    );
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(1);
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole('region', { name: 'View library' })).not.toBeInTheDocument();
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole('region', { name: 'View library' })).not.toBeInTheDocument();
  });

  it('clears search without closing the browser or selecting a view', () => {
    const { onSelect } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Browse 10000 views' }));
    const search = screen.getByRole('combobox', { name: 'Search views' });
    fireEvent.change(search, { target: { value: 'magnesium' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(search).toHaveValue('');
    expect(search).toHaveFocus();
    expect(screen.getByRole('region', { name: 'View library' })).toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('dismisses on outside input without stealing focus back from that input', () => {
    setup();
    const trigger = screen.getByRole('button', { name: 'Browse 10000 views' });
    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('region', { name: 'View library' })).not.toBeInTheDocument();
    expect(trigger).not.toHaveFocus();
  });

  it('reveals a selected offscreen row and reaches the last row by keyboard with bounded DOM', () => {
    setup(5000);
    fireEvent.click(screen.getByRole('button', { name: 'Browse 10000 views' }));
    expect(screen.getByRole('option', { name: /Perspective 5001/ })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    const search = screen.getByRole('combobox', { name: 'Search views' });
    fireEvent.keyDown(search, { key: 'End' });
    expect(screen.getByRole('option', { name: /Final catalytic pocket/ })).toBeInTheDocument();
    expect(screen.getAllByRole('option').length).toBeLessThan(30);
  });

  it('bounds the mounted list during a transient oversized layout measurement', () => {
    const height = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(200000);
    try {
      setup(5000);
      fireEvent.click(screen.getByRole('button', { name: 'Browse 10000 views' }));
      expect(screen.getAllByRole('option').length).toBeLessThan(30);
    } finally {
      height.mockRestore();
    }
  });

  it('provides bounded previous/next actions and disables native edits while loading', () => {
    const { onSelect, rerender, props } = setup();
    expect(screen.getByRole('button', { name: 'Previous view' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Next view' }));
    expect(onSelect).toHaveBeenCalledWith(1);
    rerender(
      <MolecularViewWorkspace>
        <div data-molecular-view-viewport>
          <MolecularViewNavigation {...props} activeIndex={9999} />
        </div>
      </MolecularViewWorkspace>
    );
    expect(screen.getByRole('button', { name: 'Next view' })).toBeDisabled();
    rerender(
      <MolecularViewWorkspace>
        <div data-molecular-view-viewport>
          <MolecularViewNavigation {...props} disabled />
        </div>
      </MolecularViewWorkspace>
    );
    expect(screen.getByRole('button', { name: 'Next view' })).toBeDisabled();
  });
});

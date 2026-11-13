import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FormulaAutocomplete } from './FormulaAutocomplete';

interface FormulaOption {
  name: string;
  syntax: string;
  description: string;
  example: string;
}

const opt = (name: string): FormulaOption => ({
  name,
  syntax: `${name}(range)`,
  description: `${name} description`,
  example: `=${name}(A1:A3)`,
});

const baseProps = {
  onSelectionChange: () => {},
  onSelect: () => {},
  onClose: () => {},
  position: { top: 0, left: 0 },
};

describe('FormulaAutocomplete (pure-view component)', () => {
  it('renders a button per filteredOption with the entry at selectedIndex highlighted', () => {
    render(
      <FormulaAutocomplete
        {...baseProps}
        filteredOptions={[opt('SUM'), opt('AVG'), opt('COUNT')]}
        selectedIndex={1}
      />
    );

    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(3);
    expect(buttons[1].className).toMatch(/bg-accent\/10/);
    expect(buttons[0].className).not.toMatch(/bg-accent\/10/);
    expect(buttons[2].className).not.toMatch(/bg-accent\/10/);
  });

  it('clicking an option calls onSelect with =NAME(', () => {
    const onSelect = vi.fn();
    render(
      <FormulaAutocomplete
        {...baseProps}
        filteredOptions={[opt('SUM')]}
        selectedIndex={0}
        onSelect={onSelect}
      />
    );

    fireEvent.click(screen.getByText('SUM'));
    expect(onSelect).toHaveBeenCalledWith('=SUM(');
  });

  it('hovering an option calls onSelectionChange with that index', () => {
    const onSelectionChange = vi.fn();
    render(
      <FormulaAutocomplete
        {...baseProps}
        filteredOptions={[opt('SUM'), opt('AVG'), opt('COUNT')]}
        selectedIndex={0}
        onSelectionChange={onSelectionChange}
      />
    );

    fireEvent.mouseEnter(screen.getAllByRole('button')[2]);
    expect(onSelectionChange).toHaveBeenCalledWith(2);
  });

  it('clicking outside the dropdown calls onClose', () => {
    const onClose = vi.fn();
    render(
      <div>
        <button data-testid="outside-target">outside</button>
        <FormulaAutocomplete
          {...baseProps}
          filteredOptions={[opt('SUM')]}
          selectedIndex={0}
          onClose={onClose}
        />
      </div>
    );

    fireEvent.mouseDown(screen.getByTestId('outside-target'));
    expect(onClose).toHaveBeenCalled();
  });

  it('renders nothing when filteredOptions is empty', () => {
    const { container } = render(
      <FormulaAutocomplete {...baseProps} filteredOptions={[]} selectedIndex={0} />
    );
    expect(container.firstChild).toBeNull();
  });
});

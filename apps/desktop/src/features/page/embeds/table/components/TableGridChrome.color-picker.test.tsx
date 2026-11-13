import { createRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TableGridFormulaBar } from './TableGridChrome';

function fixture(disabled = false) {
  const setTextColor = vi.fn();
  const { container } = render(
    <TableGridFormulaBar
      visible
      formatDisabled={disabled}
      selectionFormatState={{
        bold: false,
        italic: false,
        underline: false,
        strikethrough: false,
        align: 'left',
        textColor: null,
        bgColor: null,
      }}
      toggleBold={vi.fn()}
      toggleItalic={vi.fn()}
      toggleUnderline={vi.fn()}
      toggleStrikethrough={vi.fn()}
      setAlign={vi.fn()}
      setTextColor={setTextColor}
      setBgColor={vi.fn()}
      focusedCellAddress="A1"
      formulaBarValue="value"
      formulaBarInputRef={createRef<HTMLInputElement>()}
      onFormulaBarChange={vi.fn()}
      onFormulaBarBlur={vi.fn()}
      onFormulaBarKeyDown={vi.fn()}
      onFormulaBarFocus={vi.fn()}
      focusedCell={{ row: 0, col: 0 }}
    />
  );
  return { container, setTextColor };
}

describe('embedded table color menu', () => {
  it('opens by activation, portals outside the table, and applies one color', () => {
    const { container, setTextColor } = fixture();
    fireEvent.click(screen.getByRole('button', { name: 'Text color', exact: true }));
    const menu = screen.getByRole('menu', { name: 'Text color' });
    expect(container.contains(menu)).toBe(false);
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Red', exact: true }));
    expect(setTextColor).toHaveBeenCalledExactlyOnceWith('#ef4444');
    expect(screen.queryByRole('menu', { name: 'Text color' })).toBeNull();
  });

  it('does not expose formatting options when editing is disabled', () => {
    fixture(true);
    fireEvent.click(screen.getByRole('button', { name: 'Text color', exact: true }));
    expect(screen.queryByRole('menu', { name: 'Text color' })).toBeNull();
    expect(screen.queryByRole('menuitemradio')).toBeNull();
  });
});

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { InlineConfig } from './InlineConfig';

describe('table dimension keyboard entry', () => {
  it('focuses rows when consuming freshness updates the parent immediately', async () => {
    const cleared = vi.fn();
    function FreshConfig() {
      const [fresh, setFresh] = useState(true);
      return (
        <InlineConfig
          autoFocus={fresh}
          onClearFresh={() => {
            cleared();
            setFresh(false);
          }}
          onConfigure={vi.fn()}
        />
      );
    }
    render(<FreshConfig />);

    await waitFor(() => expect(screen.getByLabelText('rows')).toHaveFocus());
    expect(cleared).toHaveBeenCalledTimes(1);
  });

  it('moves from rows to columns with Tab after freshness has been consumed', () => {
    const configure = vi.fn();
    render(<InlineConfig autoFocus={false} onConfigure={configure} />);
    const rows = screen.getByLabelText('rows');
    const cols = screen.getByLabelText('cols');
    act(() => rows.focus());
    fireEvent.change(rows, { target: { value: '4' } });

    fireEvent.keyDown(rows, { key: 'Tab' });

    expect(cols).toHaveFocus();
    fireEvent.change(cols, { target: { value: '3' } });
    fireEvent.keyDown(cols, { key: 'Enter' });
    expect(configure).toHaveBeenCalledExactlyOnceWith(4, 3);
  });

  it('moves from columns to rows with Shift+Tab after freshness has been consumed', () => {
    render(<InlineConfig autoFocus={false} onConfigure={vi.fn()} />);
    const rows = screen.getByLabelText('rows');
    const cols = screen.getByLabelText('cols');
    act(() => cols.focus());

    fireEvent.keyDown(cols, { key: 'Tab', shiftKey: true });

    expect(rows).toHaveFocus();
  });

  it.each(['rows', 'cols'])('submits the entered dimensions with Enter from %s', (field) => {
    const configure = vi.fn();
    render(<InlineConfig onConfigure={configure} />);
    fireEvent.change(screen.getByLabelText('rows'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('cols'), { target: { value: '3' } });
    const input = screen.getByLabelText(field);
    act(() => input.focus());

    fireEvent.keyDown(input, { key: 'Enter' });

    expect(configure).toHaveBeenCalledExactlyOnceWith(4, 3);
  });

  it('returns focus to notebook text with Escape without configuring the table', () => {
    const configure = vi.fn();
    function Notebook() {
      const editor = useRef<HTMLDivElement>(null);
      return (
        <>
          <div ref={editor} contentEditable suppressContentEditableWarning tabIndex={0}>
            Notebook text
          </div>
          <InlineConfig onConfigure={configure} onBlurToEditor={() => editor.current?.focus()} />
        </>
      );
    }
    render(<Notebook />);
    const rows = screen.getByLabelText('rows');
    act(() => rows.focus());

    fireEvent.keyDown(rows, { key: 'Escape' });

    expect(screen.getByText('Notebook text')).toHaveFocus();
    expect(configure).not.toHaveBeenCalled();
  });
});

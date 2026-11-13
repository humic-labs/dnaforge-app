import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PrimerLengthField } from './PrimerLengthField';

describe('PrimerLengthField', () => {
  it('renders a plain number (no stepper, no inner box) when not editable', () => {
    render(<PrimerLengthField value={22} min={10} max={60} onChange={vi.fn()} editable={false} />);
    expect(screen.getByTestId('primer-3prime-length').textContent).toContain('22');
    expect(screen.queryByTestId('primer-length-input')).toBeNull();
    expect(screen.queryByLabelText('Increase length')).toBeNull();
    const root = screen.getByTestId('primer-3prime-length');
    expect(root.querySelector('.border, .rounded-md')).toBeNull();
  });

  it('adjusts via the +/- stepper, clamped to bounds', () => {
    const onChange = vi.fn();
    render(<PrimerLengthField value={22} min={10} max={60} onChange={onChange} editable />);
    fireEvent.click(screen.getByLabelText('Increase length'));
    expect(onChange).toHaveBeenLastCalledWith(23);
    fireEvent.click(screen.getByLabelText('Decrease length'));
    expect(onChange).toHaveBeenLastCalledWith(21);
  });

  it('disables the stepper button at the bound and renders no inner bordered box', () => {
    render(<PrimerLengthField value={10} min={10} max={60} onChange={vi.fn()} editable />);
    expect(screen.getByLabelText('Decrease length')).toBeDisabled();
    const root = screen.getByTestId('primer-3prime-length');
    expect(root.querySelector('.border, .rounded-md')).toBeNull();
  });

  it('commits a typed value on blur, clamped', () => {
    const onChange = vi.fn();
    render(<PrimerLengthField value={22} min={10} max={60} onChange={onChange} editable />);
    const input = screen.getByTestId('primer-length-input');
    fireEvent.change(input, { target: { value: '999' } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(60);
  });

  it('commits a typed value on Enter and blurs the field', () => {
    const onChange = vi.fn();
    render(<PrimerLengthField value={22} min={10} max={60} onChange={onChange} editable />);
    const input = screen.getByTestId('primer-length-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '35' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(35);
    expect(input).not.toHaveFocus();
  });

  it('does not mutate the primer while a partial number is mid-type — only on commit', () => {
    const onChange = vi.fn();
    render(<PrimerLengthField value={24} min={10} max={60} onChange={onChange} editable />);
    const input = screen.getByTestId('primer-length-input') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '5' } });
    expect(input.value).toBe('5');
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: '50' } });
    expect(input.value).toBe('50');
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(50);
  });

  it('Escape reverts an in-progress edit to the current value without committing', () => {
    const onChange = vi.fn();
    render(<PrimerLengthField value={24} min={10} max={60} onChange={onChange} editable />);
    const input = screen.getByTestId('primer-length-input') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe('24');
    expect(input).not.toHaveFocus();
  });

  it('snaps back to the real value if the parent could not fully apply the requested length (e.g. ran off the template)', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <PrimerLengthField value={22} min={10} max={60} onChange={onChange} editable />
    );
    fireEvent.click(screen.getByLabelText('Increase length'));
    expect(onChange).toHaveBeenLastCalledWith(23);

    rerender(<PrimerLengthField value={22} min={10} max={60} onChange={onChange} editable />);

    const input = screen.getByTestId('primer-length-input') as HTMLInputElement;
    expect(input.value).toBe('22');
  });
});

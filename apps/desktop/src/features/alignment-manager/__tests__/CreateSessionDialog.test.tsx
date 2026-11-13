import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CreateSessionDialog } from '../panel/CreateSessionDialog';

describe('CreateSessionDialog', () => {
  const mockOnCreate = vi.fn();
  const mockOnCancel = vi.fn();

  const defaultProps = {
    referenceName: 'pUC19-GFP.gb',
    queryFiles: [
      { path: '/path/to/clone1.ab1', name: 'clone1.ab1' },
      { path: '/path/to/clone2.ab1', name: 'clone2.ab1' },
    ],
    onCreate: mockOnCreate,
    onCancel: mockOnCancel,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('displays the reference name', () => {
    render(<CreateSessionDialog {...defaultProps} />);

    expect(screen.getByText('pUC19-GFP.gb')).toBeInTheDocument();
  });

  it('displays the query files', () => {
    render(<CreateSessionDialog {...defaultProps} />);

    expect(screen.getByText('• clone1.ab1')).toBeInTheDocument();
    expect(screen.getByText('• clone2.ab1')).toBeInTheDocument();
  });

  it('displays the file count', () => {
    render(<CreateSessionDialog {...defaultProps} />);

    expect(screen.getByText(/Files to align \(2\)/i)).toBeInTheDocument();
  });

  it('defaults to "1 clone per sequence" mode', () => {
    render(<CreateSessionDialog {...defaultProps} />);

    const onePerCloneRadio = screen.getByRole('radio', { name: /1 clone per sequence/i });
    expect(onePerCloneRadio).toBeChecked();
  });

  it('allows switching to "multiple sequences per clone" mode', () => {
    render(<CreateSessionDialog {...defaultProps} />);

    const multiPerCloneRadio = screen.getByRole('radio', {
      name: /Multiple sequences per clone/i,
    });
    fireEvent.click(multiPerCloneRadio);

    expect(multiPerCloneRadio).toBeChecked();
  });

  it('shows error when submitting without a name', () => {
    render(<CreateSessionDialog {...defaultProps} />);

    const submitButton = screen.getByRole('button', { name: /Create & Align/i });
    fireEvent.click(submitButton);

    expect(screen.getByText('Session name is required')).toBeInTheDocument();
    expect(mockOnCreate).not.toHaveBeenCalled();
  });

  it('shows error when submitting with whitespace-only name', () => {
    render(<CreateSessionDialog {...defaultProps} />);

    const nameInput = screen.getByRole('textbox');
    fireEvent.change(nameInput, { target: { value: '   ' } });

    const submitButton = screen.getByRole('button', { name: /Create & Align/i });
    fireEvent.click(submitButton);

    expect(screen.getByText('Session name is required')).toBeInTheDocument();
    expect(mockOnCreate).not.toHaveBeenCalled();
  });

  it('calls onCreate with name and mode when valid', () => {
    render(<CreateSessionDialog {...defaultProps} />);

    const nameInput = screen.getByRole('textbox');
    fireEvent.change(nameInput, { target: { value: 'Cloning Run 1' } });

    const submitButton = screen.getByRole('button', { name: /Create & Align/i });
    fireEvent.click(submitButton);

    expect(mockOnCreate).toHaveBeenCalledWith('Cloning Run 1', 'one-per-clone');
  });

  it('calls onCreate with correct mode when "multi-per-clone" selected', () => {
    render(<CreateSessionDialog {...defaultProps} />);

    const nameInput = screen.getByRole('textbox');
    fireEvent.change(nameInput, { target: { value: 'My Session' } });

    const multiPerCloneRadio = screen.getByRole('radio', {
      name: /Multiple sequences per clone/i,
    });
    fireEvent.click(multiPerCloneRadio);

    const submitButton = screen.getByRole('button', { name: /Create & Align/i });
    fireEvent.click(submitButton);

    expect(mockOnCreate).toHaveBeenCalledWith('My Session', 'multi-per-clone');
  });

  it('calls onCancel when Cancel button clicked', () => {
    render(<CreateSessionDialog {...defaultProps} />);

    const cancelButton = screen.getByRole('button', { name: /Cancel/i });
    fireEvent.click(cancelButton);

    expect(mockOnCancel).toHaveBeenCalled();
  });

  it('calls onCancel when clicking outside the dialog', () => {
    render(<CreateSessionDialog {...defaultProps} />);

    const backdrop = screen.getByRole('dialog');
    fireEvent.click(backdrop);

    expect(mockOnCancel).toHaveBeenCalled();
  });

  it('does not call onCancel when clicking inside the dialog', () => {
    render(<CreateSessionDialog {...defaultProps} />);

    const nameInput = screen.getByRole('textbox');
    fireEvent.click(nameInput);

    expect(mockOnCancel).not.toHaveBeenCalled();
  });

  it('clears error when user starts typing', () => {
    render(<CreateSessionDialog {...defaultProps} />);

    const submitButton = screen.getByRole('button', { name: /Create & Align/i });
    fireEvent.click(submitButton);
    expect(screen.getByText('Session name is required')).toBeInTheDocument();

    const nameInput = screen.getByRole('textbox');
    fireEvent.change(nameInput, { target: { value: 'a' } });

    expect(screen.queryByText('Session name is required')).not.toBeInTheDocument();
  });
});

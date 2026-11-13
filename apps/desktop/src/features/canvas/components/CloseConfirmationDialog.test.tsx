import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CloseConfirmationDialog } from './CloseConfirmationDialog';

describe('CloseConfirmationDialog', () => {
  const defaultProps = {
    fileName: 'test-file.ts',
    onSave: vi.fn(),
    onDontSave: vi.fn(),
    onCancel: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('rendering', () => {
    it('renders dialog with correct title', () => {
      render(<CloseConfirmationDialog {...defaultProps} />);
      expect(screen.getByText('Do you want to save changes?')).toBeInTheDocument();
    });

    it('displays the file name in the message', () => {
      render(<CloseConfirmationDialog {...defaultProps} />);
      expect(screen.getByText('test-file.ts')).toBeInTheDocument();
    });

    it('renders all three buttons', () => {
      render(<CloseConfirmationDialog {...defaultProps} />);
      expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: "Don't Save" })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    });

    it('renders as a modal dialog', () => {
      render(<CloseConfirmationDialog {...defaultProps} />);
      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveAttribute('aria-modal', 'true');
    });
  });

  describe('button interactions', () => {
    it('calls onSave when Save button is clicked', () => {
      render(<CloseConfirmationDialog {...defaultProps} />);
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      expect(defaultProps.onSave).toHaveBeenCalledTimes(1);
    });

    it("calls onDontSave when Don't Save button is clicked", () => {
      render(<CloseConfirmationDialog {...defaultProps} />);
      fireEvent.click(screen.getByRole('button', { name: "Don't Save" }));
      expect(defaultProps.onDontSave).toHaveBeenCalledTimes(1);
    });

    it('calls onCancel when Cancel button is clicked', () => {
      render(<CloseConfirmationDialog {...defaultProps} />);
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(defaultProps.onCancel).toHaveBeenCalledTimes(1);
    });
  });

  describe('keyboard interactions', () => {
    it('calls onCancel when Escape key is pressed', () => {
      render(<CloseConfirmationDialog {...defaultProps} />);
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(defaultProps.onCancel).toHaveBeenCalledTimes(1);
    });

    it('calls onSave when Enter key is pressed', () => {
      render(<CloseConfirmationDialog {...defaultProps} />);
      fireEvent.keyDown(window, { key: 'Enter' });
      expect(defaultProps.onSave).toHaveBeenCalledTimes(1);
    });

    it('does not call callbacks for other keys', () => {
      render(<CloseConfirmationDialog {...defaultProps} />);
      fireEvent.keyDown(window, { key: 'a' });
      fireEvent.keyDown(window, { key: 'Tab' });
      expect(defaultProps.onSave).not.toHaveBeenCalled();
      expect(defaultProps.onDontSave).not.toHaveBeenCalled();
      expect(defaultProps.onCancel).not.toHaveBeenCalled();
    });
  });

  describe('click outside', () => {
    it('calls onCancel when clicking outside the dialog', async () => {
      render(<CloseConfirmationDialog {...defaultProps} />);

      await vi.waitFor(() => {
        const backdrop = document.querySelector('.fixed.inset-0');
        if (backdrop) {
          fireEvent.mouseDown(backdrop);
        }
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      fireEvent.mouseDown(document.body);
      expect(defaultProps.onCancel).toHaveBeenCalled();
    });

    it('does not call onCancel when clicking inside the dialog', async () => {
      render(<CloseConfirmationDialog {...defaultProps} />);

      await new Promise((resolve) => setTimeout(resolve, 10));

      const dialog = screen.getByRole('dialog');
      fireEvent.mouseDown(dialog);

      expect(defaultProps.onCancel).not.toHaveBeenCalled();
    });
  });

  describe('cleanup', () => {
    it('removes event listeners on unmount', () => {
      const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener');
      const removeDocListenerSpy = vi.spyOn(document, 'removeEventListener');

      const { unmount } = render(<CloseConfirmationDialog {...defaultProps} />);
      unmount();

      expect(removeEventListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function));

      removeEventListenerSpy.mockRestore();
      removeDocListenerSpy.mockRestore();
    });
  });
});

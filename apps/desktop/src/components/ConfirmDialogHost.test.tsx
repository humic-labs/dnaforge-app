import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfirmDialogHost } from './ConfirmDialogHost';
import { confirmDialog, promptDialog, useConfirmDialogStore } from './confirm-dialog-store';

describe('ConfirmDialogHost', () => {
  afterEach(() => {
    useConfirmDialogStore.setState({ request: null });
  });

  it('defaults safety-sensitive confirmations to deny for Enter', async () => {
    render(<ConfirmDialogHost />);
    let decision!: Promise<boolean>;
    act(() => {
      decision = confirmDialog({
        title: 'Allow workspace change?',
        message: 'This action modifies your workspace.',
        confirmLabel: 'Allow change',
        cancelLabel: 'Keep workspace unchanged',
        tone: 'danger',
        safeDefault: true,
      });
    });

    const dialog = screen.getByTestId('confirm-dialog');
    expect(dialog).toBeInstanceOf(HTMLDialogElement);
    expect(dialog).toHaveAttribute('open');
    expect(dialog).toHaveAttribute('data-agent-approval-ui', 'safe-default-v1');
    expect(screen.getByTestId('confirm-dialog-cancel')).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Enter' });
    await expect(decision).resolves.toBe(false);
    expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
    expect(dialog).not.toHaveAttribute('open');
  });

  it('refocuses deny when an approval is replaced and requires explicit allowance', async () => {
    render(<ConfirmDialogHost />);
    let first!: Promise<boolean>;
    let replacement!: Promise<boolean>;
    act(() => {
      first = confirmDialog({ title: 'First change', message: 'First', safeDefault: true });
    });
    screen.getByTestId('confirm-dialog-confirm').focus();
    act(() => {
      replacement = confirmDialog({ title: 'Next change', message: 'Next', safeDefault: true });
    });
    await expect(first).resolves.toBe(false);
    expect(screen.getByTestId('confirm-dialog-cancel')).toHaveFocus();
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    await expect(replacement).resolves.toBe(true);
  });

  it.each(['Escape', 'native cancel'])(
    'denies a safety-sensitive request on %s',
    async (action) => {
      render(<ConfirmDialogHost />);
      let decision!: Promise<boolean>;
      act(() => {
        decision = confirmDialog({
          title: 'Change workspace?',
          message: 'Change',
          safeDefault: true,
        });
      });
      if (action === 'Escape') {
        fireEvent.keyDown(document, { key: 'Escape' });
      } else {
        fireEvent(screen.getByTestId('confirm-dialog'), new Event('cancel', { cancelable: true }));
      }
      await expect(decision).resolves.toBe(false);
      expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
    }
  );

  it('preserves Enter-to-confirm for ordinary confirmations', async () => {
    render(<ConfirmDialogHost />);
    let decision!: Promise<boolean>;
    act(() => {
      decision = confirmDialog({ title: 'Move item?', message: 'This is reversible.' });
    });

    expect(screen.getByTestId('confirm-dialog-confirm')).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Enter' });
    await expect(decision).resolves.toBe(true);
  });

  it('resolves a prompt with the trimmed text on Enter and null on cancel', async () => {
    render(<ConfirmDialogHost />);
    let answer!: Promise<string | null>;
    act(() => {
      answer = promptDialog({
        title: 'Rename project',
        message: 'Pick a name.',
        confirmLabel: 'Rename',
        input: { defaultValue: 'My Project', label: 'Project name' },
      });
    });

    const field = screen.getByTestId('confirm-dialog-input');
    expect(field).toHaveValue('My Project');
    expect(field).toHaveFocus();
    fireEvent.change(field, { target: { value: '  Lab Notebook ' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await expect(answer).resolves.toBe('Lab Notebook');

    act(() => {
      answer = promptDialog({
        title: 'Rename project',
        message: 'Pick a name.',
        input: { defaultValue: 'My Project' },
      });
    });
    fireEvent.click(screen.getByTestId('confirm-dialog-cancel'));
    await expect(answer).resolves.toBeNull();
  });

  it('never submits a blank prompt', async () => {
    render(<ConfirmDialogHost />);
    let answer!: Promise<string | null>;
    act(() => {
      answer = promptDialog({
        title: 'Rename project',
        message: 'Pick a name.',
        input: { defaultValue: 'My Project' },
      });
    });

    const field = screen.getByTestId('confirm-dialog-input');
    fireEvent.change(field, { target: { value: '   ' } });
    expect(screen.getByTestId('confirm-dialog-confirm')).toBeDisabled();
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument();

    fireEvent.keyDown(field, { key: 'Escape' });
    await expect(answer).resolves.toBeNull();
  });

  it('dismisses a prompt from Escape after focus leaves the field, and from the backdrop', async () => {
    render(<ConfirmDialogHost />);
    let answer!: Promise<string | null>;
    act(() => {
      answer = promptDialog({
        title: 'Rename project',
        message: 'Pick a name.',
        input: { defaultValue: 'My Project' },
      });
    });
    screen.getByTestId('confirm-dialog-cancel').focus();
    fireEvent.keyDown(document, { key: 'Escape' });
    await expect(answer).resolves.toBeNull();

    act(() => {
      answer = promptDialog({
        title: 'Rename project',
        message: 'Pick a name.',
        input: { defaultValue: 'My Project' },
      });
    });
    fireEvent.mouseDown(screen.getByTestId('confirm-dialog-backdrop'));
    await expect(answer).resolves.toBeNull();
  });

  it('optionally renders a close button that dismisses the dialog', async () => {
    render(<ConfirmDialogHost />);
    let decision!: Promise<boolean>;
    act(() => {
      decision = confirmDialog({
        title: 'Sign in to use Hosted AI',
        message: 'Hosted AI requires a DNAForge account.',
        confirmLabel: 'Sign in',
        cancelLabel: 'Not now',
        showCloseButton: true,
      });
    });

    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));

    await expect(decision).resolves.toBe(false);
    expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
  });
});

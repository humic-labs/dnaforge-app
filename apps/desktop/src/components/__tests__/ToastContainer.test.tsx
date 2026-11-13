import { userMessageWithValues, userMessageValue } from '@waypoint/user-messages';
import { ReleaseNotesModal } from '../ReleaseNotesModal';
import { useReleaseNotesPresentation } from '../../hooks/useReleaseNotesPresentation';
import { safeFocus } from '../../shared/utils/safeFocus';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastContainer } from '../ToastContainer';
import { TOAST_BASE_CLASS_NAME } from '../toast-rules';
import { TOAST_DISMISS_REMOVE_DELAY_MS, useToastStore } from '../../stores/toast-store';

vi.mock('../../lib/analytics', () => ({ trackRendererEvent: vi.fn(() => false) }));

const notice = (name: string) =>
  userMessageWithValues('notice.opened-value', { value0: userMessageValue(name) });

function finishToastExit() {
  act(() => {
    vi.advanceTimersByTime(TOAST_DISMISS_REMOVE_DELAY_MS);
  });
}

describe('ToastContainer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useToastStore.getState().clearToasts();
  });

  afterEach(() => {
    act(() => {
      useToastStore.getState().clearToasts();
    });
    vi.useRealTimers();
  });

  it.each(['mouse', 'keyboard'] as const)(
    'passes the exact %s toast control once to notes and returns to fallback after it exits',
    async (gesture) => {
      if (gesture === 'keyboard') vi.useRealTimers();
      const invoked = vi.fn();
      function Harness() {
        const notes = useReleaseNotesPresentation();
        return (
          <>
            <button data-testid="settings-button">Fallback Settings</button>
            <button
              onClick={() =>
                useToastStore.getState().addRichToast({
                  definition: 'post-update',
                  message: notice('Synthetic UI action only'),
                  actions: [
                    {
                      label: "What's new",
                      onClick: (sourceElement) => {
                        invoked(sourceElement);
                        notes.open('post_update_toast', '0.9.3', sourceElement);
                      },
                    },
                  ],
                })
              }
            >
              Create controlled action
            </button>
            <ToastContainer />
            <ReleaseNotesModal {...notes.modalProps} />
          </>
        );
      }
      render(<Harness />);
      fireEvent.click(screen.getByRole('button', { name: 'Create controlled action' }));
      const sourceElement = screen.getByRole('button', { name: "What's new" });
      if (gesture === 'mouse') {
        safeFocus(screen.getByTestId('settings-button'));
        fireEvent.click(sourceElement);
      } else {
        const user = userEvent.setup();
        safeFocus(sourceElement);
        await user.keyboard('{Enter}');
      }
      expect(invoked).toHaveBeenCalledTimes(1);
      expect(invoked).toHaveBeenCalledWith(sourceElement);
      expect(screen.getByTestId('release-notes-heading')).toBe(document.activeElement);
      if (gesture === 'mouse') finishToastExit();
      else await waitFor(() => expect(sourceElement.isConnected).toBe(false));
      expect(sourceElement.isConnected).toBe(false);
      fireEvent.click(screen.getByRole('button', { name: 'Close', exact: true }));
      expect(document.activeElement).toBe(screen.getByTestId('settings-button'));
    }
  );

  it('should render nothing when there are no toasts', () => {
    const { container } = render(<ToastContainer />);
    expect(container.innerHTML).toBe('');
  });

  it('should render a toast message', () => {
    useToastStore.setState({
      toasts: [{ id: 'test-1', message: notice('Hello world'), type: 'info', duration: 4000 }],
    });
    render(<ToastContainer />);
    expect(screen.getByText(notice('Hello world'))).toBeInTheDocument();
  });

  it('should render multiple toasts stacked', () => {
    useToastStore.setState({
      toasts: [
        { id: 'test-1', message: notice('First'), type: 'info', duration: 0 },
        { id: 'test-2', message: notice('Second'), type: 'success', duration: 0 },
        { id: 'test-3', message: notice('Third'), type: 'error', duration: 0 },
      ],
    });
    render(<ToastContainer />);
    expect(screen.getByText(notice('First'))).toBeInTheDocument();
    expect(screen.getByText(notice('Second'))).toBeInTheDocument();
    expect(screen.getByText(notice('Third'))).toBeInTheDocument();
  });

  it('should apply correct styles per toast type', () => {
    useToastStore.setState({
      toasts: [
        { id: 't-info', message: notice('Info'), type: 'info', duration: 0 },
        { id: 't-error', message: notice('Error'), type: 'error', duration: 0 },
      ],
    });
    render(<ToastContainer />);
    expect(screen.getByTestId('toast-info')).toBeInTheDocument();
    expect(screen.getByTestId('toast-error')).toBeInTheDocument();
  });

  it('uses implicit live-region semantics from status and alert roles', () => {
    useToastStore.setState({
      toasts: [
        { id: 't-info', message: notice('Info'), type: 'info', duration: 0 },
        { id: 't-error', message: notice('Error'), type: 'error', duration: 0 },
      ],
    });
    render(<ToastContainer />);

    expect(screen.getByTestId('toast-info')).toHaveAttribute('role', 'status');
    expect(screen.getByTestId('toast-info')).not.toHaveAttribute('aria-live');
    expect(screen.getByTestId('toast-error')).toHaveAttribute('role', 'alert');
    expect(screen.getByTestId('toast-error')).not.toHaveAttribute('aria-live');
  });

  it('should dismiss a toast when X is clicked', () => {
    useToastStore.setState({
      toasts: [{ id: 'test-1', message: notice('Dismiss me'), type: 'info', duration: 0 }],
    });
    render(<ToastContainer />);
    expect(screen.getByText(notice('Dismiss me'))).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('toast-dismiss'));
    expect(screen.getByTestId('toast-info')).toHaveAttribute('data-toast-phase', 'exiting');
    expect(screen.getByTestId('toast-info')).toHaveStyle({ opacity: '0' });
    finishToastExit();
    expect(screen.queryByText(notice('Dismiss me'))).not.toBeInTheDocument();
  });

  it('keeps keyboard dismissal available through the labeled close button', async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    useToastStore.setState({
      toasts: [
        {
          id: 'test-1',
          message: notice('Keyboard dismiss me'),
          type: 'info',
          duration: 0,
          dismissOn: 'surface',
        },
      ],
    });
    render(<ToastContainer />);

    const dismissButton = screen.getByRole('button', { name: 'Dismiss notification' });
    dismissButton.focus();
    await user.keyboard('{Enter}');

    expect(screen.getByTestId('toast-info')).toHaveAttribute('data-toast-phase', 'exiting');
  });

  it('dismisses a surface-dismissible toast when its body is clicked', () => {
    useToastStore.setState({
      toasts: [
        {
          id: 'test-1',
          message: notice('Click the body to dismiss'),
          type: 'info',
          duration: 0,
          dismissOn: 'surface',
        },
      ],
    });
    render(<ToastContainer />);
    expect(screen.getByTestId('toast-dismiss-hint')).toHaveTextContent('Click to dismiss');
    expect(screen.getByTestId('toast-info')).toHaveClass('pointer-events-auto');

    fireEvent.click(screen.getByText(notice('Click the body to dismiss')));
    expect(screen.getByTestId('toast-info')).toHaveAttribute('data-toast-phase', 'exiting');
    finishToastExit();
    expect(screen.queryByText(notice('Click the body to dismiss'))).not.toBeInTheDocument();
  });

  it('should not dismiss a default toast when only the toast body is clicked', () => {
    useToastStore.setState({
      toasts: [
        {
          id: 'test-1',
          message: notice('Body click should not dismiss'),
          type: 'info',
          duration: 0,
        },
      ],
    });
    render(<ToastContainer />);

    fireEvent.click(screen.getByText(notice('Body click should not dismiss')));
    expect(screen.getByText(notice('Body click should not dismiss'))).toBeInTheDocument();
  });

  it('should only dismiss the clicked toast when multiple are stacked', () => {
    useToastStore.setState({
      toasts: [
        { id: 'test-1', message: notice('Keep me'), type: 'info', duration: 0 },
        { id: 'test-2', message: notice('Remove me'), type: 'warning', duration: 0 },
      ],
    });
    render(<ToastContainer />);

    const warningToast = screen.getByTestId('toast-warning');
    const dismissBtn = within(warningToast).getByTestId('toast-dismiss');
    fireEvent.click(dismissBtn);

    expect(screen.getByText(notice('Keep me'))).toBeInTheDocument();
    expect(warningToast).toHaveAttribute('data-toast-phase', 'exiting');
    finishToastExit();
    expect(screen.queryByText(notice('Remove me'))).not.toBeInTheDocument();
  });

  it('should render action buttons for rich toasts', () => {
    useToastStore.setState({
      toasts: [
        {
          id: 'test-1',
          message: notice('With actions'),
          type: 'info',
          duration: 0,
          actions: [
            { label: 'Undo', onClick: vi.fn() },
            { label: 'Details', onClick: vi.fn() },
          ],
        },
      ],
    });
    render(<ToastContainer />);
    expect(screen.getByText('Undo')).toBeInTheDocument();
    expect(screen.getByText('Details')).toBeInTheDocument();
  });

  it('should call action onClick and dismiss the toast when action is clicked', () => {
    const onUndo = vi.fn();
    useToastStore.setState({
      toasts: [
        {
          id: 'test-1',
          message: notice('Undo action'),
          type: 'info',
          duration: 0,
          actions: [{ label: 'Undo', onClick: onUndo }],
        },
      ],
    });
    render(<ToastContainer />);

    fireEvent.click(screen.getByText('Undo'));
    expect(onUndo).toHaveBeenCalledOnce();

    expect(screen.getByTestId('toast-info')).toHaveAttribute('data-toast-phase', 'exiting');
    finishToastExit();
    expect(screen.queryByText(notice('Undo action'))).not.toBeInTheDocument();
  });

  it('should run rich-toast actions without relying on surface dismissal', () => {
    const onDetails = vi.fn();
    useToastStore.setState({
      toasts: [
        {
          id: 'test-1',
          message: notice('With safe actions'),
          type: 'info',
          duration: 0,
          dismissOn: 'surface',
          actions: [{ label: 'Details', onClick: onDetails }],
        },
      ],
    });
    render(<ToastContainer />);

    fireEvent.click(screen.getByText('Details'));
    expect(onDetails).toHaveBeenCalledOnce();
    expect(screen.getByTestId('toast-info')).toHaveAttribute('data-toast-phase', 'exiting');
    finishToastExit();
    expect(screen.queryByText(notice('With safe actions'))).not.toBeInTheDocument();
  });

  it('captures clicks on the toast surface while the empty container stays pass-through', () => {
    useToastStore.setState({
      toasts: [
        {
          id: 'test-1',
          message: notice('Interactive toast'),
          type: 'info',
          duration: 0,
          dismissOn: 'surface',
          actions: [{ label: 'Details', onClick: vi.fn() }],
        },
      ],
    });
    render(<ToastContainer />);

    expect(screen.getByTestId('toast-container')).toHaveClass('pointer-events-none');
    expect(screen.getByTestId('toast-info')).toHaveClass('pointer-events-auto');
    expect(screen.getByTestId('toast-dismiss')).toHaveClass('pointer-events-auto');
    expect(screen.getByRole('button', { name: 'Details' })).toHaveClass('pointer-events-auto');
    expect(screen.getByTestId('toast-dismiss-hint')).toHaveClass('pointer-events-none');
  });

  it('should not render action section when toast has no actions', () => {
    useToastStore.setState({
      toasts: [{ id: 'test-1', message: notice('No actions'), type: 'info', duration: 0 }],
    });
    render(<ToastContainer />);
    const toast = screen.getByTestId('toast-info');

    expect(toast.children).toHaveLength(1);
  });

  it('should not render action section when actions array is empty', () => {
    useToastStore.setState({
      toasts: [
        { id: 'test-1', message: notice('Empty actions'), type: 'info', duration: 0, actions: [] },
      ],
    });
    render(<ToastContainer />);
    const toast = screen.getByTestId('toast-info');
    expect(toast.children).toHaveLength(1);
  });

  it('should have the toast-container testid for E2E tests', () => {
    useToastStore.setState({
      toasts: [{ id: 'test-1', message: notice('Test'), type: 'info', duration: 0 }],
    });
    render(<ToastContainer />);
    expect(screen.getByTestId('toast-container')).toBeInTheDocument();
  });

  it('keeps the base toast class free of backdrop-blur', () => {
    expect(TOAST_BASE_CLASS_NAME).not.toContain('backdrop-blur');
  });

  it('keeps toast surfaces intrinsic-width and right-aligned within the viewport cap', () => {
    useToastStore.setState({
      toasts: [{ id: 'test-1', message: notice('Compact toast'), type: 'success', duration: 0 }],
    });
    render(<ToastContainer />);

    const stackItem = screen.getByTestId('toast-stack-item');
    expect(stackItem.firstElementChild).toHaveClass('justify-self-end');
    expect(stackItem.firstElementChild).toHaveClass('max-w-full');
    expect(screen.getByTestId('toast-container')).toHaveClass('w-[min(calc(100vw-2rem),24rem)]');
  });
});

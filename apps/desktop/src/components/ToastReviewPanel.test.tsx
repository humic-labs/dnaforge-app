import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { ToastContainer } from './ToastContainer';
import { ToastReviewPanel } from './ToastReviewPanel';
import { TOAST_REVIEW_ENTRIES } from '../stores/toast-definitions';
import { useToastStore, TOAST_DISMISS_REMOVE_DELAY_MS } from '../stores/toast-store';

describe('toast review using the real catalog, store and stack', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useToastStore.getState().clearToasts();
  });
  afterEach(() => {
    act(() => useToastStore.getState().clearToasts());
    vi.useRealTimers();
  });

  it('can render every defined notification and variant with its actual policy', () => {
    render(
      <>
        <ToastReviewPanel />
        <div data-testid="toast-review-test-stack">
          <ToastContainer />
        </div>
      </>
    );
    const notification = screen.getByLabelText('Toast notification');
    const show = screen.getByTestId('toast-review-show');
    const next = screen.getByTestId('toast-review-next');
    const stack = within(screen.getByTestId('toast-review-test-stack'));
    expect(Array.from(notification.querySelectorAll('option'), (option) => option.value)).toEqual(
      TOAST_REVIEW_ENTRIES.map((entry) => entry.id)
    );
    for (const [index, entry] of TOAST_REVIEW_ENTRIES.entries()) {
      if (index === 0) {
        fireEvent.change(notification, {
          target: { value: entry.id },
        });
        fireEvent.click(show);
      } else {
        fireEvent.click(next);
      }
      const toast = useToastStore.getState().toasts.find((t) => t.preview)!;
      expect(toast).toMatchObject({
        definition: entry.definition,
        variant: entry.variant,
        message: entry.message,
        duration: entry.duration,
        type: entry.type,
        dismissOn: entry.dismissOn,
      });
      expect(stack.queryByTestId('toast-countdown') !== null).toBe(entry.duration > 0);
      expect(stack.queryByTestId('toast-countdown-bar')).toBeNull();
      expect(stack.queryByTestId('toast-countdown-track')).toBeNull();
      expect(toast.actions?.map((a) => a.label)).toEqual(entry.actionLabels);
    }
    expect(screen.getByTestId('toast-review-progress')).toHaveTextContent(
      `${TOAST_REVIEW_ENTRIES.length} of ${TOAST_REVIEW_ENTRIES.length}`
    );
  }, 30_000);

  it('pauses the actual countdown while interacting, then expires after the remaining time', () => {
    render(
      <>
        <ToastReviewPanel />
        <ToastContainer />
      </>
    );
    fireEvent.click(screen.getByTestId('toast-review-show'));
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.getByTestId('toast-countdown')).toHaveAttribute('data-remaining-ms', '5000');
    fireEvent.mouseEnter(screen.getByTestId('toast-info'));
    act(() => vi.advanceTimersByTime(30000));
    expect(screen.getByTestId('toast-countdown')).toHaveTextContent('Paused');
    expect(screen.getByTestId('toast-countdown')).toHaveAttribute('data-remaining-ms', '5000');
    fireEvent.mouseLeave(screen.getByTestId('toast-info'));
    act(() => vi.advanceTimersByTime(5000 + TOAST_DISMISS_REMOVE_DELAY_MS));
    expect(screen.queryByTestId('toast-info')).toBeNull();
  });

  it('offers a working inline dismissal control without changing body-click behavior', () => {
    render(<ToastContainer />);
    act(() => useToastStore.getState().addRichToast({ definition: 'update-current' }));
    fireEvent.click(screen.getByText('DNAForge is up to date (v9.9.9).'));
    expect(screen.getByTestId('toast-info')).toHaveAttribute('data-toast-phase', 'visible');
    const countdown = screen.getByTestId('toast-countdown');
    expect(countdown).toHaveTextContent('Click to dismiss');
    expect(countdown).toHaveTextContent('4s');
    fireEvent.click(screen.getByTestId('toast-dismiss-hint'));
    act(() => vi.advanceTimersByTime(TOAST_DISMISS_REMOVE_DELAY_MS));
    expect(screen.queryByTestId('toast-info')).toBeNull();
  });

  it('demonstrates persistent restart actions without touching production prompts or invoking installation', () => {
    useToastStore
      .getState()
      .addRichToast({ definition: 'update-ready', message: 'Real restart prompt', key: 'real' });
    render(
      <>
        <ToastReviewPanel />
        <ToastContainer />
      </>
    );
    fireEvent.change(screen.getByLabelText('Toast notification'), {
      target: { value: 'update-ready/default' },
    });
    fireEvent.click(screen.getByTestId('toast-review-show'));
    act(() => vi.advanceTimersByTime(60000));
    expect(screen.queryByTestId('toast-countdown')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Restart now' }));
    expect(screen.getByTestId('toast-review-action')).toHaveTextContent(
      'Demonstrated “Restart now”.'
    );
    expect(useToastStore.getState().toasts.find((t) => t.key === 'real')?.phase).toBe('visible');
  });
});

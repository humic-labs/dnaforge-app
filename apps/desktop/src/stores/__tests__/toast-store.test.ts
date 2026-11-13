// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { userMessageWithValues, userMessageValue } from '@waypoint/user-messages';
import { TOAST_DISMISS_REMOVE_DELAY_MS, useToastStore } from '../toast-store';

const notice = (name: string) =>
  userMessageWithValues('notice.opened-value', { value0: userMessageValue(name) });

describe('toast-store', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useToastStore.getState().clearToasts();
  });

  afterEach(() => {
    useToastStore.getState().clearToasts();
    vi.useRealTimers();
  });

  it('should add a toast with default type and duration', () => {
    useToastStore.getState().addToast(notice('Hello'));
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toBe(notice('Hello'));
    expect(toasts[0].type).toBe('info');
    expect(toasts[0].duration).toBe(4000);
  });

  it('should add a toast with custom type', () => {
    useToastStore.getState().addToast(notice('Error!'), 'error');
    expect(useToastStore.getState().toasts[0].type).toBe('error');
  });

  it('should return the toast id', () => {
    const id = useToastStore.getState().addToast(notice('Hello'));
    expect(id).toMatch(/^toast-\d+$/);
  });

  it('should auto-dismiss after duration', () => {
    useToastStore.getState().addToast(notice('Bye'), 'info', 2000);
    expect(useToastStore.getState().toasts).toHaveLength(1);

    vi.advanceTimersByTime(1999);
    expect(useToastStore.getState().toasts).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(useToastStore.getState().toasts).toHaveLength(1);
    expect(useToastStore.getState().toasts[0].phase).toBe('exiting');

    vi.advanceTimersByTime(TOAST_DISMISS_REMOVE_DELAY_MS);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('should NOT auto-dismiss when duration is 0 (persistent)', () => {
    useToastStore.getState().addToast(notice('Sticky'), 'info', 0);
    vi.advanceTimersByTime(60000);
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });

  it('should stack multiple toasts', () => {
    useToastStore.getState().addToast(notice('First'));
    useToastStore.getState().addToast(notice('Second'));
    useToastStore.getState().addToast(notice('Third'));
    expect(useToastStore.getState().toasts).toHaveLength(3);
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual([
      notice('First'),
      notice('Second'),
      notice('Third'),
    ]);
  });

  it('should auto-dismiss toasts independently', () => {
    useToastStore.getState().addToast(notice('Short'), 'info', 1000);
    useToastStore.getState().addToast(notice('Long'), 'info', 5000);

    vi.advanceTimersByTime(1000);
    const remaining = useToastStore.getState().toasts;
    expect(remaining).toHaveLength(2);
    expect(remaining[0].message).toBe(notice('Short'));
    expect(remaining[0].phase).toBe('exiting');
    expect(remaining[1].message).toBe(notice('Long'));

    vi.advanceTimersByTime(TOAST_DISMISS_REMOVE_DELAY_MS);
    expect(useToastStore.getState().toasts).toHaveLength(1);
    expect(useToastStore.getState().toasts[0].message).toBe(notice('Long'));

    vi.advanceTimersByTime(5000 - 1000 - TOAST_DISMISS_REMOVE_DELAY_MS);
    expect(useToastStore.getState().toasts).toHaveLength(1);
    expect(useToastStore.getState().toasts[0].phase).toBe('exiting');

    vi.advanceTimersByTime(TOAST_DISMISS_REMOVE_DELAY_MS);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('should add a rich toast with actions', () => {
    const onClick = vi.fn();
    useToastStore.getState().addRichToast({
      message: notice('Rich toast'),
      type: 'warning',
      duration: 0,
      actions: [{ label: 'Undo', onClick }],
    });

    const toast = useToastStore.getState().toasts[0];
    expect(toast.message).toBe(notice('Rich toast'));
    expect(toast.type).toBe('warning');
    expect(toast.actions).toHaveLength(1);
    expect(toast.actions![0].label).toBe('Undo');
  });

  it('should return the toast id from addRichToast', () => {
    const id = useToastStore.getState().addRichToast({
      message: notice('Rich'),
      type: 'info',
    });
    expect(id).toMatch(/^toast-\d+$/);
  });

  it('should default to 4000ms duration for rich toasts', () => {
    useToastStore.getState().addRichToast({ message: notice('Auto'), type: 'info' });
    expect(useToastStore.getState().toasts).toHaveLength(1);
    expect(useToastStore.getState().toasts[0].duration).toBe(4000);

    vi.advanceTimersByTime(4000);
    expect(useToastStore.getState().toasts).toHaveLength(1);
    expect(useToastStore.getState().toasts[0].phase).toBe('exiting');

    vi.advanceTimersByTime(TOAST_DISMISS_REMOVE_DELAY_MS);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('should mark a toast exiting before removing it on dismissToast', () => {
    const id = useToastStore.getState().addToast(notice('Dismiss me'), 'info', 0);

    useToastStore.getState().dismissToast(id);
    expect(useToastStore.getState().toasts[0].phase).toBe('exiting');

    vi.advanceTimersByTime(TOAST_DISMISS_REMOVE_DELAY_MS);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('should call a rich toast dismiss callback once when dismissal starts', () => {
    const onDismiss = vi.fn();
    const id = useToastStore.getState().addRichToast({
      message: notice('Dismiss callback'),
      type: 'info',
      duration: 0,
      onDismiss,
    });

    useToastStore.getState().dismissToast(id);
    useToastStore.getState().dismissToast(id);

    expect(onDismiss).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(TOAST_DISMISS_REMOVE_DELAY_MS);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('should preserve the rich-toast surface dismissal policy when requested', () => {
    useToastStore.getState().addRichToast({
      message: notice('Surface dismiss'),
      type: 'info',
      duration: 0,
      dismissOn: 'surface',
    });

    expect(useToastStore.getState().toasts[0].dismissOn).toBe('surface');
  });

  it('should support persistent rich toasts (duration: 0)', () => {
    useToastStore.getState().addRichToast({
      message: notice('Persistent'),
      type: 'info',
      duration: 0,
    });

    vi.advanceTimersByTime(60000);
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });

  it('should remove a specific toast by id', () => {
    const id1 = useToastStore.getState().addToast(notice('First'), 'info', 0);
    useToastStore.getState().addToast(notice('Second'), 'info', 0);

    useToastStore.getState().removeToast(id1);
    const remaining = useToastStore.getState().toasts;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].message).toBe(notice('Second'));
  });

  it('should no-op when removing a non-existent id', () => {
    useToastStore.getState().addToast(notice('Exists'), 'info', 0);
    useToastStore.getState().removeToast('toast-nonexistent');
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });

  it('should support all four toast types', () => {
    const types = ['info', 'success', 'warning', 'error'] as const;
    for (const type of types) {
      useToastStore.getState().addToast(`Type: ${type}`, type, 0);
    }
    expect(useToastStore.getState().toasts).toHaveLength(4);
    expect(useToastStore.getState().toasts.map((t) => t.type)).toEqual(types);
  });
});

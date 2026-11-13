// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { userMessageWithValues, userMessageValue } from '@waypoint/user-messages';
import { TOAST_DISMISS_REMOVE_DELAY_MS, useToastStore } from './toast-store';

const notice = (name: string) =>
  userMessageWithValues('notice.opened-value', { value0: userMessageValue(name) });

describe('useToastStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useToastStore.getState().clearToasts();
  });

  afterEach(() => {
    useToastStore.getState().clearToasts();
    vi.useRealTimers();
  });

  it('starts with empty toasts', () => {
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('addToast adds a toast with defaults (info, 4000ms)', () => {
    useToastStore.getState().addToast(notice('Hello'));
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toBe(notice('Hello'));
    expect(toasts[0].type).toBe('info');
    expect(toasts[0].duration).toBe(4000);
    expect(toasts[0].id).toMatch(/^toast-/);
  });

  it('addToast respects custom type and duration', () => {
    useToastStore.getState().addToast(notice('Error!'), 'error', 8000);
    const toast = useToastStore.getState().toasts[0];
    expect(toast.type).toBe('error');
    expect(toast.duration).toBe(8000);
  });

  it('multiple toasts stack', () => {
    useToastStore.getState().addToast(notice('First'));
    useToastStore.getState().addToast(notice('Second'));
    expect(useToastStore.getState().toasts).toHaveLength(2);
  });

  it('removeToast removes by ID', () => {
    useToastStore.getState().addToast(notice('Keep'));
    useToastStore.getState().addToast(notice('Remove'));
    const toasts = useToastStore.getState().toasts;
    const removeId = toasts[1].id;
    useToastStore.getState().removeToast(removeId);
    expect(useToastStore.getState().toasts).toHaveLength(1);
    expect(useToastStore.getState().toasts[0].message).toBe(notice('Keep'));
  });

  it('auto-dismisses after duration', () => {
    useToastStore.getState().addToast(notice('Temporary'), 'info', 3000);
    expect(useToastStore.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(3000);
    expect(useToastStore.getState().toasts).toHaveLength(1);
    expect(useToastStore.getState().toasts[0].phase).toBe('exiting');
    vi.advanceTimersByTime(TOAST_DISMISS_REMOVE_DELAY_MS);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('dismissToast fades a toast before removal', () => {
    const id = useToastStore.getState().addToast(notice('Dismiss'), 'info', 0);

    useToastStore.getState().dismissToast(id);
    expect(useToastStore.getState().toasts).toHaveLength(1);
    expect(useToastStore.getState().toasts[0].phase).toBe('exiting');

    vi.advanceTimersByTime(TOAST_DISMISS_REMOVE_DELAY_MS);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('does not auto-dismiss when duration is 0', () => {
    useToastStore.getState().addToast(notice('Permanent'), 'info', 0);
    vi.advanceTimersByTime(10000);
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });
});

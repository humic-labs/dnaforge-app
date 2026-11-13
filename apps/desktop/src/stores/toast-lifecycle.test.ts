// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { userMessageWithValues, userMessageValue } from '@waypoint/user-messages';
import { TOAST_DISMISS_REMOVE_DELAY_MS, useToastStore } from './toast-store';

const notice = (name: string) =>
  userMessageWithValues('notice.opened-value', { value0: userMessageValue(name) });

describe('catalog toast lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useToastStore.getState().clearToasts();
  });
  afterEach(() => {
    useToastStore.getState().clearToasts();
    vi.useRealTimers();
  });

  it('uses the shared 10 second post-update policy and deadline', () => {
    const started = Date.now();
    useToastStore.getState().addRichToast({
      definition: 'post-update',
      message: notice('Updated to v9.9.9. See what changed.'),
    });
    expect(useToastStore.getState().toasts[0]).toMatchObject({
      definition: 'post-update',
      duration: 10_000,
      expiresAt: started + 10_000,
      dismissOn: 'surface',
    });
    vi.advanceTimersByTime(9999);
    expect(useToastStore.getState().toasts[0].phase).toBe('visible');
    vi.advanceTimersByTime(1);
    expect(useToastStore.getState().toasts[0].phase).toBe('exiting');
    vi.advanceTimersByTime(TOAST_DISMISS_REMOVE_DELAY_MS);
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('cancels automatic timers when a toast is removed or cleared', () => {
    const id = useToastStore.getState().addToast(notice('Temporary'));
    expect(vi.getTimerCount()).toBe(1);
    useToastStore.getState().removeToast(id);
    expect(vi.getTimerCount()).toBe(0);
    useToastStore.getState().addToast(notice('Temporary'));
    useToastStore.getState().clearToasts();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps hover and keyboard focus paused independently and resumes the remainder', () => {
    const store = useToastStore.getState();
    const id = store.addToast(notice('Temporary'));
    vi.advanceTimersByTime(1000);
    store.pauseToast(id, 'pointer');
    store.pauseToast(id, 'focus');
    expect(useToastStore.getState().toasts[0].remainingMs).toBe(3000);
    vi.advanceTimersByTime(10_000);
    store.resumeToast(id, 'pointer');
    vi.advanceTimersByTime(10_000);
    expect(useToastStore.getState().toasts[0].phase).toBe('visible');
    store.resumeToast(id, 'focus');
    vi.advanceTimersByTime(2999);
    expect(useToastStore.getState().toasts[0].phase).toBe('visible');
    vi.advanceTimersByTime(1);
    expect(useToastStore.getState().toasts[0].phase).toBe('exiting');
  });

  it.each([
    'primer-creation-tab-created-primer-example',
    'primer-creation-tab-updated-primer-example',
  ] as const)('finishes %s even when the pointer remains over the next control', (definition) => {
    const store = useToastStore.getState();
    const id = store.addRichToast({ definition });
    store.pauseToast(id, 'pointer');
    vi.advanceTimersByTime(4000);
    expect(useToastStore.getState().toasts[0].phase).toBe('exiting');
    vi.advanceTimersByTime(TOAST_DISMISS_REMOVE_DELAY_MS);
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('does not schedule countdowns for persistent catalog prompts', () => {
    useToastStore.getState().addRichToast({
      definition: 'update-ready',
      message: notice('Restart to apply.'),
      key: '9.9.9',
    });
    expect(useToastStore.getState().toasts[0]).toMatchObject({ duration: 0 });
    expect(useToastStore.getState().toasts[0].expiresAt).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not let caller fields override a selected catalog policy', () => {
    useToastStore.getState().addRichToast({
      definition: 'post-update',
      message: notice('A version update.'),
      type: 'error',
      duration: 1,
      dismissOn: 'control',
      closeButton: false,
      pauseOnInteraction: false,
      actionDismisses: false,
    });
    expect(useToastStore.getState().toasts[0]).toMatchObject({
      type: 'info',
      duration: 10_000,
      dismissOn: 'surface',
      closeButton: true,
      pauseOnInteraction: true,
      actionDismisses: true,
    });
  });

  it('executes an action and a reentrant dismissal callback once, with one exit timer', () => {
    const store = useToastStore.getState();
    const action = vi.fn();
    const onDismiss = vi.fn(() => store.dismissToast(id));
    const id = store.addRichToast({
      definition: 'post-update',
      actions: [{ label: "What's new", onClick: action }],
      onDismiss,
    });
    store.invokeToastAction(id, 0);
    store.invokeToastAction(id, 0);
    store.dismissToast(id);
    expect(action).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(TOAST_DISMISS_REMOVE_DELAY_MS);
    expect(useToastStore.getState().toasts).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not reshow the same update version after dismissal and replaces older versions', () => {
    const store = useToastStore.getState();
    const first = store.addRichToast({
      definition: 'update-ready',
      message: notice('Version one.'),
      key: '1',
    });
    expect(
      store.addRichToast({ definition: 'update-ready', message: notice('Version one.'), key: '1' })
    ).toBe(first);
    store.dismissToast(first);
    vi.advanceTimersByTime(TOAST_DISMISS_REMOVE_DELAY_MS);
    store.addRichToast({ definition: 'update-ready', message: notice('Version one.'), key: '1' });
    expect(useToastStore.getState().toasts).toEqual([]);
    store.addRichToast({ definition: 'update-ready', message: notice('Version two.'), key: '2' });
    store.addRichToast({ definition: 'update-ready', message: notice('Version three.'), key: '3' });
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual([
      notice('Version three.'),
    ]);
  });
});

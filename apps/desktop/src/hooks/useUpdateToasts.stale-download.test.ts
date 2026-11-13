// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const listeners = new Map<string, (payload: unknown) => void>();
const install = vi.fn().mockResolvedValue({ status: 'started' });
vi.mock('../platform', () => ({
  platform: () => ({
    on: (channel: string, listener: (payload: unknown) => void) => {
      listeners.set(channel, listener);
      return () => listeners.delete(channel);
    },
    update: { install: () => install(), retry: vi.fn(), checkManual: vi.fn() },
  }),
}));

import { useUpdateToasts } from './useUpdateToasts';
import { useToastStore } from '../stores/toast-store';

afterEach(() => {
  useToastStore.getState().clearToasts();
  listeners.clear();
});

it(' restores a persistent restart reminder after the original ready notice was dismissed', async () => {
  renderHook(() => useUpdateToasts());
  act(() => listeners.get('update:downloaded')!({ version: '2.1.0' }));
  const initial = useToastStore.getState().toasts[0];
  act(() => useToastStore.getState().removeToast(initial.id));
  expect(useToastStore.getState().toasts).toHaveLength(0);

  act(() => listeners.get('update:downloaded')!({ version: '2.1.0', restartRequired: true }));
  expect(useToastStore.getState().toasts).toHaveLength(1);
  const reminder = useToastStore.getState().toasts[0];
  expect(reminder.duration).toBe(0);
  expect(reminder.actions?.[0].label).toBe('Restart now');
  for (let i = 0; i < 10; i += 1) {
    act(() => listeners.get('update:downloaded')!({ version: '2.1.0', restartRequired: true }));
  }
  expect(useToastStore.getState().toasts).toHaveLength(1);
  await act(async () => reminder.actions![0].onClick());
  expect(install).toHaveBeenCalledTimes(1);
});

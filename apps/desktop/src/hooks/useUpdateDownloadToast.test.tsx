// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastContainer } from '../components/ToastContainer';
import { useToastStore } from '../stores/toast-store';
import { useUpdateToasts } from './useUpdateToasts';

const listeners = new Map<string, (payload: unknown) => void>();
vi.mock('../platform', () => ({
  platform: () => ({
    on: (channel: string, listener: (payload: unknown) => void) => {
      listeners.set(channel, listener);
      return () => listeners.delete(channel);
    },
  }),
}));

function Harness() {
  useUpdateToasts();
  return <ToastContainer />;
}

function emit(channel: string, payload: unknown) {
  act(() => listeners.get(channel)?.(payload));
}

beforeEach(() => {
  vi.useFakeTimers();
  useToastStore.getState().clearToasts();
  listeners.clear();
});
afterEach(() => {
  cleanup();
  useToastStore.getState().clearToasts();
  vi.useRealTimers();
});

describe('manual update download feedback', () => {
  it('shows a persistent progress bar immediately and updates the same notification', () => {
    render(<Harness />);
    emit('update:available', { version: '9.9.9', isManual: true });
    expect(screen.getByText('Download in progress')).toBeTruthy();
    const bar = screen.getByRole('progressbar', { name: 'Update download progress' });
    expect(bar.getAttribute('aria-valuenow')).toBe('0');
    const id = useToastStore.getState().toasts[0].id;
    emit('update:progress', { percent: 42.4, bytesPerSecond: 1024 });
    expect(bar.getAttribute('aria-valuenow')).toBe('42');
    expect(screen.getByText('42%')).toBeTruthy();
    emit('update:available', { version: '9.9.9', isManual: true });
    expect(useToastStore.getState().toasts).toHaveLength(1);
    expect(useToastStore.getState().toasts[0].id).toBe(id);
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByRole('progressbar')).toBe(bar);
    emit('update:progress', { percent: 100, bytesPerSecond: 0 });
    expect(bar.getAttribute('aria-valuenow')).toBe('100');
    expect(screen.queryByRole('button', { name: 'Restart now' })).toBeNull();
    emit('update:downloaded', { version: '9.9.9' });
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getByRole('button', { name: 'Restart now' })).toBeTruthy();
    emit('update:progress', { percent: 90, bytesPerSecond: 0 });
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('replaces progress with the download error and removes stale progress updates', () => {
    render(<Harness />);
    emit('update:available', { version: '9.9.9', isManual: true });
    emit('update:progress', { percent: 35, bytesPerSecond: 1024 });
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('35');
    emit('update:error', { stage: 'download', isManual: true });
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getByText('Update download was interrupted.')).toBeTruthy();
    emit('update:progress', { percent: 60, bytesPerSecond: 0 });
    expect(useToastStore.getState().toasts).toHaveLength(1);
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('keeps background downloads quiet until a manual check joins the download', () => {
    render(<Harness />);
    emit('update:available', { version: '9.9.9', isManual: false });
    emit('update:progress', { percent: 23, bytesPerSecond: 1024 });
    expect(screen.queryByRole('progressbar')).toBeNull();
    emit('update:available', { version: '9.9.9', isManual: true });
    emit('update:progress', { percent: 23, bytesPerSecond: 1024 });
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('23');
  });

  it('keeps dismissed progress quiet and restores feedback on another manual check', () => {
    render(<Harness />);
    emit('update:available', { version: '9.9.9', isManual: true });
    act(() => screen.getByRole('button', { name: 'Dismiss notification' }).click());
    act(() => vi.advanceTimersByTime(1000));
    emit('update:progress', { percent: 23, bytesPerSecond: 1024 });
    expect(screen.queryByRole('progressbar')).toBeNull();
    emit('update:available', { version: '9.9.9', isManual: true });
    expect(screen.getByRole('progressbar')).toBeTruthy();
  });

  it('clamps percentages and ignores non-finite progress', () => {
    render(<Harness />);
    emit('update:available', { version: '9.9.9', isManual: true });
    const bar = screen.getByRole('progressbar');
    for (const [percent, expected] of [
      [-3, '0'],
      [110, '100'],
      [NaN, '100'],
      [Infinity, '100'],
    ]) {
      emit('update:progress', { percent, bytesPerSecond: 0 });
      expect(bar.getAttribute('aria-valuenow')).toBe(expected);
    }
  });

  it('confirms up-to-date manual checks with one distinct toast', () => {
    render(<Harness />);
    emit('update:error', { stage: 'check', reason: 'network', isManual: true });
    emit('update:no-update', { version: '1.2.3' });
    emit('update:no-update', { version: '1.2.3' });
    expect(useToastStore.getState().toasts).toHaveLength(1);
    const toast = screen.getByTestId('toast-info');
    expect(within(toast).getByText('DNAForge is up to date (v1.2.3).')).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });
});

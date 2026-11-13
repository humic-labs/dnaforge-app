import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { entityNavigationUrl } from '../shared/entity-navigation';

const state = vi.hoisted(() => ({
  open: vi.fn(),
  subscribe: vi.fn(),
  pending: vi.fn(),
}));
vi.mock('../services/entity-navigation', () => ({ openEntityNavigationTarget: state.open }));

import { useEntityNavigation } from './use-entity-navigation';
import { useToastStore } from '../stores/toast-store';

let previousApi: PropertyDescriptor | undefined;
beforeEach(() => {
  previousApi = Object.getOwnPropertyDescriptor(window, 'electronAPI');
  state.open.mockReset().mockResolvedValue({});
  state.subscribe.mockReset().mockReturnValue(() => {});
  state.pending.mockReset().mockResolvedValue([]);
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { entityNavigation: { onOpen: state.subscribe, takePending: state.pending } },
  });
  useToastStore.getState().clearToasts();
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  if (previousApi) Object.defineProperty(window, 'electronAPI', previousApi);
  else Reflect.deleteProperty(window, 'electronAPI');
  useToastStore.getState().clearToasts();
});

describe('app entity hyperlink entry point', () => {
  it('routes a nested anchor click through the same exact target resolver as OS delivery', async () => {
    renderHook(() => useEntityNavigation(true));
    await waitFor(() => expect(state.subscribe).toHaveBeenCalledOnce());
    const target = { entityId: 'sequence-id', projectId: 'owner-id', referenceId: 'selection-id' };
    const anchor = document.createElement('a');
    anchor.href = entityNavigationUrl(target, 'dnaforge-dev-1827');
    const label = document.createElement('span');
    label.textContent = 'Pasted source region';
    anchor.append(label);
    document.body.append(anchor);
    const otherHandler = vi.fn();
    anchor.addEventListener('click', otherHandler);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    act(() => label.dispatchEvent(click));
    await waitFor(() => expect(state.open).toHaveBeenCalledWith(target));
    expect(click.defaultPrevented).toBe(true);
    expect(otherHandler).not.toHaveBeenCalled();
    const receive = state.subscribe.mock.calls[0][0];
    await act(async () => receive([target]));
    expect(state.open).toHaveBeenCalledTimes(2);
    expect(state.open.mock.calls[1]).toEqual([target]);
  });

  it('refuses malformed native targets and preserves ordinary external links', async () => {
    renderHook(() => useEntityNavigation(true));
    await waitFor(() => expect(state.subscribe).toHaveBeenCalledOnce());
    const anchor = document.createElement('a');
    document.body.append(anchor);
    anchor.href = 'dnaforge://entity/open?entityId=a&entityId=b';
    const invalid = new MouseEvent('click', { bubbles: true, cancelable: true });
    act(() => anchor.dispatchEvent(invalid));
    expect(invalid.defaultPrevented).toBe(true);
    expect(state.open).not.toHaveBeenCalled();
    expect(
      useToastStore.getState().toasts.some((toast) => /invalid.*entity link/i.test(toast.message))
    ).toBe(true);
    anchor.href = 'https://example.test/science';
    const external = new MouseEvent('click', { bubbles: true, cancelable: true });
    let preventedBeforeFallback: boolean | undefined;
    anchor.addEventListener(
      'click',
      (event) => {
        preventedBeforeFallback = event.defaultPrevented;
        event.preventDefault();
      },
      { once: true }
    );
    act(() => anchor.dispatchEvent(external));
    expect(preventedBeforeFallback).toBe(false);
    expect(state.open).not.toHaveBeenCalled();
  });
});

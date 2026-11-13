/** @vitest-environment jsdom */

import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NotebookSyncStatus } from './NotebookSyncStatus';

afterEach(cleanup);

it('retries an unreadable file without authorizing replacement of editor text', () => {
  const onReload = vi.fn();
  const onRetry = vi.fn();
  const onKeepLocal = vi.fn();
  render(
    <NotebookSyncStatus
      state="reload-unavailable"
      onReload={onReload}
      onRetry={onRetry}
      onKeepLocal={onKeepLocal}
    />
  );

  fireEvent.click(screen.getByText('Retry', { selector: 'button' }));

  expect(onRetry).toHaveBeenCalledOnce();
  expect(onReload).not.toHaveBeenCalled();
  expect(onKeepLocal).not.toHaveBeenCalled();
});

it('requires the explicit reload choice before replacing conflicting editor text', () => {
  const onReload = vi.fn();
  const onRetry = vi.fn();
  const onKeepLocal = vi.fn();
  render(
    <NotebookSyncStatus
      state="conflict"
      onReload={onReload}
      onRetry={onRetry}
      onKeepLocal={onKeepLocal}
    />
  );

  fireEvent.click(screen.getByText('Reload from file', { selector: 'button' }));
  expect(onReload).toHaveBeenCalledOnce();
  expect(onRetry).not.toHaveBeenCalled();
  expect(onKeepLocal).not.toHaveBeenCalled();

  fireEvent.click(screen.getByText('Keep my edits', { selector: 'button' }));
  expect(onKeepLocal).toHaveBeenCalledOnce();
  expect(onReload).toHaveBeenCalledOnce();
});

import { userMessage } from '@waypoint/user-messages';
// @vitest-environment node

import { describe, it, expect, beforeEach } from 'vitest';
import { confirmDialog, promptDialog, useConfirmDialogStore } from './confirm-dialog-store';

describe('confirm-dialog-store', () => {
  beforeEach(() => {
    useConfirmDialogStore.setState({ request: null });
  });

  it('opens a request and resolves true when confirmed', async () => {
    const promise = confirmDialog({
      title: 'Move to Trash',
      message: userMessage('operation.confirm'),
    });
    const req = useConfirmDialogStore.getState().request;
    expect(req?.title).toBe('Move to Trash');
    useConfirmDialogStore.getState().resolveCurrent(true);
    expect(await promise).toBe(true);
    expect(useConfirmDialogStore.getState().request).toBeNull();
  });

  it('resolves false when cancelled / dismissed', async () => {
    const promise = confirmDialog({ title: 'Archive', message: userMessage('operation.confirm') });
    useConfirmDialogStore.getState().resolveCurrent(false);
    expect(await promise).toBe(false);
  });

  it('a new prompt supersedes a pending one, and only a confirmed text resolves', async () => {
    const first = promptDialog({
      title: userMessage('dialog.unsaved-changes'),
      message: userMessage('operation.confirm'),
      input: { defaultValue: 'x' },
    });
    const second = promptDialog({
      title: userMessage('operation.confirm'),
      message: userMessage('operation.confirm'),
      input: { defaultValue: 'y' },
    });
    expect(await first).toBeNull();
    expect(useConfirmDialogStore.getState().request?.title).toBe(userMessage('operation.confirm'));
    useConfirmDialogStore.getState().resolveCurrent(true, 'Renamed');
    expect(await second).toBe('Renamed');

    const third = promptDialog({
      title: userMessage('operation.attention'),
      message: userMessage('operation.confirm'),
      input: { defaultValue: 'z' },
    });
    useConfirmDialogStore.getState().resolveCurrent(true);
    expect(await third).toBeNull();
  });

  it('a new confirm supersedes a pending one (old resolves false)', async () => {
    const first = confirmDialog({
      title: userMessage('dialog.unsaved-changes'),
      message: userMessage('operation.confirm'),
    });
    const second = confirmDialog({
      title: userMessage('operation.confirm'),
      message: userMessage('operation.confirm'),
    });
    expect(await first).toBe(false);
    expect(useConfirmDialogStore.getState().request?.title).toBe(userMessage('operation.confirm'));
    useConfirmDialogStore.getState().resolveCurrent(true);
    expect(await second).toBe(true);
  });

  it('does not open when already aborted and dismisses a pending confirmation on abort', async () => {
    const alreadyStopped = new AbortController();
    alreadyStopped.abort();
    await expect(
      confirmDialog({
        title: userMessage('operation.confirm'),
        message: userMessage('operation.confirm'),
        signal: alreadyStopped.signal,
      })
    ).resolves.toBe(false);
    expect(useConfirmDialogStore.getState().request).toBeNull();

    const pending = new AbortController();
    const decision = confirmDialog({
      title: userMessage('operation.confirm'),
      message: userMessage('operation.confirm'),
      signal: pending.signal,
    });
    expect(useConfirmDialogStore.getState().request?.title).toBe(userMessage('operation.confirm'));

    pending.abort();

    await expect(decision).resolves.toBe(false);
    expect(useConfirmDialogStore.getState().request).toBeNull();
  });
});

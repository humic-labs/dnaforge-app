import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import type { FileDocumentClientFlush } from '../shared/file-document-client-sync';
import { createFileDocumentClientSync } from './file-document-client-sync';

const sent = vi.hoisted(() => vi.fn());
vi.mock('../shared/ipc-contract', () => ({ sendRendererIpc: sent }));

function fixture() {
  sent.mockClear();
  const target = { id: 17, isDestroyed: () => false } as WebContents;
  const sync = createFileDocumentClientSync(
    () => target,
    () => ({ shellReady: true, loadId: 'live' })
  );
  const request = () => sent.mock.calls.at(-1)![2] as FileDocumentClientFlush;
  return { target, sync, request };
}

describe('document flush readiness', () => {
  it('resolves without sending IPC before a live client is shell ready', async () => {
    sent.mockClear();
    const target = { id: 17, isDestroyed: () => false } as WebContents;
    const sync = createFileDocumentClientSync(
      () => target,
      () => ({ shellReady: false, loadId: 'loading' })
    );
    await expect(sync.flush()).resolves.toBeUndefined();
    expect(sent).not.toHaveBeenCalled();
  });

  it('rejects the previous load flush and clears its timer before shell readiness', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let readiness = { shellReady: true, loadId: 'live' };
    const sync = createFileDocumentClientSync(
      () => f.target,
      () => readiness
    );
    try {
      const pending = sync.flush().catch((error: unknown) => error);
      expect(vi.getTimerCount()).toBe(1);
      readiness = { shellReady: false, loadId: 'loading' };
      await expect(sync.flush()).resolves.toBeUndefined();
      expect(await pending).toEqual(new Error('FILE_DOCUMENT_CLIENT_CHANGED'));
      expect(sent).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      sync.close();
      vi.useRealTimers();
    }
  });

  it('refuses a flush without a target', () => {
    const sync = createFileDocumentClientSync(
      () => null,
      () => null
    );
    expect(() => sync.flush()).toThrow(
      'FILE_DOCUMENT_CLIENT_NOT_READY: The editing client has not reached its native synchronization boundary.'
    );
  });

  it('refuses a flush with a destroyed target', () => {
    const target = { id: 17, isDestroyed: () => true } as WebContents;
    const sync = createFileDocumentClientSync(
      () => target,
      () => ({ shellReady: false, loadId: 'loading' })
    );
    expect(() => sync.flush()).toThrow('FILE_DOCUMENT_CLIENT_NOT_READY');
  });
});

describe('document flush disposition', () => {
  it('runs a separate discard drain after a failed synchronization request', async () => {
    const f = fixture();
    const save = f.sync.flush();
    const rejected = expect(save).rejects.toThrow('old edit failed');
    const discard = f.sync.flush('discard');
    expect(sent).toHaveBeenCalledTimes(1);
    expect(
      f.sync.acknowledge(f.target, { ...f.request(), success: false, error: 'old edit failed' })
    ).toBe(true);
    await rejected;
    await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(2));
    expect(f.request().purpose).toBe('discard');
    f.sync.acknowledge(f.target, { ...f.request(), success: true });
    await expect(discard).resolves.toBeUndefined();
    f.sync.close();
  });

  it('does not reuse a successful discard drain as proof that edits were synchronized', async () => {
    const f = fixture();
    const discard = f.sync.flush('discard');
    const save = f.sync.flush();
    f.sync.acknowledge(f.target, { ...f.request(), success: true });
    await discard;
    await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(2));
    expect(f.request().purpose).toBe('synchronize');
    const rejected = expect(save).rejects.toThrow('unsaved edit');
    f.sync.acknowledge(f.target, { ...f.request(), success: false, error: 'unsaved edit' });
    await rejected;
    f.sync.close();
  });

  it('refuses an acknowledgement for the wrong disposition', async () => {
    const f = fixture();
    const discard = f.sync.flush('discard');
    expect(
      f.sync.acknowledge(f.target, { ...f.request(), purpose: 'synchronize', success: true })
    ).toBe(false);
    expect(f.sync.acknowledge(f.target, { ...f.request(), success: true })).toBe(true);
    await discard;
    f.sync.close();
  });
});

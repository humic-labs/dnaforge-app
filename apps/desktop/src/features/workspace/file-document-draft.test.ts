// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { FileDocumentDraft, waitForFileDocumentSaves } from './file-document-draft';

describe('captured native file saves', () => {
  it('coalesces concurrent requests for the same captured revision into one publication', async () => {
    const draft = new FileDocumentDraft('/workspace/coalesced.txt');
    draft.load('original');
    draft.change('saved');
    const blocked = Promise.withResolvers<void>();
    const write = vi
      .fn()
      .mockImplementationOnce(() => blocked.promise)
      .mockResolvedValue(undefined);
    const saves = [draft.save(write), draft.save(write), draft.save(write)];
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    blocked.resolve();
    await Promise.all(saves);
    expect(write).toHaveBeenCalledTimes(1);
    expect(draft.dirty).toBe(false);
  });

  it('orders duplicate-view saves against the bytes published by their admitted predecessor', async () => {
    const first = new FileDocumentDraft('/workspace/duplicate.txt');
    const second = new FileDocumentDraft('/workspace/duplicate.txt');
    first.load('original');
    second.load('original');
    first.change('first');
    second.change('second');
    let disk = 'original';
    const blocked = Promise.withResolvers<void>();
    const write = vi.fn(async (input) => {
      const hash = `sha256:${createHash('sha256').update(disk).digest('hex')}`;
      if (input.expectedContentHash !== hash)
        throw new Error('FILE_CHANGED: disk baseline changed');
      if (input.content === 'first') await blocked.promise;
      disk = input.content;
    });
    const saves = [first.save(write), second.save(write)];
    const finished = Promise.all(saves);
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    blocked.resolve();
    await expect(finished).resolves.toHaveLength(2);
    expect(write.mock.calls.map(([input]) => input.content)).toEqual(['first', 'second']);
    expect(disk).toBe('second');
  });

  it('keeps reopening blocked until the published draft has been retained', async () => {
    const draft = new FileDocumentDraft('/workspace/retained.txt');
    draft.load('original');
    draft.change('saved');
    const retained = Promise.withResolvers<void>();
    const afterPublish = vi.fn(() => retained.promise);
    const save = draft.save(async () => {}, undefined, afterPublish);
    await vi.waitFor(() => expect(afterPublish).toHaveBeenCalledOnce());
    let reopened = false;
    const open = waitForFileDocumentSaves(draft.filePath).then(() => {
      reopened = true;
    });
    await Promise.resolve();
    expect(reopened).toBe(false);
    retained.resolve();
    await Promise.all([save, open]);
    expect(reopened).toBe(true);
  });

  it('refuses an external edit between admitted duplicate-view publications', async () => {
    const first = new FileDocumentDraft('/workspace/external.txt');
    const second = new FileDocumentDraft('/workspace/external.txt');
    first.load('original');
    second.load('original');
    first.change('first');
    second.change('second');
    let disk = 'original';
    const write = vi.fn(async (input) => {
      const hash = `sha256:${createHash('sha256').update(disk).digest('hex')}`;
      if (input.expectedContentHash !== hash)
        throw new Error('FILE_CHANGED: disk baseline changed');
      disk = input.content;
    });
    const saves = Promise.allSettled([
      first.save(write, undefined, async () => {
        disk = 'external';
      }),
      second.save(write),
    ]);
    expect((await saves).map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(disk).toBe('external');
    expect(second.dirty).toBe(true);
    expect(second.persistedContent).toBe('original');
  });

  it('refuses an external-file conflict even when the visible draft is clean', async () => {
    const draft = new FileDocumentDraft('/workspace/clean.txt');
    draft.load('accepted');
    const write = vi.fn().mockRejectedValue(new Error('FILE_CHANGED: external bytes'));
    await expect(draft.save(write)).rejects.toThrow('FILE_CHANGED');
    expect(draft.content).toBe('accepted');
    expect(draft.dirty).toBe(false);
  });
  it('keeps newer edits dirty and saves them against the preceding published bytes', async () => {
    const draft = new FileDocumentDraft('/workspace/example.txt');
    draft.load('original');
    draft.change('first edit');
    let finish!: () => void;
    const write = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          })
      )
      .mockResolvedValue(undefined);
    const first = draft.save(write);
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    draft.change('newer edit');
    finish();
    expect(await first).toMatchObject({ saved: true, dirty: true, content: 'first edit' });
    const firstHash = write.mock.calls[0][0].expectedContentHash;
    await draft.save(write);
    expect(write.mock.calls[1][0]).toMatchObject({ content: 'newer edit' });
    expect(write.mock.calls[1][0].expectedContentHash).not.toBe(firstHash);
    expect(draft.dirty).toBe(false);
  });

  it('retains both the draft and saved baseline after a failed publication', async () => {
    const draft = new FileDocumentDraft('/workspace/failed.txt');
    draft.load('original');
    draft.change('unsaved');
    const revision = draft.revisionId;
    await expect(
      draft.save(async () => {
        throw new Error('FILE_CHANGED: external edit');
      })
    ).rejects.toThrow('FILE_CHANGED');
    expect(draft.content).toBe('unsaved');
    expect(draft.persistedContent).toBe('original');
    expect(draft.diskContent).toBe('original');
    expect(draft.revisionId).toBe(revision);
    expect(draft.dirty).toBe(true);
  });
});

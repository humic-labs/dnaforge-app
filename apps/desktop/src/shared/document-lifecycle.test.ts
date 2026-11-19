import { describe, expect, it, vi } from 'vitest';
import { DocumentLifecycle } from './document-lifecycle';
import { TAB_DOCUMENT_LIFECYCLES, TAB_TYPES } from './tab-kind';

describe('document lifecycle authority', () => {
  it.each(['synchronous', 'asynchronous'] as const)(
    'records the original %s save error and its target once',
    async (mode) => {
      const lifecycle = new DocumentLifecycle();
      const target = { kind: 'file', filePath: '/workspace/notes.txt' } as const;
      const failure = new Error('EACCES: save denied');
      const report = vi.spyOn(console, 'error').mockImplementation(() => {});
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      lifecycle.register({
        readRevision: () => 1,
        target,
        tabId: 'notes-view',
        isDirty: () => true,
        save: () => {
          if (mode === 'synchronous') throw failure;
          return Promise.reject(failure);
        },
      });
      try {
        expect(await lifecycle.save(target, 'notes-view')).toBe(false);
        expect(report).toHaveBeenCalledExactlyOnceWith(
          '[DocumentLifecycle] Save failed:',
          { target, tabId: 'notes-view' },
          failure
        );
        expect(warning).not.toHaveBeenCalled();
      } finally {
        report.mockRestore();
        warning.mockRestore();
      }
    }
  );

  it('records one diagnostic when callers share a rejected save', async () => {
    const lifecycle = new DocumentLifecycle();
    const target = { kind: 'tab', tabId: 'draft-view' } as const;
    const pending = Promise.withResolvers<boolean>();
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    lifecycle.register({
      readRevision: () => 1,
      target,
      isDirty: () => true,
      save: () => pending.promise,
    });
    try {
      const first = lifecycle.save(target);
      const second = lifecycle.save(target);
      pending.reject(new Error('Write failed'));
      expect(await Promise.all([first, second])).toEqual([false, false]);
      expect(report).toHaveBeenCalledTimes(1);
    } finally {
      report.mockRestore();
    }
  });

  it('records an incomplete save without classifying cancellation as an exception', async () => {
    const lifecycle = new DocumentLifecycle();
    const target = { kind: 'tab', tabId: 'cancelled-view' } as const;
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    lifecycle.register({
      readRevision: () => 1,
      target,
      isDirty: () => true,
      save: async () => false,
    });
    try {
      expect(await lifecycle.save(target)).toBe(false);
      expect(warning).toHaveBeenCalledExactlyOnceWith('[DocumentLifecycle] Save not completed:', {
        target,
        tabId: undefined,
        reason: 'owner-returned-false',
      });
      expect(report).not.toHaveBeenCalled();
    } finally {
      report.mockRestore();
      warning.mockRestore();
    }
  });

  it('records a missing save owner with its target', async () => {
    const lifecycle = new DocumentLifecycle();
    const target = { kind: 'tab', tabId: 'missing-view' } as const;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await lifecycle.save(target)).toBe(false);
      expect(warning).toHaveBeenCalledExactlyOnceWith('[DocumentLifecycle] Save not completed:', {
        target,
        tabId: undefined,
        reason: 'owner-not-unique',
        ownerCount: 0,
      });
    } finally {
      warning.mockRestore();
    }
  });

  it('requires an explicit lifecycle for every registered tab kind', () => {
    expect(Object.keys(TAB_DOCUMENT_LIFECYCLES).sort()).toEqual([...TAB_TYPES].sort());
    expect(TAB_DOCUMENT_LIFECYCLES.protein).toBe('editable');
    expect(TAB_DOCUMENT_LIFECYCLES['scientific-document']).toBe('editable');
  });

  it('selects one document view and does not save hidden duplicates', async () => {
    const lifecycle = new DocumentLifecycle();
    const target = { kind: 'file', filePath: '/protocol.json' } as const;
    const hidden = vi.fn(async () => true);
    const visible = vi.fn(async () => true);
    lifecycle.register({
      readRevision: () => 1,
      target,
      tabId: 'hidden',
      isDirty: () => true,
      save: hidden,
    });
    lifecycle.register({
      readRevision: () => 1,
      target,
      tabId: 'visible',
      isDirty: () => true,
      save: visible,
    });
    expect(await lifecycle.save(target, 'visible')).toBe(true);
    expect(visible).toHaveBeenCalledTimes(1);
    expect(hidden).not.toHaveBeenCalled();
    expect(await lifecycle.save(target)).toBe(false);
  });

  it('removing one view does not clear another dirty view', () => {
    const lifecycle = new DocumentLifecycle();
    const target = { kind: 'file', filePath: '/protocol.json' } as const;
    const first = lifecycle.register({
      readRevision: () => 1,
      target,
      tabId: 'first',
      isDirty: () => true,
      save: async () => true,
    });
    lifecycle.register({
      readRevision: () => 1,
      target,
      tabId: 'second',
      isDirty: () => true,
      save: async () => true,
    });
    first.release();
    expect(lifecycle.dirty(target, 'second')).toBe(true);
    expect(lifecycle.dirty(target, 'first')).toBeUndefined();
  });

  it('shares an active save and reports rejection or a missing owner without hanging', async () => {
    const lifecycle = new DocumentLifecycle();
    const target = { kind: 'tab', tabId: 'protein' } as const;
    let finish!: (saved: boolean) => void;
    const save = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        })
    );
    lifecycle.register({
      readRevision: () => 1,
      target,
      tabId: 'protein',
      isDirty: () => true,
      save,
    });
    const first = lifecycle.save(target, 'protein');
    const second = lifecycle.save(target, 'protein');
    await Promise.resolve();
    expect(save).toHaveBeenCalledTimes(1);
    finish(false);
    expect(await first).toBe(false);
    expect(await second).toBe(false);
    expect(await lifecycle.save({ kind: 'tab', tabId: 'missing' })).toBe(false);
    lifecycle.register({
      readRevision: () => 1,
      target: { kind: 'tab', tabId: 'throws' },
      isDirty: () => true,
      save: async () => {
        throw new Error('failed');
      },
    });
    expect(await lifecycle.save({ kind: 'tab', tabId: 'throws' })).toBe(false);
  });

  it('keeps a later edit open and saves it when a second caller requests that revision', async () => {
    const lifecycle = new DocumentLifecycle();
    const target = { kind: 'tab', tabId: 'edited' } as const;
    const firstWrite = Promise.withResolvers<boolean>();
    let revision = 1;
    const writes: number[] = [];
    lifecycle.register({
      target,
      readRevision: () => revision,
      isDirty: () => true,
      save: async () => {
        writes.push(revision);
        return writes.length === 1 ? firstWrite.promise : true;
      },
    });
    const first = lifecycle.save(target);
    await Promise.resolve();
    revision = 2;
    const second = lifecycle.save(target, undefined, 'all');
    const same = lifecycle.save(target);
    firstWrite.resolve(true);
    expect(await Promise.all([first, second, same])).toEqual([false, true, true]);
    expect(writes).toEqual([1, 2]);
  });

  it('refuses a late ordinary acknowledgement after the original owner is replaced', async () => {
    const lifecycle = new DocumentLifecycle();
    const target = { kind: 'tab', tabId: 'reused' } as const;
    const write = Promise.withResolvers<boolean>();
    const owner = { target, readRevision: () => 1, isDirty: () => true, save: () => write.promise };
    const original = lifecycle.register(owner);
    const saved = lifecycle.save(target);
    await Promise.resolve();
    original.release();
    lifecycle.register({ ...owner, isDirty: () => false });
    write.resolve(true);
    expect(await saved).toBe(false);
  });

  it.each([
    [2, false, false],
    [1, true, false],
    [1, false, true],
  ] as const)(
    'checks published revision %s and successor dirty state %s',
    async (publishedRevision, dirty, expected) => {
      const lifecycle = new DocumentLifecycle();
      const target = { kind: 'tab', tabId: 'draft' } as const;
      const write = Promise.withResolvers<{ publishedRevision: number }>();
      const original = lifecycle.register({
        target,
        readRevision: () => 1,
        isDirty: () => true,
        save: () => write.promise,
      });
      const saved = lifecycle.save(target);
      await Promise.resolve();
      original.release();
      lifecycle.register({
        target,
        readRevision: () => 0,
        isDirty: () => dirty,
        save: async () => false,
      });
      write.resolve({ publishedRevision });
      expect(await saved).toBe(expected);
    }
  );

  it.each([
    [2, false, true],
    [2, true, false],
    [3, false, false],
  ] as const)(
    'checks the source revision after a confirmed publication transition',
    async (finalRevision, dirty, expected) => {
      const lifecycle = new DocumentLifecycle();
      const target = { kind: 'tab', tabId: 'raw' } as const;
      let revision: number = 1;
      lifecycle.register({
        target,
        readRevision: () => revision,
        isDirty: () => dirty,
        save: async () => {
          revision = finalRevision;
          return { publishedRevision: 1, settledRevision: 2 };
        },
      });
      expect(await lifecycle.save(target)).toBe(expected);
    }
  );

  it('discard goes to the same selected owner', async () => {
    const lifecycle = new DocumentLifecycle();
    const target = { kind: 'page', pageId: 'notebook' } as const;
    let dirty = true;
    lifecycle.register({
      readRevision: () => 1,
      target,
      isDirty: () => dirty,
      save: async () => false,
      discard: () => {
        dirty = false;
      },
    });
    expect(lifecycle.dirty(target)).toBe(true);
    expect(await lifecycle.discard(target)).toBe(true);
    expect(lifecycle.dirty(target)).toBe(false);
  });
});

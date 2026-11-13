import { describe, expect, it, vi } from 'vitest';
import { DocumentLifecycle } from './document-lifecycle';
import { TAB_DOCUMENT_LIFECYCLES, TAB_TYPES } from './tab-kind';

describe('document lifecycle authority', () => {
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
    lifecycle.register({ target, tabId: 'hidden', isDirty: () => true, save: hidden });
    lifecycle.register({ target, tabId: 'visible', isDirty: () => true, save: visible });
    expect(await lifecycle.save(target, 'visible')).toBe(true);
    expect(visible).toHaveBeenCalledTimes(1);
    expect(hidden).not.toHaveBeenCalled();
    expect(await lifecycle.save(target)).toBe(false);
  });

  it('removing one view does not clear another dirty view', () => {
    const lifecycle = new DocumentLifecycle();
    const target = { kind: 'file', filePath: '/protocol.json' } as const;
    const first = lifecycle.register({
      target,
      tabId: 'first',
      isDirty: () => true,
      save: async () => true,
    });
    lifecycle.register({ target, tabId: 'second', isDirty: () => true, save: async () => true });
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
    lifecycle.register({ target, tabId: 'protein', isDirty: () => true, save });
    const first = lifecycle.save(target, 'protein');
    const second = lifecycle.save(target, 'protein');
    await Promise.resolve();
    expect(save).toHaveBeenCalledTimes(1);
    finish(false);
    expect(await first).toBe(false);
    expect(await second).toBe(false);
    expect(await lifecycle.save({ kind: 'tab', tabId: 'missing' })).toBe(false);
    lifecycle.register({
      target: { kind: 'tab', tabId: 'throws' },
      isDirty: () => true,
      save: async () => {
        throw new Error('failed');
      },
    });
    expect(await lifecycle.save({ kind: 'tab', tabId: 'throws' })).toBe(false);
  });

  it('discard goes to the same selected owner', async () => {
    const lifecycle = new DocumentLifecycle();
    const target = { kind: 'page', pageId: 'notebook' } as const;
    let dirty = true;
    lifecycle.register({
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

import { describe, it, expect, vi } from 'vitest';
import { yieldToMain } from './yieldToMain';

describe('yieldToMain', () => {
  it('resolves on a later macrotask (does not run sync)', async () => {
    const order: string[] = [];
    const p = yieldToMain().then(() => {
      order.push('yielded');
    });
    order.push('sync');
    await p;
    expect(order).toEqual(['sync', 'yielded']);
  });

  it('uses rAF when available', async () => {
    const raf = vi.fn((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal('requestAnimationFrame', raf);
    await yieldToMain();
    expect(raf).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

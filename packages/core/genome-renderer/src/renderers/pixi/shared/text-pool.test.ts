// @vitest-environment jsdom

import { beforeAll, describe, expect, it } from 'vitest';
import { Container, TextStyle } from 'pixi.js';
import { KeyedTextPool } from './text-pool';

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = ((contextId: string) => {
    if (contextId !== '2d') return null;
    return {
      font: '',
      measureText: (text: string) => ({ width: text.length * 6 }),
    } as unknown as CanvasRenderingContext2D;
  }) as typeof HTMLCanvasElement.prototype.getContext;
});

describe('KeyedTextPool', () => {
  it('retains overlapping label identities when the visible window shifts by one tick', () => {
    const pool = new KeyedTextPool(new Container(), new TextStyle({ fontSize: 10 }), 4);
    const first100 = pool.acquire('100 Mb');
    const first200 = pool.acquire('200 Mb');
    pool.acquire('300 Mb');
    pool.trimInactive();

    pool.reset();
    const second100 = pool.acquire('100 Mb');
    const second200 = pool.acquire('200 Mb');
    pool.acquire('400 Mb');
    pool.trimInactive();

    expect(second100).toBe(first100);
    expect(second200).toBe(first200);
    expect(pool.retainedCount).toBe(4);
    pool.destroy();
  });

  it('evicts only inactive labels when retention exceeds its bound', () => {
    const pool = new KeyedTextPool(new Container(), new TextStyle({ fontSize: 10 }), 2);
    pool.acquire('old A');
    pool.acquire('old B');
    pool.reset();

    const activeB = pool.acquire('old B');
    const activeC = pool.acquire('new C');
    pool.trimInactive();

    expect(activeB.destroyed).toBe(false);
    expect(activeC.destroyed).toBe(false);
    expect(pool.retainedCount).toBe(2);
    pool.destroy();
  });

  it('releases TextStyle listeners when retained labels are destroyed', () => {
    const style = new TextStyle({ fontSize: 10 });
    const pool = new KeyedTextPool(new Container(), style, 2);
    pool.acquire('100 Mb');
    pool.acquire('200 Mb');

    expect(style.listenerCount('update')).toBe(2);

    pool.destroy();

    expect(style.listenerCount('update')).toBe(0);
  });
});

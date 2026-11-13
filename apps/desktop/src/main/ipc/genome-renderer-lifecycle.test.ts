import { EventEmitter } from 'node:events';

import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import { GenomeRendererLifecycle } from './genome-renderer-lifecycle';

function renderer(id: number): {
  sender: WebContents;
  events: EventEmitter;
  destroy(): void;
} {
  const events = new EventEmitter();
  let destroyed = false;
  Object.assign(events, {
    id,
    isDestroyed: () => destroyed,
  });
  return {
    sender: events as unknown as WebContents,
    events,
    destroy() {
      destroyed = true;
      events.emit('destroyed');
    },
  };
}

describe('genome renderer lifecycle', () => {
  it('releases every owner on main-frame reload and invalidates prior admissions', () => {
    const releaseOwners = vi.fn();
    const lifecycle = new GenomeRendererLifecycle(releaseOwners);
    const owner = renderer(41);
    const generation = lifecycle.register(owner.sender);

    owner.events.emit('did-start-navigation', {
      isMainFrame: false,
      isSameDocument: false,
      url: 'https://renderer.test/subframe',
    });
    expect(releaseOwners).not.toHaveBeenCalled();
    lifecycle.assertCurrent(owner.sender, generation);

    owner.events.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: false,
      url: 'https://renderer.test/reload',
    });
    expect(releaseOwners).toHaveBeenCalledExactlyOnceWith(41);
    expect(() => lifecycle.assertCurrent(owner.sender, generation)).toThrowError('owner admission');
    expect(() => lifecycle.register(owner.sender)).toThrowError('owner admission');

    owner.events.emit('did-frame-navigate', {}, 'https://renderer.test/reload', 200, 'OK', true);
    expect(lifecycle.register(owner.sender)).toBe(generation + 1);
  });

  it('keeps admission closed through duplicate failure events until loading stops', () => {
    const lifecycle = new GenomeRendererLifecycle(vi.fn());
    const owner = renderer(44);
    const generation = lifecycle.register(owner.sender);

    owner.events.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: false,
      url: 'https://renderer.test/fails',
    });
    expect(() => lifecycle.register(owner.sender)).toThrowError('owner admission');

    owner.events.emit(
      'did-fail-provisional-load',
      {},
      -3,
      'ERR_ABORTED',
      'https://renderer.test/fails',
      true
    );
    owner.events.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://renderer.test/fails', true);
    expect(() => lifecycle.register(owner.sender)).toThrowError('owner admission');

    owner.events.emit('did-stop-loading');
    expect(lifecycle.register(owner.sender)).toBe(generation + 1);
  });

  it('keeps overlapping navigation blocked until the current main frame commits', () => {
    const lifecycle = new GenomeRendererLifecycle(vi.fn());
    const owner = renderer(45);
    const generation = lifecycle.register(owner.sender);

    owner.events.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: false,
      url: 'https://renderer.test/a',
    });
    owner.events.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: false,
      url: 'https://renderer.test/b',
    });
    owner.events.emit(
      'did-fail-provisional-load',
      {},
      -3,
      'ERR_ABORTED',
      'https://renderer.test/a',
      true
    );
    owner.events.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://renderer.test/a', true);
    expect(() => lifecycle.register(owner.sender)).toThrowError('owner admission');

    owner.events.emit('did-frame-navigate', {}, 'https://renderer.test/b', 200, 'OK', true);
    expect(lifecycle.register(owner.sender)).toBe(generation + 2);
  });

  it('releases owners on renderer crash even though WebContents survives', () => {
    const releaseOwners = vi.fn();
    const lifecycle = new GenomeRendererLifecycle(releaseOwners);
    const owner = renderer(42);
    const generation = lifecycle.register(owner.sender);

    owner.events.emit('render-process-gone', {}, { reason: 'crashed' });

    expect(releaseOwners).toHaveBeenCalledExactlyOnceWith(42);
    expect(() => lifecycle.assertCurrent(owner.sender, generation)).toThrowError('owner admission');
    expect(() => lifecycle.register(owner.sender)).toThrowError('owner admission');

    owner.events.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: false,
      url: 'https://renderer.test/recovered',
    });
    owner.events.emit('did-frame-navigate', {}, 'https://renderer.test/recovered', 200, 'OK', true);
    expect(lifecycle.register(owner.sender)).toBe(generation + 2);
  });

  it('registers listeners once and releases permanent destruction', () => {
    const releaseOwners = vi.fn();
    const lifecycle = new GenomeRendererLifecycle(releaseOwners);
    const owner = renderer(43);

    expect(lifecycle.register(owner.sender)).toBe(0);
    expect(lifecycle.register(owner.sender)).toBe(0);
    expect(owner.events.listenerCount('render-process-gone')).toBe(1);
    expect(owner.events.listenerCount('did-start-navigation')).toBe(1);
    expect(owner.events.listenerCount('did-frame-navigate')).toBe(1);
    expect(owner.events.listenerCount('did-stop-loading')).toBe(1);
    expect(owner.events.listenerCount('did-fail-load')).toBe(0);
    expect(owner.events.listenerCount('did-fail-provisional-load')).toBe(0);
    expect(owner.events.listenerCount('destroyed')).toBe(1);

    owner.destroy();

    expect(releaseOwners).toHaveBeenCalledExactlyOnceWith(43);
    expect(() => lifecycle.assertCurrent(owner.sender, 0)).toThrowError('owner admission');
  });
});

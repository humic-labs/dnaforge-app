import { describe, expect, it, vi } from 'vitest';
import { ShellReadiness } from './shell-readiness';

describe('current renderer shell readiness', () => {
  it('page navigation alone is not a usable shell', () => {
    const onReady = vi.fn();
    const readiness = new ShellReadiness(onReady);
    readiness.beginLoad();
    readiness.pageLoaded();
    expect(readiness.snapshot()).toMatchObject({ pageLoaded: true, shellReady: false });
    expect(onReady).not.toHaveBeenCalled();
  });

  it('joins navigation and interaction prerequisites exactly once per load', () => {
    const onReady = vi.fn();
    const readiness = new ShellReadiness(onReady);
    const { loadId } = readiness.beginLoad();
    expect(readiness.acknowledge(loadId)).toBe(true);
    expect(onReady).not.toHaveBeenCalled();
    readiness.pageLoaded();
    readiness.pageLoaded();
    readiness.acknowledge(loadId);
    expect(readiness.snapshot().shellReady).toBe(true);
    expect(onReady).toHaveBeenCalledExactlyOnceWith(loadId);
  });

  it('reload clears success and rejects stale, missing, and malformed acknowledgements', () => {
    const onReady = vi.fn();
    const readiness = new ShellReadiness(onReady);
    const old = readiness.beginLoad();
    readiness.pageLoaded();
    readiness.acknowledge(old.loadId);
    const current = readiness.beginLoad();
    expect(current.loadId).not.toBe(old.loadId);
    expect(readiness.acknowledge(old.loadId)).toBe(false);
    expect(readiness.acknowledge(null)).toBe(false);
    expect(readiness.acknowledge({ loadId: current.loadId })).toBe(false);
    readiness.pageLoaded();
    expect(readiness.snapshot().shellReady).toBe(false);
    expect(onReady).toHaveBeenCalledTimes(1);
    readiness.acknowledge(current.loadId);
    expect(onReady).toHaveBeenCalledTimes(2);
  });
});

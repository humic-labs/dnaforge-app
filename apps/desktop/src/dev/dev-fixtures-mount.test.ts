import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getDevFixturesMounted, setDevFixturesMounted } from './dev-fixtures-mount';

describe('dev fixtures mount flag', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => vi.unstubAllEnvs());

  it('keeps shared fixtures unmounted in an isolated automation profile', () => {
    vi.stubEnv('VITE_DNAFORGE_AUTOMATION_ISOLATED', '1');
    expect(getDevFixturesMounted()).toBe(false);
    localStorage.setItem('waypoint:devFixturesMounted', 'true');
    expect(getDevFixturesMounted()).toBe(false);
  });

  it('cannot enable shared fixtures through the automation profile toggle', () => {
    vi.stubEnv('VITE_DNAFORGE_AUTOMATION_ISOLATED', '1');
    const listener = vi.fn();
    window.addEventListener('waypoint:devFixturesMountedChange', listener);
    try {
      setDevFixturesMounted(true);
      expect(getDevFixturesMounted()).toBe(false);
      expect((listener.mock.calls[0][0] as CustomEvent).detail).toBe(false);
    } finally {
      window.removeEventListener('waypoint:devFixturesMountedChange', listener);
    }
  });

  it('defaults to mounted (true) so existing dev behavior is preserved', () => {
    expect(getDevFixturesMounted()).toBe(true);
  });

  it('persists the unmounted state and reads it back', () => {
    setDevFixturesMounted(false);
    expect(localStorage.getItem('waypoint:devFixturesMounted')).toBe('false');
    expect(getDevFixturesMounted()).toBe(false);
    setDevFixturesMounted(true);
    expect(getDevFixturesMounted()).toBe(true);
  });

  it('dispatches a change event so in-process listeners stay in sync', () => {
    const listener = vi.fn();
    window.addEventListener('waypoint:devFixturesMountedChange', listener);
    setDevFixturesMounted(false);
    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toBe(false);
    window.removeEventListener('waypoint:devFixturesMountedChange', listener);
  });
});

// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  getDevSurfaceState,
  isLocalDevBuild,
  shouldAutoMountDevAssets,
  shouldEnableDevScenarios,
} from './dev-surface-gates';

describe('dev surface gates', () => {
  it('enables user-visible dev tools only in local dev builds', () => {
    expect(isLocalDevBuild({ DEV: true, MODE: 'development' })).toBe(true);
    expect(shouldEnableDevScenarios({ DEV: true, MODE: 'development' })).toBe(true);
  });

  it('disables dev surfaces in staging builds', () => {
    const env = { DEV: false, MODE: 'staging' };

    expect(isLocalDevBuild(env)).toBe(false);
    expect(shouldAutoMountDevAssets(env, '/Users/dev/wp-assets')).toBe(false);
    expect(shouldEnableDevScenarios(env)).toBe(false);
    expect(getDevSurfaceState(env, '/Users/dev/wp-assets')).toEqual({
      devAssets: false,
      devScenarios: false,
      devShortcuts: false,
    });
  });

  it('disables dev surfaces in production builds even when a dev assets path exists', () => {
    const env = { DEV: false, MODE: 'production' };

    expect(shouldAutoMountDevAssets(env, '/Users/dev/wp-assets')).toBe(false);
    expect(shouldEnableDevScenarios(env)).toBe(false);
  });

  it('does not auto-mount desktop fixtures in the hosted renderer, even when DEV is true', () => {
    const env = { DEV: true, MODE: 'hosted' };

    expect(isLocalDevBuild(env)).toBe(false);
    expect(shouldAutoMountDevAssets(env, '/Users/dev/wp-assets')).toBe(false);
    expect(shouldEnableDevScenarios(env)).toBe(false);
    expect(getDevSurfaceState(env, '/Users/dev/wp-assets')).toEqual({
      devAssets: false,
      devScenarios: false,
      devShortcuts: false,
    });
  });

  it('exposes only the scenario surface in test-mode acceptance builds', () => {
    const env = { DEV: false, MODE: 'test' };

    expect(shouldAutoMountDevAssets(env, '/Users/dev/wp-assets')).toBe(false);
    expect(shouldEnableDevScenarios(env)).toBe(true);
    expect(getDevSurfaceState(env, '/Users/dev/wp-assets')).toEqual({
      devAssets: false,
      devScenarios: true,
      devShortcuts: true,
    });
  });

  it('requires a real dev assets path before auto-mounting dev assets', () => {
    expect(shouldAutoMountDevAssets({ DEV: true, MODE: 'development' }, '')).toBe(false);
    expect(shouldAutoMountDevAssets({ DEV: true, MODE: 'development' }, '   ')).toBe(false);
    expect(shouldAutoMountDevAssets({ DEV: true, MODE: 'development' }, '/wp-assets')).toBe(true);
  });

  it('defensively ignores truthy non-boolean DEV values', () => {
    const env = { DEV: 'true' as unknown as boolean, MODE: 'staging' };

    expect(isLocalDevBuild(env)).toBe(false);
    expect(shouldEnableDevScenarios(env)).toBe(false);
  });
});

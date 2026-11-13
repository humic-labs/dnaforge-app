import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('posthog-js/lib/src/entrypoints/module.es', () => ({
  default: { isFeatureEnabled: vi.fn(() => false), onFeatureFlags: vi.fn() },
}));

import { isDesktopSignInFeatureEnabled } from './analytics';

afterEach(() => {
  vi.unstubAllEnvs();
});

function simulatePackagedProd(): void {
  vi.stubEnv('DEV', false);
  vi.stubEnv('MODE', 'production');
}

describe('isDesktopSignInFeatureEnabled —  analytics decoupling', () => {
  it('shows sign-in in a packaged prod build when the env switch is ON, even with PostHog uninitialized (analytics opted out)', () => {
    simulatePackagedProd();
    vi.stubEnv('VITE_ENABLE_DESKTOP_SIGNIN', 'true');
    expect(isDesktopSignInFeatureEnabled()).toBe(true);
  });

  it('is visible by default in a packaged prod build after the signed-in backup/share launch', () => {
    simulatePackagedProd();
    vi.stubEnv('VITE_ENABLE_DESKTOP_SIGNIN', '');
    expect(isDesktopSignInFeatureEnabled()).toBe(true);
  });

  it('stays dark in a packaged prod build when the explicit env kill switch is OFF', () => {
    simulatePackagedProd();
    vi.stubEnv('VITE_ENABLE_DESKTOP_SIGNIN', 'false');
    expect(isDesktopSignInFeatureEnabled()).toBe(false);
  });

  it('is visible in dev builds so E2E can drive the button', () => {
    vi.stubEnv('DEV', true);
    expect(isDesktopSignInFeatureEnabled()).toBe(true);
  });

  it('is visible in the --mode test build', () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('MODE', 'test');
    expect(isDesktopSignInFeatureEnabled()).toBe(true);
  });
});

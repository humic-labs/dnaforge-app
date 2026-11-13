import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('posthog-js/lib/src/entrypoints/module.es', () => ({
  default: { isFeatureEnabled: vi.fn(() => false), onFeatureFlags: vi.fn() },
}));

import { isWorkspaceCloudSyncFeatureEnabled } from './analytics';

afterEach(() => {
  vi.unstubAllEnvs();
});

function simulatePackagedProd(): void {
  vi.stubEnv('DEV', false);
  vi.stubEnv('MODE', 'production');
}

describe('isWorkspaceCloudSyncFeatureEnabled —  flag split', () => {
  it('is visible by default in a packaged prod build (behavior-preserving with the old single flag)', () => {
    simulatePackagedProd();
    vi.stubEnv('VITE_ENABLE_WORKSPACE_CLOUD_SYNC', '');
    expect(isWorkspaceCloudSyncFeatureEnabled()).toBe(true);
  });

  it('shows sync in a packaged prod build when the env switch is explicitly ON', () => {
    simulatePackagedProd();
    vi.stubEnv('VITE_ENABLE_WORKSPACE_CLOUD_SYNC', 'true');
    expect(isWorkspaceCloudSyncFeatureEnabled()).toBe(true);
  });

  it('stays dark in a packaged prod build when the explicit sync kill switch is OFF', () => {
    simulatePackagedProd();
    vi.stubEnv('VITE_ENABLE_WORKSPACE_CLOUD_SYNC', 'false');
    expect(isWorkspaceCloudSyncFeatureEnabled()).toBe(false);
  });

  it('is independent of the sign-in kill switch (auth off must not force sync off)', () => {
    simulatePackagedProd();
    vi.stubEnv('VITE_ENABLE_DESKTOP_SIGNIN', 'false');
    vi.stubEnv('VITE_ENABLE_WORKSPACE_CLOUD_SYNC', '');
    expect(isWorkspaceCloudSyncFeatureEnabled()).toBe(true);
  });

  it('is visible in dev builds so E2E can drive the cloud surface', () => {
    vi.stubEnv('DEV', true);
    expect(isWorkspaceCloudSyncFeatureEnabled()).toBe(true);
  });

  it('is visible in the --mode test build', () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('MODE', 'test');
    expect(isWorkspaceCloudSyncFeatureEnabled()).toBe(true);
  });
});

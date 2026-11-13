import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PlatformBridge } from './types';
import { electronBridge } from './electron';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Electron compute bridge', () => {
  it('forwards native Jobs coverage without inferring totals from its bounded rows', async () => {
    const receipt = {
      jobs: [],
      jobCount: 205,
      activeCount: 0,
      terminalCount: 205,
      activeComplete: true as const,
      historyComplete: false,
      historyLimit: 200,
    };
    const listJobsSnapshot = vi.fn(async () => receipt);
    const compute = { listJobsSnapshot } satisfies Pick<
      PlatformBridge['compute'],
      'listJobsSnapshot'
    >;
    vi.stubGlobal('window', { electronAPI: { compute } });
    expect(await electronBridge.compute.listJobsSnapshot({ historyLimit: 200 })).toBe(receipt);
    expect(listJobsSnapshot).toHaveBeenCalledWith({ historyLimit: 200 });
  });
  it('forwards custom-manifest install and removal through preload', async () => {
    const installManifest = vi.fn(async () => ({
      ok: true as const,
      providerId: 'runpod-lab',
      displayName: 'Lab Runpod',
    }));
    const removeCustomProvider = vi.fn(async () => ({
      ok: true as const,
      providerId: 'runpod-lab',
      removedCredential: true,
    }));
    const compute = { installManifest, removeCustomProvider } satisfies Pick<
      PlatformBridge['compute'],
      'installManifest' | 'removeCustomProvider'
    >;
    vi.stubGlobal('window', { electronAPI: { compute } });

    await expect(
      electronBridge.compute.installManifest('{"schemaVersion":2}')
    ).resolves.toMatchObject({
      ok: true,
      providerId: 'runpod-lab',
    });
    await expect(electronBridge.compute.removeCustomProvider('runpod-lab')).resolves.toMatchObject({
      ok: true,
      removedCredential: true,
    });
    expect(installManifest).toHaveBeenCalledWith('{"schemaVersion":2}');
    expect(removeCustomProvider).toHaveBeenCalledWith('runpod-lab');
  });
});

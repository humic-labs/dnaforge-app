import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEV_LIMS_SEED_STORAGE_KEY, DEV_LIMS_SEED_VERSION } from '../../shared/lims-dev-seed';
import {
  createElectronRuntimeProfile,
  DISPOSABLE_SCENARIO_PROFILE_ARGUMENT,
} from '../../shared/scenario-mutation';

const mocks = vi.hoisted(() => ({
  getProfile: vi.fn(),
  addRichToast: vi.fn(() => 'seed-toast'),
  addToast: vi.fn(),
  removeToast: vi.fn(),
  seed: vi.fn(),
}));
vi.mock('../../platform', () => ({
  platform: () => ({ runtime: { getProfile: mocks.getProfile } }),
}));
vi.mock('../../stores/toast-store', () => ({
  useToastStore: { getState: () => mocks },
}));
vi.mock('./operations', () => ({ seedLimsMockDemo: mocks.seed }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv('DEV', true);
  localStorage.clear();
  Object.defineProperty(navigator, 'webdriver', { configurable: true, value: false });
  mocks.seed.mockResolvedValue({});
});
afterEach(() => vi.unstubAllEnvs());

const mountPrompt = async () => {
  const { useDevLimsSeedPrompt } = await import('./useDevLimsSeedPrompt');
  return renderHook(() => useDevLimsSeedPrompt());
};

describe('developer seed prompt uses the actual runtime capability', () => {
  it('offers no reseed in a persistent profile, including one with the launch permission flag', async () => {
    mocks.getProfile.mockReturnValue(
      createElectronRuntimeProfile(['DNAForge'], { DNAFORGE_ALLOW_SCENARIO_MUTATION: '1' })
    );
    await mountPrompt();
    expect(mocks.addRichToast).not.toHaveBeenCalled();
    expect(mocks.seed).not.toHaveBeenCalled();
    expect(localStorage.getItem(DEV_LIMS_SEED_STORAGE_KEY)).toBeNull();
  });

  it('offers one permitted reseed and stamps only successful completion', async () => {
    mocks.getProfile.mockReturnValue(
      createElectronRuntimeProfile(['DNAForge', DISPOSABLE_SCENARIO_PROFILE_ARGUMENT], {
        DNAFORGE_ALLOW_SCENARIO_MUTATION: '1',
      })
    );
    const { rerender } = await mountPrompt();
    rerender();
    expect(mocks.addRichToast).toHaveBeenCalledTimes(1);
    const args = mocks.addRichToast.mock.calls[0][0] as unknown as {
      actions: Array<{ label: string; onClick: () => void }>;
    };
    await act(async () => args.actions.find((action) => action.label === 'Reseed')!.onClick());
    await waitFor(() =>
      expect(localStorage.getItem(DEV_LIMS_SEED_STORAGE_KEY)).toBe(String(DEV_LIMS_SEED_VERSION))
    );
    expect(mocks.seed).toHaveBeenCalledWith({
      actor: 'local-user',
      reset: true,
      resetScope: 'dev-seed',
    });
    expect(mocks.removeToast).toHaveBeenCalledWith('seed-toast');
  });

  it('does not stamp a failed reseed', async () => {
    mocks.getProfile.mockReturnValue(
      createElectronRuntimeProfile(['DNAForge', DISPOSABLE_SCENARIO_PROFILE_ARGUMENT], {
        DNAFORGE_ALLOW_SCENARIO_MUTATION: '1',
      })
    );
    mocks.seed.mockRejectedValue(new Error('seed rejected'));
    await mountPrompt();
    const args = mocks.addRichToast.mock.calls[0][0] as unknown as {
      actions: Array<{ label: string; onClick: () => void }>;
    };
    await act(async () => args.actions.find((action) => action.label === 'Reseed')!.onClick());
    await waitFor(() => expect(mocks.addToast).toHaveBeenCalled());
    expect(localStorage.getItem(DEV_LIMS_SEED_STORAGE_KEY)).toBeNull();
    expect(mocks.removeToast).not.toHaveBeenCalled();
  });
});

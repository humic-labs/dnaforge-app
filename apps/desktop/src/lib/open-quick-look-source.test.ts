import { userEntityLabel, userMessageWithValues } from '@waypoint/user-messages';
import { beforeEach, expect, it, vi } from 'vitest';
import { openQuickLookSource } from './open-quick-look-source';
import { useToastStore } from '../stores/toast-store';

const mocks = vi.hoisted(() => ({ materialize: vi.fn(), openPackage: vi.fn() }));
vi.mock('../platform', () => ({
  platform: () => ({
    fileAssociations: { materializeQuickLookPackage: mocks.materialize },
    fs: { canonicalPath: vi.fn(async (path: string) => path) },
  }),
}));
vi.mock('../features/sequence/managed-sequence-repository', () => ({
  managedSequenceRepository: { openPackage: mocks.openPackage },
}));

beforeEach(() => {
  vi.resetAllMocks();
  useToastStore.setState({ toasts: [] });
});

it('shows a package-read failure after successful Quick Look materialization', async () => {
  mocks.materialize.mockResolvedValue({
    packageRoot: '/cache/quick-look/package',
    sourceFileName: 'sample.gb',
  });
  mocks.openPackage.mockRejectedValue(new Error('The package manifest is unreadable'));

  expect(
    await openQuickLookSource({
      sourcePath: '/external/sample.gb',
      familyId: 'genbank',
      sourceSurface: 'unknown',
    })
  ).toBeNull();
  expect(mocks.openPackage).toHaveBeenCalledWith('/cache/quick-look/package');
  expect(useToastStore.getState().toasts).toEqual([
    expect.objectContaining({
      type: 'error',
      message: userMessageWithValues('document.quickLookOpenFailed', {
        name: userEntityLabel('sample.gb'),
      }),
    }),
  ]);
  expect(useToastStore.getState().toasts[0]?.message).not.toContain('manifest');
});

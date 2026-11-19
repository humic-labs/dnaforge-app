import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegisterFileAssociationHandlersDeps } from './file-associations';

const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();
const assertSafePath = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler);
    }),
  },
}));

vi.mock('./path-allowlist', () => ({ assertSafePath }));

function deps(): RegisterFileAssociationHandlersDeps {
  return {
    lifecycle: {
      open: vi.fn(async () => ({ sequence: {} })),
    } as unknown as RegisterFileAssociationHandlersDeps['lifecycle'],
    takePendingAndMarkReady: vi.fn(() => []),
    defaultHandler: {
      queryAll: vi.fn(async () => []),
      requestDefault: vi.fn(async (familyId) => ({
        familyId,
        outcome: 'unavailable' as const,
        detail: 'Unsupported in this test.',
      })),
    },
    materializeQuickLookPackage: vi.fn(),
    prepareQuickLookPackage: vi.fn(async () => false),
    promoteQuickLookPackage: vi.fn(),
  };
}

async function materializeHandler(): Promise<(...args: unknown[]) => unknown> {
  const { registerFileAssociationHandlers } = await import('./file-associations');
  registerFileAssociationHandlers(deps());
  const handler = ipcHandlers.get('fileAssociations:materializeQuickLookPackage');
  if (!handler) throw new Error('Quick Look materialization handler was not registered.');
  return handler;
}

describe('fileAssociations:requestDefault', () => {
  it.each(['genbank', 'snapgene', 'fasta', 'structure', 'chromatogram'])(
    'forwards a request for %s to the native handler service',
    async (familyId) => {
      const dependencies = deps();
      const { registerFileAssociationHandlers } = await import('./file-associations');
      registerFileAssociationHandlers(dependencies);
      const handler = ipcHandlers.get('fileAssociations:requestDefault');
      if (!handler) throw new Error('Default request handler was not registered.');

      await handler({}, familyId);

      expect(dependencies.defaultHandler.requestDefault).toHaveBeenCalledWith(familyId);
    }
  );
});

describe('fileAssociations:materializeQuickLookPackage', () => {
  beforeEach(() => {
    ipcHandlers.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('rejects a renderer path when the shared filesystem boundary denies it', async () => {
    assertSafePath.mockRejectedValueOnce(new Error('Path access denied: /etc/private.gb'));
    const handler = await materializeHandler();

    await expect(
      handler({}, { sourcePath: '/etc/private.gb', familyId: 'genbank' })
    ).rejects.toThrow('Path access denied');
    expect(assertSafePath).toHaveBeenCalledWith('/etc/private.gb', {
      requireAbsolute: true,
      errorPrefix: 'Quick Look source',
    });
  });

  it('passes only the canonical admitted path to package materialization', async () => {
    assertSafePath.mockResolvedValueOnce('/allowed/canonical.gb');
    const dependencies = deps();
    const { registerFileAssociationHandlers } = await import('./file-associations');
    registerFileAssociationHandlers(dependencies);
    const handler = ipcHandlers.get('fileAssociations:materializeQuickLookPackage');
    if (!handler) throw new Error('Quick Look materialization handler was not registered.');

    await handler(
      { sender: { id: 7, on: vi.fn(), once: vi.fn() } },
      { sourcePath: '/allowed/alias.gb', familyId: 'genbank' }
    );

    expect(dependencies.lifecycle.open).toHaveBeenCalledWith(7, '/allowed/canonical.gb', 'genbank');
  });

  it('routes protected package preparation to the main-owned store', async () => {
    const dependencies = deps();
    const { registerFileAssociationHandlers } = await import('./file-associations');
    registerFileAssociationHandlers(dependencies);
    const handler = ipcHandlers.get('fileAssociations:prepareQuickLookPackage');
    if (!handler) throw new Error('Quick Look package preparation handler was not registered.');

    await handler({}, { packageRoot: '/user-data/quick-look-packages/key/records/000001/package' });

    expect(dependencies.prepareQuickLookPackage).toHaveBeenCalledWith({
      packageRoot: '/user-data/quick-look-packages/key/records/000001/package',
    });
  });
});

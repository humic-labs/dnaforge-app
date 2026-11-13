import { beforeEach, describe, expect, it, vi } from 'vitest';

const ports = vi.hoisted(() => ({ exists: vi.fn(), open: vi.fn(), present: vi.fn() }));
vi.mock('../../platform', () => ({
  platform: () => ({
    fs: {
      exists: ports.exists,
      stat: async () => ({ isDirectory: true, isFile: false }),
      readDir: async () => [{ name: 'plasmid.json', isDirectory: false, isFile: true }],
    },
  }),
}));
vi.mock('../sequence/public/openSequenceFile', () => ({ openSequencePackageResult: ports.open }));
vi.mock('../canvas/public/present-document', () => ({ presentDocument: ports.present }));

import { openDocument } from './open-document';

const root =
  '/projects/review-project/Cases/cumate-red-oe-pcr/Final assemblies/edited-yhim-yhin-locus';

describe('opening a sequence package root received as a file locator', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    ports.exists.mockImplementation(
      async (path: string) => path === `${root}/.forge` || path === `${root}/.forge/plasmid.json`
    );
    ports.open.mockResolvedValue({
      status: 'presented',
      tabType: 'sequence',
      tabId: 'sequence-tab',
      panelId: 'main',
      disposition: 'created',
      content: 'loading',
    });
  });

  it('opens the managed sequence instead of presenting its directory to the text reader', async () => {
    await expect(
      openDocument({ target: { kind: 'file', path: root, tabType: 'text' }, source: 'file_tree' })
    ).resolves.toMatchObject({ status: 'presented', tabType: 'sequence' });
    expect(ports.open).toHaveBeenCalledWith(
      root,
      expect.objectContaining({ sourceSurface: 'file_tree' })
    );
    expect(ports.present).not.toHaveBeenCalled();
  });

  it('propagates a recognized package error without falling back to reading its directory', async () => {
    ports.open.mockRejectedValue(new Error('Invalid sequence package'));
    await expect(openDocument({ target: { kind: 'file', path: root } })).resolves.toEqual({
      status: 'failed',
      message: 'Invalid sequence package',
    });
    expect(ports.present).not.toHaveBeenCalled();
  });
});

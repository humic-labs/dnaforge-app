import { beforeEach, describe, expect, it, vi } from 'vitest';

const ports = vi.hoisted(() => ({
  stat: vi.fn(),
  exists: vi.fn(),
  readDir: vi.fn(),
  package: vi.fn(),
  sequence: vi.fn(),
  workspace: vi.fn(),
  present: vi.fn(),
}));
vi.mock('../../platform', () => ({
  platform: () => ({
    fs: {
      stat: ports.stat,
      exists: ports.exists,
      readDir: ports.readDir,
    },
  }),
}));
vi.mock('../sequence/public/openSequenceFile', () => ({
  openSequencePackageResult: ports.package,
  openSequenceFileResult: ports.sequence,
}));
vi.mock('../page/public/open-workspace-document', () => ({
  openWorkspaceDocument: ports.workspace,
}));
vi.mock('../canvas/public/present-document', () => ({ presentDocument: ports.present }));

import { openDocument } from './open-document';

const result = {
  status: 'presented',
  tabType: 'sequence',
  tabId: 'sequence',
  panelId: 'main',
  disposition: 'created',
  content: 'loading',
};
const parent = '/projects/review-project/Final assemblies';

describe('filesystem identity before document presentation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    ports.stat.mockImplementation(async (path: string) => ({
      canonicalPath: path,
      isDirectory: true,
      isFile: false,
      size: 0,
      mtime: 0,
      ctime: 0,
      mtimeNs: '0',
      ctimeNs: '0',
    }));
    ports.exists.mockImplementation(
      async (path: string) => path.endsWith('/.forge') || path.endsWith('/.forge/plasmid.json')
    );
    ports.readDir.mockResolvedValue([{ name: 'plasmid.json', isDirectory: false, isFile: true }]);
    ports.package.mockResolvedValue(result);
    ports.present.mockImplementation(({ type }: { type: string }) => ({
      ...result,
      tabType: type,
    }));
  });

  it.each([
    'edited-locus',
    'PQ010742.1-primer-map',
    'assembly.gb',
    'assembly.primer.json',
    'assembly.png',
    'assembly.pdf',
    'assembly.txt',
  ])('opens the package metadata owner for directory %s regardless of its name', async (name) => {
    const path = `${parent}/${name}`;
    await expect(
      openDocument({ target: { kind: 'file', path }, source: 'file_tree' })
    ).resolves.toMatchObject(result);
    expect(ports.package).toHaveBeenCalledWith(
      path,
      expect.objectContaining({ sourceSurface: 'file_tree' })
    );
    expect(ports.sequence).not.toHaveBeenCalled();
    expect(ports.workspace).not.toHaveBeenCalled();
    expect(ports.present).not.toHaveBeenCalled();
  });

  it.each(['ordinary-folder', 'ordinary-folder.txt', 'ordinary-folder.png'])(
    'refuses directory %s without presenting it as a literal file',
    async (name) => {
      ports.exists.mockResolvedValue(false);
      ports.readDir.mockResolvedValue([]);
      await expect(
        openDocument({ target: { kind: 'file', path: `${parent}/${name}` } })
      ).resolves.toMatchObject({ status: 'unsupported' });
      expect(ports.package).not.toHaveBeenCalled();
      expect(ports.present).not.toHaveBeenCalled();
    }
  );

  it('preserves a filesystem failure instead of falling back to a text tab', async () => {
    ports.stat.mockRejectedValue(new Error('Permission denied for this path'));
    await expect(
      openDocument({ target: { kind: 'file', path: `${parent}/unreadable` } })
    ).resolves.toEqual({ status: 'failed', message: 'Permission denied for this path' });
    expect(ports.present).not.toHaveBeenCalled();
    expect(ports.package).not.toHaveBeenCalled();
  });

  it('keeps a declared notebook package with the notebook owner even when its name resembles a sequence', async () => {
    ports.exists.mockImplementation(
      async (path: string) => path.endsWith('/.forge') || path.endsWith('/.forge/notebook.json')
    );
    ports.readDir.mockResolvedValue([{ name: 'notebook.json', isDirectory: false, isFile: true }]);
    ports.workspace.mockResolvedValue({ ...result, tabType: 'page' });
    await expect(
      openDocument({ target: { kind: 'file', path: `${parent}/Notebook.gb`, tabType: 'page' } })
    ).resolves.toMatchObject({ status: 'presented', tabType: 'page' });
    expect(ports.package).not.toHaveBeenCalled();
    expect(ports.workspace).toHaveBeenCalledWith(
      expect.objectContaining({ target: expect.objectContaining({ tabType: 'page' }) })
    );
  });
});

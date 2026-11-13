import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { SEQUENCE_PACKAGE_FORMAT_VERSION } from '../../../db/sequence-package-contract';
import {
  buildSequencePackageDocument,
  serializeSequencePackageDocument,
} from '../../../db/sequence-package';

const mockExists = vi.fn();
const mockReadTextFile = vi.fn();
const mockWriteTextFile = vi.fn();
const mockWriteWorkspaceTextFileAtomic = vi.fn();
const mockMkdir = vi.fn();
const mockMove = vi.fn();
const mockReadFile = vi.fn();
const mockStat = vi.fn();
const mockBeginMutation = vi.fn();
const mockEndMutation = vi.fn();
const { mockListProjectEditFolders } = vi.hoisted(() => ({
  mockListProjectEditFolders: vi.fn(),
}));

vi.mock('../../workspace-loader/public/project-edit-folders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../workspace-loader/public/project-edit-folders')>()),
  listProjectEditFolders: mockListProjectEditFolders,
}));

vi.mock('../../../platform', () => ({
  platform: () => ({
    fs: {
      exists: mockExists,
      readTextFile: mockReadTextFile,
      writeTextFile: mockWriteTextFile,
      writeWorkspaceTextFileAtomic: mockWriteWorkspaceTextFileAtomic,
      mkdir: mockMkdir,
      move: mockMove,
      readFile: mockReadFile,
      stat: mockStat,
      beginWorkspaceMutation: mockBeginMutation,
      endWorkspaceMutation: mockEndMutation,
    },
  }),
}));

import {
  findSequencePackageRootForReference,
  stageAlignmentQueryPaths,
} from './stage-alignment-query';

const PACKAGE_META = JSON.stringify({
  schema: 'waypoint.plasmid.v1',
  kind: 'plasmid',
  id: 'pkg-1',
  name: 'pUC19',
  updatedAt: '2026-08-13T00:00:00.000Z',
  product: { file: 'pUC19.gb' },
});

function existsOnlyMeta(path: string): boolean {
  return (
    path === '/lab/pUC19/.forge/plasmid.json' || path.endsWith('/lab/pUC19/.forge/plasmid.json')
  );
}

describe('stageAlignmentQueryPaths', () => {
  beforeEach(() => {
    mockListProjectEditFolders.mockReset().mockResolvedValue([{ path: '/lab', pinned: false }]);
    mockExists.mockReset();
    mockReadTextFile.mockReset();
    mockWriteTextFile.mockReset().mockResolvedValue(undefined);
    mockWriteWorkspaceTextFileAtomic.mockReset().mockImplementation(async (input) => {
      const before = await mockReadTextFile(input.path);
      const contentHash = createHash('sha256').update(before).digest('hex');
      if (contentHash !== input.expectedContentHash) throw new Error('Package marker changed.');
      await mockWriteTextFile(input.path, input.content);
      return { path: input.path, contentHash };
    });
    mockMkdir.mockReset().mockResolvedValue(undefined);
    mockMove.mockReset();
    mockReadFile.mockReset();
    mockStat.mockReset();
    mockBeginMutation.mockReset().mockResolvedValue('native-mutation');
    mockEndMutation.mockReset().mockResolvedValue(undefined);
    mockStat.mockResolvedValue({
      isDirectory: false,
      isFile: true,
      isSymbolicLink: false,
    });
    mockReadFile.mockImplementation(async (path: string) => {
      const text = await mockReadTextFile(path);
      return new TextEncoder().encode(text);
    });
  });

  it('does not move a query that is a symbolic link', async () => {
    mockExists.mockImplementation(async (path: string) => existsOnlyMeta(path));
    mockReadTextFile.mockResolvedValue(PACKAGE_META);
    mockMove.mockResolvedValue({ destPath: '/lab/pUC19/contents/clone-1.ab1' });
    mockStat.mockResolvedValue({
      isDirectory: false,
      isFile: true,
      isSymbolicLink: true,
    });

    await expect(
      stageAlignmentQueryPaths('/lab/pUC19/pUC19.gb', ['/lab/reads/clone-1.ab1'])
    ).resolves.toEqual(['/lab/reads/clone-1.ab1']);
    expect(mockMove).not.toHaveBeenCalled();
  });

  it('does not move a query whose path contains ..', async () => {
    mockExists.mockImplementation(async (path: string) => existsOnlyMeta(path));
    mockReadTextFile.mockResolvedValue(PACKAGE_META);
    mockMove.mockResolvedValue({ destPath: '/lab/pUC19/contents/clone-1.fasta' });

    await expect(
      stageAlignmentQueryPaths('/lab/pUC19/pUC19.gb', ['/lab/pUC19/../secrets/clone-1.fasta'])
    ).resolves.toEqual(['/lab/pUC19/../secrets/clone-1.fasta']);
    expect(mockMove).not.toHaveBeenCalled();
  });

  it('leaves queries alone when the reference is not a package', async () => {
    mockExists.mockResolvedValue(false);
    const queries = ['/downloads/clone-1.fasta'];
    await expect(stageAlignmentQueryPaths('/lab/pUC19.gb', queries)).resolves.toEqual(queries);
    expect(mockMove).not.toHaveBeenCalled();
  });

  it('moves an outside query into package contents/ and records a member', async () => {
    mockExists.mockImplementation(async (path: string) => existsOnlyMeta(path));
    mockReadTextFile.mockResolvedValue(PACKAGE_META);
    mockMove.mockResolvedValue({ destPath: '/lab/pUC19/contents/clone-1.fasta' });

    await expect(
      stageAlignmentQueryPaths('/lab/pUC19/pUC19.gb', ['/downloads/clone-1.fasta'])
    ).resolves.toEqual(['/lab/pUC19/contents/clone-1.fasta']);

    expect(mockMkdir).toHaveBeenCalledWith('/lab/pUC19/contents', { recursive: true });
    expect(mockMove).toHaveBeenCalledWith('/downloads/clone-1.fasta', '/lab/pUC19/contents');
    expect(mockWriteWorkspaceTextFileAtomic).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceRoot: '/lab' })
    );
    expect(mockBeginMutation).not.toHaveBeenCalled();
    expect(mockEndMutation).not.toHaveBeenCalled();
    expect(mockWriteTextFile).toHaveBeenCalled();
    const written = JSON.parse(
      mockWriteTextFile.mock.calls[mockWriteTextFile.mock.calls.length - 1][1] as string
    );
    expect(written.formatVersion).toBe(SEQUENCE_PACKAGE_FORMAT_VERSION);
    expect(written.members).toEqual([
      expect.objectContaining({
        role: 'sequencing-read',
        path: 'contents/clone-1.fasta',
        replaceable: false,
      }),
    ]);
    expect(written.members.some((member: { role: string }) => member.role === 'alignment')).toBe(
      false
    );
  });

  it.each([
    { name: 'unregistered', folders: [] },
    { name: 'read-only', folders: [{ path: '/lab', pinned: true }] },
  ])('does not move a query without a writable owning project ($name)', async ({ folders }) => {
    mockExists.mockImplementation(async (path: string) => existsOnlyMeta(path));
    mockReadTextFile.mockResolvedValue(PACKAGE_META);
    mockListProjectEditFolders.mockResolvedValue(folders);
    mockMove.mockResolvedValue({ destPath: '/lab/pUC19/contents/clone-1.fasta' });

    await expect(
      stageAlignmentQueryPaths('/lab/pUC19/pUC19.gb', ['/downloads/clone-1.fasta'])
    ).resolves.toEqual(['/downloads/clone-1.fasta']);
    expect(mockMove).not.toHaveBeenCalled();
    expect(mockWriteWorkspaceTextFileAtomic).not.toHaveBeenCalled();
  });

  it('reports the registration failure when the query has already moved', async () => {
    mockExists.mockImplementation(async (path: string) => existsOnlyMeta(path));
    mockReadTextFile.mockResolvedValue(
      serializeSequencePackageDocument(
        buildSequencePackageDocument({
          id: 'pkg-1',
          name: 'pUC19',
          product: { file: 'pUC19.gb' },
        })
      )
    );
    mockMove.mockResolvedValue({ destPath: '/lab/pUC19/contents/clone-1.fasta' });
    const failure = new Error('The owning project became read-only.');
    mockWriteWorkspaceTextFileAtomic.mockRejectedValue(failure);

    await expect(
      stageAlignmentQueryPaths('/lab/pUC19/pUC19.gb', ['/downloads/clone-1.fasta'])
    ).rejects.toBe(failure);
    expect(mockMove).toHaveBeenCalledOnce();
  });

  it('does not move a query that is already inside the package', async () => {
    mockExists.mockImplementation(async (path: string) => existsOnlyMeta(path));
    mockReadTextFile.mockResolvedValue(PACKAGE_META);

    await expect(
      stageAlignmentQueryPaths('/lab/pUC19/pUC19.gb', ['/lab/pUC19/assets/clone-1.fasta'])
    ).resolves.toEqual(['/lab/pUC19/assets/clone-1.fasta']);
    expect(mockMove).not.toHaveBeenCalled();
  });

  it('does not move a read that is another package’s product', async () => {
    mockExists.mockImplementation(
      async (path: string) => existsOnlyMeta(path) || path === '/lab/clone/.forge/plasmid.json'
    );
    mockReadTextFile.mockResolvedValue(PACKAGE_META);

    await expect(
      stageAlignmentQueryPaths('/lab/pUC19/pUC19.gb', ['/lab/clone/clone.gb'])
    ).resolves.toEqual(['/lab/clone/clone.gb']);
    expect(mockMove).not.toHaveBeenCalled();
  });

  it('uses a unique contents/ name when the destination is already taken', async () => {
    const written: Record<string, string> = {};
    mockExists.mockImplementation(async (path: string) => {
      if (path === '/lab/pUC19/.forge/plasmid.json') return true;
      if (path === '/lab/pUC19/contents/clone-1.fasta') return true;
      return path in written;
    });
    mockWriteTextFile.mockImplementation(async (path: string, content: string) => {
      written[path] = content;
    });
    mockReadTextFile.mockImplementation(async (path: string) => {
      if (path in written) return written[path];
      if (path.endsWith('plasmid.json')) return PACKAGE_META;
      if (path === '/lab/pUC19/contents/clone-1.fasta') return '>DEST\nAAAA\n';
      if (path === '/tmp/clone-1.fasta') return '>SRC\nTTTT\n';
      throw new Error(`unexpected read ${path}`);
    });
    mockMove.mockRejectedValue(new Error('MOVE_EXISTS: clone-1.fasta'));

    await expect(
      stageAlignmentQueryPaths('/lab/pUC19/pUC19.gb', ['/tmp/clone-1.fasta'])
    ).resolves.toEqual(['/lab/pUC19/contents/clone-1-2.fasta']);
  });

  it('leaves a read in another package when the live FS cannot copy bytes', async () => {
    const otherMeta = JSON.stringify({
      schema: 'waypoint.sequence.v1',
      kind: 'sequence',
      formatVersion: 4,
      id: 'other',
      name: 'other',
      updatedAt: '2026-08-13T00:00:00.000Z',
      product: { file: 'other.gb' },
      members: [],
    });
    mockExists.mockImplementation(async (path: string) => {
      return (
        path === '/lab/pUC19/.forge/plasmid.json' ||
        path === '/lab/other/.forge/plasmid.json' ||
        path === '/lab/other/contents/Well_A01.ab1'
      );
    });
    mockReadTextFile.mockImplementation(async (path: string) => {
      if (path === '/lab/other/.forge/plasmid.json') return otherMeta;
      if (path === '/lab/pUC19/.forge/plasmid.json') return PACKAGE_META;
      throw new Error(`unexpected read ${path}`);
    });
    await expect(
      stageAlignmentQueryPaths('/lab/pUC19/pUC19.gb', ['/lab/other/contents/Well_A01.ab1'])
    ).resolves.toEqual(['/lab/other/contents/Well_A01.ab1']);
    expect(mockMove).not.toHaveBeenCalled();
  });

  it('does not move a home path that is not a sequencing query', async () => {
    mockExists.mockImplementation(async (path: string) => existsOnlyMeta(path));
    mockReadTextFile.mockResolvedValue(PACKAGE_META);
    mockMove.mockResolvedValue({ destPath: '/lab/pUC19/contents/.ssh' });

    await expect(
      stageAlignmentQueryPaths('/lab/pUC19/pUC19.gb', ['/Users/lab/.ssh'])
    ).resolves.toEqual(['/Users/lab/.ssh']);
    expect(mockMove).not.toHaveBeenCalled();
  });
});

describe('findSequencePackageRootForReference', () => {
  beforeEach(() => {
    mockExists.mockReset();
    mockReadTextFile.mockReset();
  });

  it('returns the package root only when the meta names this product', async () => {
    mockExists.mockImplementation(async (path: string) => existsOnlyMeta(path));
    mockReadTextFile.mockResolvedValue(PACKAGE_META);
    await expect(findSequencePackageRootForReference('/lab/pUC19/pUC19.gb')).resolves.toBe(
      '/lab/pUC19'
    );
    await expect(findSequencePackageRootForReference('/lab/pUC19/other.gb')).resolves.toBeNull();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { resolveSequencePackageProductPath } from './sequence-package-product';
import { resolveSequencePackageRootForProductPath } from './public/sequence-package-product';
import * as sequencePackageIo from '../../db/sequence-package-io';
import { setRememberedDeveloperImportSourceRootsForRenderer } from '../../shared/developer-import-sources';

const fsState = vi.hoisted(() => ({
  files: new Map<string, string>(),
  dirs: new Map<string, Array<{ name: string; isDirectory: boolean }>>(),
  writeAtomic: vi.fn(),
}));

vi.mock('../../platform', () => ({
  platform: () => ({
    fs: {
      exists: vi.fn(async (path: string) => fsState.files.has(path) || fsState.dirs.has(path)),
      readTextFile: vi.fn(async (path: string) => {
        const content = fsState.files.get(path);
        if (content === undefined) throw new Error(`ENOENT: ${path}`);
        return content;
      }),
      readDir: vi.fn(async (path: string) => {
        const entries = fsState.dirs.get(path);
        if (!entries) throw new Error(`ENOENT: ${path}`);
        return entries.map((entry) => ({
          name: entry.name,
          isDirectory: entry.isDirectory,
          isFile: !entry.isDirectory,
        }));
      }),
      writeWorkspaceTextFileAtomic: fsState.writeAtomic,
    },
  }),
}));

vi.mock('../../shared/developer-import-sources', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shared/developer-import-sources')>();
  return {
    ...actual,
    isDeveloperImportSourcePath: (path: string) =>
      actual.isDeveloperImportSourcePath(path, ['/developer/wp-assets']) ||
      actual.isDeveloperImportSourcePath(path),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const ROOT = '/ws/pMyConstruct';

function meta(productFile: string): string {
  return JSON.stringify({
    schema: 'waypoint.plasmid.v1',
    kind: 'plasmid',
    id: 'plasmid-1',
    name: 'pMyConstruct',
    updatedAt: '2026-07-25T00:00:00.000Z',
    product: { file: productFile, topology: 'circular' },
  });
}

describe('resolveSequencePackageProductPath', () => {
  beforeEach(() => {
    fsState.files.clear();
    fsState.dirs.clear();
    fsState.writeAtomic
      .mockReset()
      .mockImplementation(async ({ path, content }: { path: string; content: string }) => {
        fsState.files.set(path, content);
      });
    setRememberedDeveloperImportSourceRootsForRenderer([]);
    vi.stubGlobal('crypto', webcrypto);
  });

  it.each(['configured', 'remembered'] as const)(
    'resolves a %s developer source without migrating its legacy package bytes',
    async (policy) => {
      const root =
        policy === 'configured'
          ? '/developer/wp-assets/Legacy source'
          : '/remembered/source/Legacy source';
      if (policy === 'remembered')
        setRememberedDeveloperImportSourceRootsForRenderer(['/remembered/source']);
      fsState.files.set(`${root}/.forge/plasmid.json`, meta('source.gb'));
      fsState.files.set(
        `${root}/source.gb`,
        'LOCUS       Immutable 4 bp DNA\r\nORIGIN\r\n        1 acgt\r\n//\r\n'
      );
      fsState.dirs.set(root, [
        { name: 'source.gb', isDirectory: false },
        { name: '.forge', isDirectory: true },
      ]);
      const before = [...fsState.files];
      const load = vi.spyOn(sequencePackageIo, 'loadSequencePackageDocument');

      await expect(resolveSequencePackageProductPath(root)).resolves.toBe(`${root}/source.gb`);
      expect.soft(load).not.toHaveBeenCalled();
      expect.soft(fsState.writeAtomic).not.toHaveBeenCalled();
      expect([...fsState.files]).toEqual(before);
    }
  );

  it('retains migration through the managed package loader for an ordinary project', async () => {
    fsState.files.set(`${ROOT}/.forge/plasmid.json`, meta('source.gb'));
    fsState.dirs.set(ROOT, [{ name: 'source.gb', isDirectory: false }]);
    const load = vi.spyOn(sequencePackageIo, 'loadSequencePackageDocument');
    await expect(resolveSequencePackageProductPath(ROOT)).resolves.toBe(`${ROOT}/source.gb`);
    expect(load).toHaveBeenCalled();
    expect(fsState.writeAtomic).toHaveBeenCalledOnce();
    expect(JSON.parse(fsState.files.get(`${ROOT}/.forge/plasmid.json`)!)).toHaveProperty(
      'formatVersion',
      9
    );
  });

  it('opens the file the record names', () => {
    fsState.files.set(`${ROOT}/.forge/plasmid.json`, meta('pMyConstruct.gb'));
    fsState.dirs.set(ROOT, [
      { name: 'pMyConstruct.gb', isDirectory: false },
      { name: '.forge', isDirectory: true },
      { name: 'primers', isDirectory: true },
    ]);

    return expect(resolveSequencePackageProductPath(ROOT)).resolves.toBe(`${ROOT}/pMyConstruct.gb`);
  });

  it('heals when the plasmid was renamed outside the app', async () => {
    fsState.files.set(`${ROOT}/.forge/plasmid.json`, meta('pMyConstruct.gb'));
    fsState.dirs.set(ROOT, [
      { name: 'pRenamedByHand.gb', isDirectory: false },
      { name: '.forge', isDirectory: true },
    ]);

    await expect(resolveSequencePackageProductPath(ROOT)).resolves.toBe(
      `${ROOT}/pRenamedByHand.gb`
    );
  });

  it('refuses to open a newer format than this app understands', async () => {
    fsState.files.set(
      `${ROOT}/.forge/plasmid.json`,
      JSON.stringify({
        schema: 'waypoint.sequence.v1',
        kind: 'sequence',
        formatVersion: 99,
        id: 'future',
        name: 'pMyConstruct',
        product: { file: 'pMyConstruct.gb' },
      })
    );
    fsState.dirs.set(ROOT, [{ name: 'pMyConstruct.gb', isDirectory: false }]);

    await expect(resolveSequencePackageProductPath(ROOT)).rejects.toThrow(
      /newer than this app|SEQUENCE_PACKAGE_NEWER_FORMAT|formatVersion 99/i
    );
  });

  it('still opens when the record itself is corrupt, if the plasmid is unambiguous', async () => {
    fsState.files.set(`${ROOT}/.forge/plasmid.json`, '{ not json');
    fsState.dirs.set(ROOT, [{ name: 'pMyConstruct.gb', isDirectory: false }]);

    await expect(resolveSequencePackageProductPath(ROOT)).resolves.toBe(`${ROOT}/pMyConstruct.gb`);
  });

  it('still opens when the record is missing entirely', async () => {
    fsState.dirs.set(ROOT, [{ name: 'pMyConstruct.gbk', isDirectory: false }]);

    await expect(resolveSequencePackageProductPath(ROOT)).resolves.toBe(`${ROOT}/pMyConstruct.gbk`);
  });

  it('FAILS CLOSED rather than opening the wrong plasmid', async () => {
    fsState.files.set(`${ROOT}/.forge/plasmid.json`, meta('gone.gb'));
    fsState.dirs.set(ROOT, [
      { name: 'a.gb', isDirectory: false },
      { name: 'b.gb', isDirectory: false },
    ]);

    await expect(resolveSequencePackageProductPath(ROOT)).rejects.toThrow(/ambiguous/i);
  });

  it('ignores a DIRECTORY that looks like a GenBank file', async () => {
    fsState.dirs.set(ROOT, [
      { name: 'archive.gb', isDirectory: true },
      { name: 'pMyConstruct.gb', isDirectory: false },
    ]);

    await expect(resolveSequencePackageProductPath(ROOT)).resolves.toBe(`${ROOT}/pMyConstruct.gb`);
  });

  it('reports a package with no plasmid in it', async () => {
    fsState.dirs.set(ROOT, [{ name: 'notes.txt', isDirectory: false }]);

    await expect(resolveSequencePackageProductPath(ROOT)).rejects.toThrow(/no product/i);
  });
});

describe('resolveSequencePackageRootForProductPath', () => {
  beforeEach(() => {
    fsState.files.clear();
    fsState.dirs.clear();
  });

  it('returns the package root through the canonical package marker resolver', async () => {
    fsState.files.set(`${ROOT}/.forge/plasmid.json`, meta('pMyConstruct.gb'));

    await expect(resolveSequencePackageRootForProductPath(`${ROOT}/pMyConstruct.gb`)).resolves.toBe(
      ROOT
    );
  });

  it('returns null for a loose sequence file', async () => {
    await expect(
      resolveSequencePackageRootForProductPath('/ws/loose/pMyConstruct.gb')
    ).resolves.toBeNull();
  });
});

// @vitest-environment node

import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { SEQUENCE_PACKAGE_FORMAT_VERSION } from './sequence-package-contract';
import {
  addSequencePackageMember,
  copyVerifyThenRetire,
  findEnclosingSequencePackageRoot,
  loadSequencePackageDocument,
  writeAlignmentHistoryMember,
} from './sequence-package-io';
import {
  serializeSequencePackageDocument,
  buildSequencePackageDocument,
  sequencePackagePaths,
} from './sequence-package';
import { writeWorkspaceTextFileAtomicInMain } from '../main/primer-artifact-files';

function nodePackageFs() {
  return {
    exists: async (path: string) => {
      try {
        await stat(path);
        return true;
      } catch {
        return false;
      }
    },
    readTextFile: (path: string) => readFile(path, 'utf8'),
    writeTextFile: (path: string, content: string) => writeFile(path, content, 'utf8'),
    writeWorkspaceTextFileAtomic: (input: {
      workspaceRoot: string;
      path: string;
      content: string;
      mode: 'replace';
      expectedContentHash: string;
      artifactNoun: string;
    }) => writeWorkspaceTextFileAtomicInMain(input),
    mkdir: (path: string, options?: { recursive?: boolean }) => mkdir(path, options),
    readFile: async (path: string) => new Uint8Array(await readFile(path)),
    writeFile: (path: string, contents: Uint8Array) => writeFile(path, contents),
    move: async (sourcePath: string, destinationDir: string) => {
      const destPath = join(destinationDir, basename(sourcePath));
      await rename(sourcePath, destPath);
      return { destPath };
    },
    unlink: (path: string) => unlink(path),
    rename: (from: string, to: string) => rename(from, to),
  };
}

describe('addSequencePackageMember', () => {
  it('records verified original-file bytes as an active user attachment in a new package', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'seq-pkg-user-attachment-'));
    try {
      const packageRoot = join(workspace, 'entity');
      const paths = sequencePackagePaths(packageRoot, { productFile: 'entity.gb' });
      await mkdir(paths.metaDir, { recursive: true });
      await writeFile(
        paths.metaPath,
        serializeSequencePackageDocument(
          buildSequencePackageDocument({
            id: 'entity',
            name: 'Entity',
            product: { file: 'entity.gb' },
          })
        )
      );
      const source = join(workspace, 'original.dna');
      const bytes = Buffer.from([0, 255, 1, 2]);
      await writeFile(source, bytes);
      const result = await addSequencePackageMember({
        packageRoot,
        workspaceRoot: workspace,
        role: 'user',
        sourcePath: source,
        fs: {
          ...nodePackageFs(),
          writeWorkspaceTextFileAtomic: async (input) => {
            expect(input.workspaceRoot).toBe(workspace);
            return writeWorkspaceTextFileAtomicInMain(input);
          },
        },
      });
      const [member] = result.document.members;
      expect(member.role).toBe('user');
      expect(result.document.userAttachments[member.id]).toEqual({
        memberId: member.id,
        sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      });
      expect(await readFile(result.destPath)).toEqual(bytes);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('registers first alignment history under the owning project while keeping it in the package', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'seq-pkg-history-owner-'));
    try {
      const packageRoot = join(workspace, 'entity');
      const paths = sequencePackagePaths(packageRoot, { productFile: 'entity.gb' });
      await mkdir(paths.metaDir, { recursive: true });
      await writeFile(
        paths.metaPath,
        serializeSequencePackageDocument(
          buildSequencePackageDocument({
            id: 'entity',
            name: 'Entity',
            product: { file: 'entity.gb' },
          })
        )
      );
      const content = JSON.stringify({ sessions: [{ id: 'existing-run' }] });
      const fs = nodePackageFs();
      const path = await writeAlignmentHistoryMember({
        packageRoot,
        workspaceRoot: workspace,
        productFile: 'entity.gb',
        content,
        fs: {
          ...fs,
          writeWorkspaceTextFileAtomic: async (input) => {
            expect(input.workspaceRoot).toBe(workspace);
            return fs.writeWorkspaceTextFileAtomic(input);
          },
        },
      });
      expect(path).toBe(join(packageRoot, 'contents', 'entity.gb.waypoint.json'));
      expect(await readFile(path, 'utf8')).toBe(content);
      expect((await loadSequencePackageDocument(packageRoot, fs)).members).toEqual([
        expect.objectContaining({ role: 'alignment', path: 'contents/entity.gb.waypoint.json' }),
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('moves bytes into contents/ and records a member — callers do not name the folder', async () => {
    const fs = {
      exists: vi
        .fn()
        .mockImplementation(async (path: string) => path === '/lab/pUC19/.forge/plasmid.json'),
      readTextFile: vi.fn().mockResolvedValue(
        serializeSequencePackageDocument(
          buildSequencePackageDocument({
            id: 'pkg-1',
            name: 'pUC19',
            product: { file: 'pUC19.gb' },
          })
        )
      ),
      writeTextFile: vi.fn().mockResolvedValue(undefined),
      writeWorkspaceTextFileAtomic: vi.fn().mockResolvedValue(undefined),
      mkdir: vi.fn().mockResolvedValue(undefined),
      move: vi.fn().mockResolvedValue({ destPath: '/lab/pUC19/contents/clone-1.fasta' }),
    };

    const result = await addSequencePackageMember({
      packageRoot: '/lab/pUC19',
      role: 'sequencing-read',
      sourcePath: '/downloads/clone-1.fasta',
      fs,
    });

    expect(result.destPath).toBe('/lab/pUC19/contents/clone-1.fasta');
    expect(fs.mkdir).toHaveBeenCalledWith('/lab/pUC19/contents', { recursive: true });
    expect(fs.move).toHaveBeenCalledWith('/downloads/clone-1.fasta', '/lab/pUC19/contents');
    expect(result.document.members).toEqual([
      expect.objectContaining({
        role: 'sequencing-read',
        path: 'contents/clone-1.fasta',
        replaceable: false,
      }),
    ]);
  });

  it('rebases an additive member registration after a concurrent marker update', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'seq-pkg-member-race-'));
    try {
      const packageRoot = join(workspace, 'entity');
      const paths = sequencePackagePaths(packageRoot, { productFile: 'entity.gb' });
      await mkdir(paths.metaDir, { recursive: true });
      const initial = buildSequencePackageDocument({
        id: 'member-race',
        name: 'Before',
        product: { file: 'entity.gb' },
      });
      await writeFile(paths.metaPath, serializeSequencePackageDocument(initial));
      const source = join(workspace, 'read.bin');
      await writeFile(source, Buffer.from([0, 255, 1]));
      const base = nodePackageFs();
      let insertedConcurrentUpdate = false;
      const fs = {
        ...base,
        writeWorkspaceTextFileAtomic: async (
          input: Parameters<typeof base.writeWorkspaceTextFileAtomic>[0]
        ) => {
          if (!insertedConcurrentUpdate) {
            insertedConcurrentUpdate = true;
            await writeFile(
              paths.metaPath,
              serializeSequencePackageDocument({ ...initial, name: 'Concurrent rename' })
            );
          }
          return base.writeWorkspaceTextFileAtomic(input);
        },
      };
      const result = await addSequencePackageMember({
        packageRoot,
        role: 'sequencing-read',
        sourcePath: source,
        fs,
      });
      expect(result.document.name).toBe('Concurrent rename');
      expect(result.document.members).toEqual([
        expect.objectContaining({ role: 'sequencing-read', path: 'contents/read.bin' }),
      ]);
      expect(await readFile(result.destPath)).toEqual(Buffer.from([0, 255, 1]));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('does not retry a failed publication recovery even if the marker also changed', async () => {
    const packageRoot = '/lab/record';
    const initial = buildSequencePackageDocument({
      id: 'record',
      name: 'Before',
      product: { file: 'record.gb' },
    });
    let marker = serializeSequencePackageDocument(initial);
    const writeWorkspaceTextFileAtomic = vi.fn(async () => {
      marker = serializeSequencePackageDocument({ ...initial, name: 'Concurrent rename' });
      throw new Error('pending publication recovery failed');
    });
    const fs = {
      exists: vi.fn().mockResolvedValue(true),
      readTextFile: vi.fn(async () => marker),
      writeTextFile: vi.fn(),
      writeWorkspaceTextFileAtomic,
      mkdir: vi.fn().mockResolvedValue(undefined),
      move: vi.fn().mockResolvedValue({ destPath: '/lab/record/contents/read.bin' }),
    };

    await expect(
      addSequencePackageMember({
        packageRoot,
        role: 'sequencing-read',
        sourcePath: '/downloads/read.bin',
        fs,
      })
    ).rejects.toThrow('pending publication recovery failed');
    expect(writeWorkspaceTextFileAtomic).toHaveBeenCalledTimes(1);
  });

  it('does not invent a destination folder for a file already in the package', async () => {
    const fs = {
      exists: vi.fn(),
      readTextFile: vi.fn().mockResolvedValue(
        serializeSequencePackageDocument(
          buildSequencePackageDocument({
            id: 'pkg-1',
            name: 'pUC19',
            product: { file: 'pUC19.gb' },
          })
        )
      ),
      writeTextFile: vi.fn(),
      mkdir: vi.fn(),
      move: vi.fn(),
    };

    const result = await addSequencePackageMember({
      packageRoot: '/lab/pUC19',
      role: 'sequencing-read',
      sourcePath: '/lab/pUC19/assets/gel.png',
      fs,
    });

    expect(result.destPath).toBe('/lab/pUC19/assets/gel.png');
    expect(fs.move).not.toHaveBeenCalled();
    expect(fs.writeTextFile).not.toHaveBeenCalled();
  });
});

describe('loadSequencePackageDocument disk migration', () => {
  it('moves v2 primer files into contents/ and persists format 3', async () => {
    const fixture = join(
      dirname(fileURLToPath(import.meta.url)),
      '__fixtures__/sequence-packages/v2-finalized'
    );
    const root = join(await mkdtemp(join(tmpdir(), 'seq-pkg-v2-')), 'pMyConstruct');
    await cp(fixture, root, { recursive: true });

    const doc = await loadSequencePackageDocument(root, nodePackageFs());
    expect(doc.formatVersion).toBe(SEQUENCE_PACKAGE_FORMAT_VERSION);
    expect(doc.assembly?.primers).toBeUndefined();
    expect(doc.members.some((member) => member.path === 'contents/pMyConstruct.primers.csv')).toBe(
      true
    );
    expect((await stat(join(root, 'contents/pMyConstruct.primers.csv'))).isFile()).toBe(true);
    expect((await stat(join(root, 'contents/pMyConstruct.primers.fasta'))).isFile()).toBe(true);
    await expect(stat(join(root, 'primers/pMyConstruct.primers.csv'))).rejects.toThrow();

    const persisted = JSON.parse(await readFile(join(root, '.forge/plasmid.json'), 'utf8')) as {
      formatVersion: number;
    };
    expect(persisted.formatVersion).toBe(SEQUENCE_PACKAGE_FORMAT_VERSION);

    await loadSequencePackageDocument(root, nodePackageFs());
    expect((await stat(join(root, 'contents/pMyConstruct.primers.csv'))).isFile()).toBe(true);
  });

  it('moves a sibling alignment sidecar into contents/ and lists it', async () => {
    const fixture = join(
      dirname(fileURLToPath(import.meta.url)),
      '__fixtures__/sequence-packages/v3-aligned'
    );
    const root = join(await mkdtemp(join(tmpdir(), 'seq-pkg-v3-')), 'pMyConstruct');
    await cp(fixture, root, { recursive: true });

    const doc = await loadSequencePackageDocument(root, nodePackageFs());
    expect(doc.formatVersion).toBe(SEQUENCE_PACKAGE_FORMAT_VERSION);
    expect(doc.assembly?.primers).toBeUndefined();
    expect(doc.members.some((member) => member.role === 'alignment')).toBe(true);
    expect((await stat(join(root, 'contents/pMyConstruct.gb.waypoint.json'))).isFile()).toBe(true);
    await expect(stat(join(root, 'pMyConstruct.gb.waypoint.json'))).rejects.toThrow();
  });

  it('does not retire the source when dest exists with different bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seq-pkg-dest-'));
    const source = join(root, 'primers/old.csv');
    const dest = join(root, 'contents/old.csv');
    await mkdir(join(root, 'primers'), { recursive: true });
    await mkdir(join(root, 'contents'), { recursive: true });
    await writeFile(source, 'SOURCE');
    await writeFile(dest, 'OTHER');
    await expect(copyVerifyThenRetire(nodePackageFs(), source, dest, root)).rejects.toThrow(
      /MIGRATE_DEST_CONFLICT/
    );
    expect(await readFile(source, 'utf8')).toBe('SOURCE');
    expect(await readFile(dest, 'utf8')).toBe('OTHER');
  });

  it('does not retire the source if the destination does not match', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seq-pkg-safe-'));
    const source = join(root, 'old.txt');
    const dest = join(root, 'contents', 'old.txt');
    await writeFile(source, 'SOURCE-BYTES');
    const {
      rename: _rename,
      unlink: _unlink,
      writeFile: _writeFile,
      ...textOnly
    } = nodePackageFs();
    const fs = {
      ...textOnly,
      writeTextFile: async (path: string) => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, 'CORRUPT-DEST');
      },
    };
    await expect(copyVerifyThenRetire(fs, source, dest, root)).rejects.toThrow(
      /MIGRATE_VERIFY_FAILED/
    );
    expect(await readFile(source, 'utf8')).toBe('SOURCE-BYTES');
  });

  it('allocates a unique contents/ name when dest exists with different bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aln-collide-'));
    const pkg = join(root, 'pUC19');
    await mkdir(join(pkg, 'contents'), { recursive: true });
    await mkdir(join(pkg, '.forge'), { recursive: true });
    await writeFile(
      join(pkg, '.forge/plasmid.json'),
      serializeSequencePackageDocument(
        buildSequencePackageDocument({
          id: 'p',
          name: 'pUC19',
          product: { file: 'pUC19.gb' },
        })
      )
    );
    await writeFile(join(pkg, 'contents/clone-1.fasta'), '>DEST\nAAAA\n');
    const source = join(root, 'clone-1.fasta');
    await writeFile(source, '>SRC\nTTTT\n');
    const fs = {
      ...nodePackageFs(),
      move: async () => {
        throw new Error('MOVE_EXISTS: clone-1.fasta');
      },
    };
    const result = await addSequencePackageMember({
      packageRoot: pkg,
      role: 'sequencing-read',
      sourcePath: source,
      fs,
    });
    expect(result.destPath).toBe(join(pkg, 'contents/clone-1-2.fasta'));
    expect(await readFile(join(pkg, 'contents/clone-1.fasta'), 'utf8')).toBe('>DEST\nAAAA\n');
    expect(await readFile(join(pkg, 'contents/clone-1-2.fasta'), 'utf8')).toBe('>SRC\nTTTT\n');
    expect(result.document.members).toEqual([
      expect.objectContaining({ role: 'sequencing-read', path: 'contents/clone-1-2.fasta' }),
    ]);
  });

  it('keeps two same-name binary traces intact instead of UTF-8 copying them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aln-ab1-'));
    const pkg = join(root, 'pUC19');
    await mkdir(join(pkg, 'contents'), { recursive: true });
    await mkdir(join(pkg, '.forge'), { recursive: true });
    await writeFile(
      join(pkg, '.forge/plasmid.json'),
      serializeSequencePackageDocument(
        buildSequencePackageDocument({
          id: 'p',
          name: 'pUC19',
          product: { file: 'pUC19.gb' },
        })
      )
    );
    const firstBytes = Uint8Array.from([0x41, 0x42, 0x31, 0xff, 0x00, 0x01]);
    const secondBytes = Uint8Array.from([0x41, 0x42, 0x31, 0xfe, 0x00, 0x02]);
    await writeFile(join(pkg, 'contents/A01.ab1'), firstBytes);
    const source = join(root, 'A01.ab1');
    await writeFile(source, secondBytes);
    const result = await addSequencePackageMember({
      packageRoot: pkg,
      role: 'sequencing-read',
      sourcePath: source,
      fs: {
        ...nodePackageFs(),
        move: async () => {
          throw new Error('MOVE_EXISTS: A01.ab1');
        },
      },
    });
    expect(result.destPath).toBe(join(pkg, 'contents/A01-2.ab1'));
    expect(await readFile(join(pkg, 'contents/A01.ab1'))).toEqual(Buffer.from(firstBytes));
    expect(await readFile(join(pkg, 'contents/A01-2.ab1'))).toEqual(Buffer.from(secondBytes));
    await expect(stat(source)).rejects.toThrow();
  });

  it('copies a read out of another package and leaves the original member file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aln-cross-'));
    const pkgA = join(root, 'pA');
    const pkgB = join(root, 'pB');
    for (const pkg of [pkgA, pkgB]) {
      await mkdir(join(pkg, 'contents'), { recursive: true });
      await mkdir(join(pkg, '.forge'), { recursive: true });
      await writeFile(
        join(pkg, '.forge/plasmid.json'),
        serializeSequencePackageDocument(
          buildSequencePackageDocument({
            id: basename(pkg),
            name: basename(pkg),
            product: { file: `${basename(pkg)}.gb` },
          })
        )
      );
    }
    const sourceBytes = Uint8Array.from([0x41, 0x42, 0x31, 0xff, 0x10]);
    const source = join(pkgA, 'contents/Well_A01.ab1');
    await writeFile(source, sourceBytes);
    const result = await addSequencePackageMember({
      packageRoot: pkgB,
      role: 'sequencing-read',
      sourcePath: source,
      fs: nodePackageFs(),
    });
    expect(result.destPath).toBe(join(pkgB, 'contents/Well_A01.ab1'));
    expect(await readFile(source)).toEqual(Buffer.from(sourceBytes));
    expect(await readFile(join(pkgB, 'contents/Well_A01.ab1'))).toEqual(Buffer.from(sourceBytes));
    expect(result.document.members).toEqual([
      expect.objectContaining({ role: 'sequencing-read', path: 'contents/Well_A01.ab1' }),
    ]);
  });

  it('does not move a packaged read when a binary copy API is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aln-nocopy-'));
    const pkgA = join(root, 'pA');
    const pkgB = join(root, 'pB');
    for (const pkg of [pkgA, pkgB]) {
      await mkdir(join(pkg, 'contents'), { recursive: true });
      await mkdir(join(pkg, '.forge'), { recursive: true });
      await writeFile(
        join(pkg, '.forge/plasmid.json'),
        serializeSequencePackageDocument(
          buildSequencePackageDocument({
            id: basename(pkg),
            name: basename(pkg),
            product: { file: `${basename(pkg)}.gb` },
          })
        )
      );
    }
    const source = join(pkgA, 'contents/Well_A01.ab1');
    await writeFile(source, Uint8Array.from([0xff, 0x00]));
    const { readFile: _readFile, writeFile: _writeFile, ...noBinary } = nodePackageFs();
    await expect(
      addSequencePackageMember({
        packageRoot: pkgB,
        role: 'sequencing-read',
        sourcePath: source,
        fs: noBinary,
      })
    ).rejects.toThrow(/ATTACH_COPY_UNAVAILABLE/);
    expect(await readFile(source)).toEqual(Buffer.from([0xff, 0x00]));
    await expect(stat(join(pkgB, 'contents/Well_A01.ab1'))).rejects.toThrow();
  });

  it('moves leftover files/ members into contents/ on load', async () => {
    const root = join(await mkdtemp(join(tmpdir(), 'seq-pkg-files-')), 'pUC19');
    await mkdir(join(root, '.forge'), { recursive: true });
    await mkdir(join(root, 'files'), { recursive: true });
    await writeFile(join(root, 'pUC19.gb'), 'LOCUS pUC19\n//\n');
    await writeFile(join(root, 'files/clone-1.fasta'), '>c\nACGT\n');
    await writeFile(
      join(root, '.forge/plasmid.json'),
      JSON.stringify({
        schema: 'waypoint.plasmid.v1',
        kind: 'plasmid',
        formatVersion: 2,
        id: 'p',
        name: 'pUC19',
        product: { file: 'pUC19.gb' },
        members: [
          {
            id: 'r1',
            role: 'sequencing-read',
            path: 'files/clone-1.fasta',
            replaceable: false,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      })
    );
    const doc = await loadSequencePackageDocument(root, nodePackageFs());
    expect(doc.members[0]?.path).toBe('contents/clone-1.fasta');
    expect((await stat(join(root, 'contents/clone-1.fasta'))).isFile()).toBe(true);
    await expect(stat(join(root, 'files/clone-1.fasta'))).rejects.toThrow();
  });

  it('treats contents, assets, primers, and files as inside the source package', async () => {
    const exists = async (path: string) => path === '/lab/pA/.forge/plasmid.json';
    await expect(findEnclosingSequencePackageRoot('/lab/pA', { exists })).resolves.toBe('/lab/pA');
    await expect(
      findEnclosingSequencePackageRoot('/lab/pA/contents/Well_A01.ab1', { exists })
    ).resolves.toBe('/lab/pA');
    await expect(
      findEnclosingSequencePackageRoot('/lab/pA/assets/gel.png', { exists })
    ).resolves.toBe('/lab/pA');
    await expect(
      findEnclosingSequencePackageRoot('/lab/pA/files/clone-1.fasta', { exists })
    ).resolves.toBe('/lab/pA');
    await expect(
      findEnclosingSequencePackageRoot('/lab/pA/primers/order.csv', { exists })
    ).resolves.toBe('/lab/pA');
    await expect(findEnclosingSequencePackageRoot('/lab/pA/loose.ab1', { exists })).resolves.toBe(
      '/lab/pA'
    );
    await expect(
      findEnclosingSequencePackageRoot('/lab/pA/reads/nested.ab1', { exists })
    ).resolves.toBeNull();
    await expect(
      findEnclosingSequencePackageRoot('/downloads/clone-1.fasta', { exists })
    ).resolves.toBeNull();
  });

  it('refuses to attach with an unknown role', async () => {
    const fs = {
      exists: vi.fn().mockResolvedValue(true),
      readTextFile: vi.fn().mockResolvedValue(
        serializeSequencePackageDocument(
          buildSequencePackageDocument({
            id: 'pkg-1',
            name: 'pUC19',
            product: { file: 'pUC19.gb' },
          })
        )
      ),
      writeTextFile: vi.fn(),
      mkdir: vi.fn(),
      move: vi.fn(),
    };
    await expect(
      addSequencePackageMember({
        packageRoot: '/lab/pUC19',
        role: 'sequencing_read',
        sourcePath: '/downloads/clone-1.fasta',
        fs,
      })
    ).rejects.toThrow(/Unknown sequence package member role/);
  });
});

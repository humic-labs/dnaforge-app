// @vitest-environment node

import { createHash } from 'node:crypto';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  SEQUENCE_PACKAGE_FORMAT_VERSION,
  SEQUENCE_PACKAGE_MIGRATORS,
} from './sequence-package-contract';
import { loadSequencePackageDocument } from './sequence-package-io';
import { sequencePackagePaths } from './sequence-package';

const FIXTURE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '__fixtures__/sequence-packages'
);

interface MigrationExpect {
  from: number;
  productFile: string;
  survivors: Array<{ before: string; after: string }>;
  unchanged: string[];
  gone: string[];
  members: Array<{ role: string; path: string }>;
  noAssemblyPrimers?: boolean;
  acceptedPreserved?: boolean;
}

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
    writeWorkspaceTextFileAtomic: async (input: {
      path: string;
      content: string;
      expectedContentHash?: string;
    }) => {
      const before = await readFile(input.path);
      if (sha256(before) !== input.expectedContentHash) {
        const error = new Error('Package marker changed during migration.');
        error.name = 'WorkspaceFilePreconditionError';
        throw error;
      }
      await writeFile(input.path, input.content, 'utf8');
      return { path: input.path };
    },
    mkdir: (path: string, options?: { recursive?: boolean }) => mkdir(path, options),
    move: async (sourcePath: string, destinationDir: string) => {
      const destPath = join(destinationDir, basename(sourcePath));
      await rename(sourcePath, destPath);
      return { destPath };
    },
    unlink: (path: string) => unlink(path),
    rename: (from: string, to: string) => rename(from, to),
    readFile: async (path: string) => new Uint8Array(await readFile(path)),
    writeFile: (path: string, contents: Uint8Array) => writeFile(path, contents),
  };
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function listFixtureDirs(): Promise<string[]> {
  const names = await readdir(FIXTURE_ROOT);
  const dirs: string[] = [];
  for (const name of names) {
    if (!name.startsWith('v')) continue;
    const abs = join(FIXTURE_ROOT, name);
    if ((await stat(abs)).isDirectory()) dirs.push(abs);
  }
  return dirs.sort();
}

describe('sequence package migration datasets', () => {
  it('retains optional member metadata when a legacy attachment package migrates and reopens', async () => {
    const fixture = join(FIXTURE_ROOT, 'v8-user-attachment');
    const temporary = await mkdtemp(join(tmpdir(), 'seq-pkg-member-metadata-'));
    const root = join(temporary, 'pkg');
    try {
      await cp(fixture, root, { recursive: true });
      const metaPath = sequencePackagePaths(root).metaPath;
      const original = JSON.parse(await readFile(metaPath, 'utf8'));
      const extensions = {
        'org.example.attachment-review': {
          version: 3,
          data: {
            reviewer: { label: 'external review' },
            tags: ['retained', null],
            accepted: true,
          },
        },
      };
      const members = original.members.map((member: Record<string, unknown>) => ({
        ...member,
        extensions,
      }));
      await writeFile(metaPath, JSON.stringify({ ...original, members }, null, 2) + '\n');
      const productBytes = await readFile(join(root, original.product.file));
      const attachmentBytes = await readFile(join(root, original.members[0].path));

      const migrated = await loadSequencePackageDocument(root, nodePackageFs());
      expect(migrated.formatVersion).toBe(SEQUENCE_PACKAGE_FORMAT_VERSION);
      expect(migrated.id).toBe(original.id);
      expect(migrated.name).toBe(original.name);
      expect(migrated.product).toEqual(original.product);
      expect(migrated.userAttachments).toEqual(original.userAttachments);
      expect(migrated.members).toEqual(members);
      const migratedBytes = await readFile(metaPath, 'utf8');
      expect(JSON.parse(migratedBytes).members).toEqual(members);

      const reopened = await loadSequencePackageDocument(root, nodePackageFs());
      expect(reopened).toEqual(migrated);
      expect(reopened.members).toEqual(members);
      expect(await readFile(metaPath, 'utf8')).toBe(migratedBytes);
      expect(await readFile(join(root, original.product.file))).toEqual(productBytes);
      expect(await readFile(join(root, original.members[0].path))).toEqual(attachmentBytes);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it('has a fixture dataset for every registered migrator from-version', async () => {
    const dirs = await listFixtureDirs();
    const foundFrom = new Set(
      dirs.map((dir) => {
        const match = basename(dir).match(/^v(\d+)-/);
        return match ? Number(match[1]) : NaN;
      })
    );
    for (const step of SEQUENCE_PACKAGE_MIGRATORS) {
      expect(foundFrom.has(step.from), `missing fixture directory v${step.from}-*`).toBe(true);
    }
  });

  it('migrates every checked-in dataset with byte-identical survivors', async () => {
    const dirs = await listFixtureDirs();
    expect(dirs.length).toBeGreaterThan(0);

    for (const fixtureDir of dirs) {
      const expectPath = join(fixtureDir, 'migration-expect.json');
      const spec = JSON.parse(await readFile(expectPath, 'utf8')) as MigrationExpect;
      const root = join(await mkdtemp(join(tmpdir(), `seq-pkg-${basename(fixtureDir)}-`)), 'pkg');
      await cp(fixtureDir, root, { recursive: true });
      const beforeAssembly = spec.acceptedPreserved
        ? JSON.parse(await readFile(join(root, '.forge/plasmid.json'), 'utf8')).assembly
        : undefined;

      const beforeHashes = new Map<string, string>();
      for (const item of spec.survivors) {
        beforeHashes.set(item.before, sha256(await readFile(join(root, item.before))));
      }
      for (const rel of spec.unchanged) {
        beforeHashes.set(rel, sha256(await readFile(join(root, rel))));
      }

      const doc = await loadSequencePackageDocument(root, nodePackageFs());
      expect(doc.formatVersion, basename(fixtureDir)).toBe(SEQUENCE_PACKAGE_FORMAT_VERSION);
      expect(doc.product.file, basename(fixtureDir)).toBe(spec.productFile);
      if (spec.acceptedPreserved) {
        expect(doc.assembly, basename(fixtureDir)).toEqual(beforeAssembly);
        const reopened = await loadSequencePackageDocument(root, nodePackageFs());
        expect(reopened.assembly, `${basename(fixtureDir)} after second open`).toEqual(
          beforeAssembly
        );
      }
      if (spec.noAssemblyPrimers) {
        expect(doc.assembly?.primers, basename(fixtureDir)).toBeUndefined();
      }
      for (const member of spec.members) {
        expect(
          doc.members.some((entry) => entry.role === member.role && entry.path === member.path),
          `${basename(fixtureDir)} missing member ${member.role} ${member.path}`
        ).toBe(true);
      }
      if (basename(fixtureDir) === 'v7-user-attachment') {
        expect(doc.userAttachments['legacy-note']).toEqual({
          memberId: 'legacy-note',
          sha256: null,
        });
        expect(
          doc.versionHistory.revisions.every(
            (revision) => revision.state.userAttachments === undefined
          )
        ).toBe(true);
      }

      for (const item of spec.survivors) {
        const after = await readFile(join(root, item.after));
        expect(sha256(after), `${basename(fixtureDir)} ${item.after}`).toBe(
          beforeHashes.get(item.before)
        );
      }
      for (const rel of spec.unchanged) {
        const after = await readFile(join(root, rel));
        expect(sha256(after), `${basename(fixtureDir)} ${rel} mutated`).toBe(beforeHashes.get(rel));
      }
      for (const rel of spec.gone) {
        await expect(
          stat(join(root, rel)),
          `${basename(fixtureDir)} still has ${rel}`
        ).rejects.toThrow();
      }
    }
  });
});

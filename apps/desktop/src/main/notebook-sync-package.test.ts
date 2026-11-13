import { mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildNotebookPackageMetadata,
  serializeNotebookPackageMetadata,
} from '../db/notebook-package';
import { serializeNotebookMarkdown } from '../db/notebook-markdown-codec';
import {
  readValidatedNotebookSyncMemberBytes,
  validatedNotebookMarkdownSyncFile,
  validatedNotebookSyncPackage,
  validatedNotebookSyncMemberContainsMarker,
} from './notebook-sync-package';

const TEST_LIMITS = {
  maxMemberBytes: 1024 * 1024,
  maxMembers: 100,
  maxTotalBytes: 512 * 1024 * 1024,
};

const cleanupRoots: string[] = [];

async function temporaryRoot(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), name));
  cleanupRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function writeNotebookPackage(workspaceRoot: string): Promise<{
  packageRoot: string;
  markdownPath: string;
  markdown: string;
}> {
  const packageRoot = join(workspaceRoot, 'Lab notes');
  const markdownPath = join(packageRoot, 'Lab notes.md');
  const canonical = serializeNotebookMarkdown({
    identity: { id: 'page-1', title: 'Lab notes', formatVersion: 2 },
    content: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first revision' }] }],
    },
  });
  await mkdir(join(packageRoot, '.forge', 'blocks'), { recursive: true });
  await writeFile(markdownPath, canonical.markdown, 'utf8');
  for (const payload of canonical.payloads) {
    await writeFile(join(packageRoot, payload.relativePath), payload.content, 'utf8');
  }
  await writeFile(
    join(packageRoot, '.forge', 'notebook.json'),
    serializeNotebookPackageMetadata(
      buildNotebookPackageMetadata({
        id: 'page-1',
        title: 'Lab notes',
        markdownFileName: 'Lab notes.md',
        updatedAt: '2026-08-25T00:00:00.000Z',
      })
    ),
    'utf8'
  );
  return { packageRoot, markdownPath, markdown: canonical.markdown };
}

async function writeTwoPayloadRevision(packageRoot: string): Promise<{
  markdownPath: string;
  payloadPaths: string[];
}> {
  const serialized = serializeNotebookMarkdown({
    identity: { id: 'page-1', title: 'Lab notes', formatVersion: 2 },
    content: {
      type: 'doc',
      content: [
        { type: 'unsupported-budget-canary', attrs: { ordinal: 1 } },
        { type: 'unsupported-budget-canary', attrs: { ordinal: 2 } },
      ],
    },
  });
  expect(serialized.payloads).toHaveLength(2);
  const markdownPath = join(packageRoot, 'Lab notes.md');
  await writeFile(markdownPath, serialized.markdown, 'utf8');
  for (const payload of serialized.payloads) {
    await writeFile(join(packageRoot, payload.relativePath), payload.content, 'utf8');
  }
  return {
    markdownPath,
    payloadPaths: serialized.payloads.map((payload) => join(packageRoot, payload.relativePath)),
  };
}

describe('validatedNotebookSyncPackage', () => {
  it('captures an externally rewritten markerless notebook using its package identity', async () => {
    const workspaceRoot = await temporaryRoot('dnaforge-notebook-markerless-sync-');
    const { packageRoot, markdownPath } = await writeNotebookPackage(workspaceRoot);
    await writeFile(markdownPath, '# Lab notes\n\nExternal revision.\n');
    const captured = await validatedNotebookSyncPackage(workspaceRoot, packageRoot, TEST_LIMITS);
    expect(captured?.members.some((member) => member.absolutePath === markdownPath)).toBe(true);
  });
  it('pins every authority member to one file identity before a later bounded read', async () => {
    const workspaceRoot = await temporaryRoot('dnaforge-notebook-sync-capture-');
    const { packageRoot, markdownPath, markdown } = await writeNotebookPackage(workspaceRoot);

    const captured = await validatedNotebookSyncPackage(workspaceRoot, packageRoot, TEST_LIMITS);
    await writeFile(markdownPath, 'external later revision', 'utf8');

    const markdownMember = captured?.members.find((member) => member.absolutePath === markdownPath);
    expect(markdownMember?.deferredIdentity).toBeDefined();
    await expect(
      readValidatedNotebookSyncMemberBytes(markdownMember!, TEST_LIMITS.maxMemberBytes)
    ).rejects.toThrow('changed before capture');
    expect(markdown).toContain('first revision');
    expect(await readFile(markdownPath, 'utf8')).toBe('external later revision');
  });

  it.each(['replacement', 'symlink'] as const)(
    'rejects a package-shaped Markdown %s after marker inspection',
    async (replacementShape) => {
      const workspaceRoot = await temporaryRoot('dnaforge-notebook-sync-marker-race-');
      const packageRoot = join(workspaceRoot, 'Loose notes');
      const markdownPath = join(packageRoot, 'Loose notes.md');
      await mkdir(packageRoot, { recursive: true });
      await writeFile(markdownPath, '# ordinary notes\n', 'utf8');
      const captured = await validatedNotebookMarkdownSyncFile(workspaceRoot, markdownPath);
      expect(await validatedNotebookSyncMemberContainsMarker(captured)).toBe(false);

      await rm(markdownPath);
      if (replacementShape === 'replacement') {
        const canonical = serializeNotebookMarkdown({
          identity: { id: 'replacement-page', title: 'Loose notes', formatVersion: 2 },
          content: { type: 'doc', content: [{ type: 'paragraph' }] },
        });
        await writeFile(markdownPath, canonical.markdown, 'utf8');
      } else {
        const secretPath = join(workspaceRoot, 'secret.txt');
        await writeFile(secretPath, 'do not capture', 'utf8');
        await symlink(secretPath, markdownPath);
      }

      await expect(readValidatedNotebookSyncMemberBytes(captured, 1024)).rejects.toThrow(
        'changed before capture'
      );
    }
  );

  it('rejects marked nested notebook Markdown inside assets', async () => {
    const workspaceRoot = await temporaryRoot('dnaforge-notebook-sync-nested-asset-');
    const { packageRoot } = await writeNotebookPackage(workspaceRoot);
    const nestedRoot = join(packageRoot, 'assets', 'Inner');
    const canonical = serializeNotebookMarkdown({
      identity: { id: 'inner-page', title: 'Inner', formatVersion: 2 },
      content: { type: 'doc', content: [{ type: 'paragraph' }] },
    });
    await mkdir(nestedRoot, { recursive: true });
    await writeFile(join(nestedRoot, 'Inner.md'), canonical.markdown, 'utf8');

    await expect(
      validatedNotebookSyncPackage(workspaceRoot, packageRoot, TEST_LIMITS)
    ).rejects.toThrow('nested notebook Markdown');
  });

  it('records asset identities and sizes without loading their bytes into memory', async () => {
    const workspaceRoot = await temporaryRoot('dnaforge-notebook-sync-assets-');
    const { packageRoot } = await writeNotebookPackage(workspaceRoot);
    const assetsRoot = join(packageRoot, 'assets');
    await mkdir(assetsRoot, { recursive: true });
    const sparseAssetBytes = 64 * 1024 * 1024;
    for (let index = 0; index < 4; index += 1) {
      const assetPath = join(assetsRoot, `oversized-${index}.bin`);
      await writeFile(assetPath, '');
      await truncate(assetPath, sparseAssetBytes);
    }

    const captured = await validatedNotebookSyncPackage(workspaceRoot, packageRoot, {
      ...TEST_LIMITS,
      maxParsedMemberBytes: 4 * 1024,
    });
    const assets = captured?.members.filter((member) => member.packageAsset) ?? [];

    expect(assets).toHaveLength(4);
    expect(assets.every((member) => member.deferredIdentity !== undefined)).toBe(true);
    expect(assets.map((member) => member.sizeBytes)).toEqual(Array(4).fill(sparseAssetBytes));
  });

  it('treats the Markdown title as authority when metadata still has the previous title', async () => {
    const workspaceRoot = await temporaryRoot('dnaforge-notebook-sync-title-');
    const { packageRoot } = await writeNotebookPackage(workspaceRoot);
    await writeFile(
      join(packageRoot, '.forge', 'notebook.json'),
      serializeNotebookPackageMetadata(
        buildNotebookPackageMetadata({
          id: 'page-1',
          title: 'Previous title',
          markdownFileName: 'Lab notes.md',
          updatedAt: '2026-08-25T00:00:00.000Z',
        })
      ),
      'utf8'
    );

    await expect(
      validatedNotebookSyncPackage(workspaceRoot, packageRoot, TEST_LIMITS)
    ).resolves.toMatchObject({ notebookId: 'page-1' });
  });

  it('refuses to snapshot stale v1 metadata after marked canonical Markdown was published', async () => {
    const workspaceRoot = await temporaryRoot('dnaforge-notebook-sync-interrupted-');
    const { packageRoot } = await writeNotebookPackage(workspaceRoot);
    await writeFile(
      join(packageRoot, '.forge', 'notebook.json'),
      JSON.stringify({
        schema: 'waypoint.notebook.v1',
        kind: 'notebook',
        id: 'page-1',
        title: 'Stale v1 title',
        content: { type: 'doc', content: [{ type: 'paragraph' }] },
        storage: { type: 'database', table: 'pages', id: 'page-1' },
        updatedAt: '2026-08-24T00:00:00.000Z',
      }),
      'utf8'
    );

    await expect(
      validatedNotebookSyncPackage(workspaceRoot, packageRoot, TEST_LIMITS)
    ).rejects.toThrow('published Markdown before metadata');
  });

  it('rejects an archive path that traverses an intermediate symlink', async () => {
    const workspaceRoot = await temporaryRoot('dnaforge-notebook-sync-link-');
    const { packageRoot } = await writeNotebookPackage(workspaceRoot);
    const realArchiveRoot = join(packageRoot, '.forge', 'real-migrations');
    const migrationsRoot = join(packageRoot, '.forge', 'migrations');
    await mkdir(realArchiveRoot, { recursive: true });
    await mkdir(migrationsRoot, { recursive: true });
    await writeFile(join(realArchiveRoot, 'legacy.json'), '{}', 'utf8');
    await symlink('../real-migrations', join(migrationsRoot, 'linked'), 'dir');
    await writeFile(
      join(packageRoot, '.forge', 'notebook.json'),
      serializeNotebookPackageMetadata(
        buildNotebookPackageMetadata({
          id: 'page-1',
          title: 'Lab notes',
          markdownFileName: 'Lab notes.md',
          updatedAt: '2026-08-25T00:00:00.000Z',
          migration: {
            fromFormatVersion: 1,
            completedAt: '2026-08-25T00:00:00.000Z',
            archivePath: 'migrations/linked/legacy.json',
            sourceShape: 'v1-package',
          },
        })
      ),
      'utf8'
    );

    await expect(
      validatedNotebookSyncPackage(workspaceRoot, packageRoot, TEST_LIMITS)
    ).rejects.toThrow(/symbolic link|real directory/i);
  });

  it('pins a migration archive identity before its later bounded read', async () => {
    const workspaceRoot = await temporaryRoot('dnaforge-notebook-sync-archive-capture-');
    const { packageRoot } = await writeNotebookPackage(workspaceRoot);
    const archivePath = join(packageRoot, '.forge', 'migrations', 'legacy.json');
    await mkdir(join(packageRoot, '.forge', 'migrations'), { recursive: true });
    await writeFile(archivePath, '{"revision":"validated"}\n', 'utf8');
    await writeFile(
      join(packageRoot, '.forge', 'notebook.json'),
      serializeNotebookPackageMetadata(
        buildNotebookPackageMetadata({
          id: 'page-1',
          title: 'Lab notes',
          markdownFileName: 'Lab notes.md',
          updatedAt: '2026-08-25T00:00:00.000Z',
          migration: {
            fromFormatVersion: 1,
            completedAt: '2026-08-25T00:00:00.000Z',
            archivePath: 'migrations/legacy.json',
            sourceShape: 'v1-package',
          },
        })
      ),
      'utf8'
    );

    const captured = await validatedNotebookSyncPackage(workspaceRoot, packageRoot, TEST_LIMITS);
    const archiveMember = captured?.members.find((member) => member.absolutePath === archivePath);
    await writeFile(archivePath, '{"revision":"external"}\n', 'utf8');

    await expect(
      readValidatedNotebookSyncMemberBytes(archiveMember!, TEST_LIMITS.maxMemberBytes)
    ).rejects.toThrow('changed before capture');
  });

  it('rejects an oversized migration archive before allocating its body', async () => {
    const workspaceRoot = await temporaryRoot('dnaforge-notebook-sync-large-archive-');
    const { packageRoot } = await writeNotebookPackage(workspaceRoot);
    const archivePath = join(packageRoot, '.forge', 'migrations', 'legacy.json');
    await mkdir(join(packageRoot, '.forge', 'migrations'), { recursive: true });
    await writeFile(archivePath, '', 'utf8');
    await truncate(archivePath, TEST_LIMITS.maxMemberBytes + 1);
    await writeFile(
      join(packageRoot, '.forge', 'notebook.json'),
      serializeNotebookPackageMetadata(
        buildNotebookPackageMetadata({
          id: 'page-1',
          title: 'Lab notes',
          markdownFileName: 'Lab notes.md',
          updatedAt: '2026-08-25T00:00:00.000Z',
          migration: {
            fromFormatVersion: 1,
            completedAt: '2026-08-25T00:00:00.000Z',
            archivePath: 'migrations/legacy.json',
            sourceShape: 'v1-package',
          },
        })
      ),
      'utf8'
    );

    const captured = await validatedNotebookSyncPackage(workspaceRoot, packageRoot, TEST_LIMITS);
    const archiveMember = captured?.members.find((member) => member.absolutePath === archivePath);
    expect(archiveMember?.deferredIdentity).toBeDefined();
    await expect(
      readValidatedNotebookSyncMemberBytes(archiveMember!, TEST_LIMITS.maxMemberBytes)
    ).rejects.toThrow('exceeds its byte limit');
  });

  it('rejects interrupted new-package publication that has Markdown but no metadata', async () => {
    const workspaceRoot = await temporaryRoot('dnaforge-notebook-sync-no-metadata-');
    const { packageRoot } = await writeNotebookPackage(workspaceRoot);
    await rm(join(packageRoot, '.forge', 'notebook.json'));

    await expect(
      validatedNotebookSyncPackage(workspaceRoot, packageRoot, TEST_LIMITS)
    ).rejects.toThrow('canonical Markdown exists without metadata');
  });

  it.each(['metadata', 'markdown', 'payload'] as const)(
    'keeps parsed %s below a separate in-memory cap',
    async (memberKind) => {
      const workspaceRoot = await temporaryRoot(`dnaforge-notebook-sync-parsed-${memberKind}-`);
      const { packageRoot } = await writeNotebookPackage(workspaceRoot);
      const { markdownPath, payloadPaths } = await writeTwoPayloadRevision(packageRoot);
      const target =
        memberKind === 'metadata'
          ? join(packageRoot, '.forge', 'notebook.json')
          : memberKind === 'markdown'
            ? markdownPath
            : payloadPaths[0];
      const original = await readFile(target, 'utf8');
      await writeFile(target, original.padEnd(8 * 1024, ' '), 'utf8');

      await expect(
        validatedNotebookSyncPackage(workspaceRoot, packageRoot, {
          ...TEST_LIMITS,
          maxParsedMemberBytes: 4 * 1024,
        })
      ).rejects.toThrow('exceeds its byte limit');
    }
  );

  it.each(['metadata', 'markdown', 'payload'] as const)(
    'rejects oversized sparse %s before allocating its body',
    async (memberKind) => {
      const workspaceRoot = await temporaryRoot(`dnaforge-notebook-sync-large-${memberKind}-`);
      const { packageRoot, markdownPath, markdown } = await writeNotebookPackage(workspaceRoot);
      const metadataPath = join(packageRoot, '.forge', 'notebook.json');
      const payloadPath = join(
        packageRoot,
        serializeNotebookMarkdown({
          identity: { id: 'page-1', title: 'Lab notes', formatVersion: 2 },
          content: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first revision' }] }],
          },
        }).payloads[0].relativePath
      );
      const target =
        memberKind === 'metadata'
          ? metadataPath
          : memberKind === 'markdown'
            ? markdownPath
            : payloadPath;
      if (memberKind === 'payload') expect(markdown).toContain('.forge/blocks/');
      await truncate(target, TEST_LIMITS.maxMemberBytes + 1);

      await expect(
        validatedNotebookSyncPackage(workspaceRoot, packageRoot, TEST_LIMITS)
      ).rejects.toThrow('exceeds its byte limit');
    }
  );

  it('bounds asset enumeration at the declared member limit', async () => {
    const workspaceRoot = await temporaryRoot('dnaforge-notebook-sync-many-assets-');
    const { packageRoot } = await writeNotebookPackage(workspaceRoot);
    const assetsRoot = join(packageRoot, 'assets');
    await mkdir(assetsRoot, { recursive: true });
    await Promise.all(
      Array.from({ length: 4 }, (_, index) => writeFile(join(assetsRoot, `${index}.txt`), 'x'))
    );

    await expect(
      validatedNotebookSyncPackage(workspaceRoot, packageRoot, {
        maxMemberBytes: TEST_LIMITS.maxMemberBytes,
        maxMembers: 3,
        maxTotalBytes: TEST_LIMITS.maxTotalBytes,
      })
    ).rejects.toThrow('member-count limit');
  });

  it('bounds asset directory enumeration even when entries are empty directories', async () => {
    const workspaceRoot = await temporaryRoot('dnaforge-notebook-sync-many-directories-');
    const { packageRoot } = await writeNotebookPackage(workspaceRoot);
    const assetsRoot = join(packageRoot, 'assets');
    await mkdir(assetsRoot, { recursive: true });
    await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        mkdir(join(assetsRoot, `directory-${index}`), { recursive: true })
      )
    );

    await expect(
      validatedNotebookSyncPackage(workspaceRoot, packageRoot, {
        maxMemberBytes: TEST_LIMITS.maxMemberBytes,
        maxMembers: 3,
        maxTotalBytes: TEST_LIMITS.maxTotalBytes,
      })
    ).rejects.toThrow('directory-entry limit');
  });

  it('rejects referenced payloads beyond the total member budget before reading them', async () => {
    const workspaceRoot = await temporaryRoot('dnaforge-notebook-sync-payload-count-');
    const { packageRoot } = await writeNotebookPackage(workspaceRoot);
    const { payloadPaths } = await writeTwoPayloadRevision(packageRoot);
    await writeFile(payloadPaths[1], Buffer.from([0xff]));

    await expect(
      validatedNotebookSyncPackage(workspaceRoot, packageRoot, {
        maxMemberBytes: TEST_LIMITS.maxMemberBytes,
        maxMembers: 3,
        maxTotalBytes: TEST_LIMITS.maxTotalBytes,
      })
    ).rejects.toThrow('member-count limit');
  });

  it('rejects referenced payloads beyond the aggregate byte budget before reading them', async () => {
    const workspaceRoot = await temporaryRoot('dnaforge-notebook-sync-payload-bytes-');
    const { packageRoot } = await writeNotebookPackage(workspaceRoot);
    const { markdownPath, payloadPaths } = await writeTwoPayloadRevision(packageRoot);
    await writeFile(payloadPaths[1], Buffer.from([0xff]));
    const admittedBytes =
      (await readFile(join(packageRoot, '.forge', 'notebook.json'))).byteLength +
      (await readFile(markdownPath)).byteLength +
      (await readFile(payloadPaths[0])).byteLength;

    await expect(
      validatedNotebookSyncPackage(workspaceRoot, packageRoot, {
        maxMemberBytes: TEST_LIMITS.maxMemberBytes,
        maxMembers: TEST_LIMITS.maxMembers,
        maxTotalBytes: admittedBytes,
      })
    ).rejects.toThrow('aggregate byte limit');
  });
});

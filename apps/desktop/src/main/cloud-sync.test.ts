import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decodeBundleFileContent,
  DEFAULT_SHARE_BUNDLE_LIMITS,
  validateShareBundle,
} from '@waypoint/share-bundle';

vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.4.0',
    getPath: () => tmpdir(),
  },
}));
vi.mock('./auth/session-store', () => ({ getActiveStoredSession: vi.fn() }));
vi.mock('./auth/auth-config', () => ({ getWebBaseUrl: () => 'https://dnaforge.test' }));
vi.mock('./ipc/database', () => ({ getDb: vi.fn() }));
vi.mock('./ipc/path-allowlist', () => ({ assertSafePath: vi.fn() }));
vi.mock('./ipc/workspace-git', () => ({ managedRootDir: vi.fn() }));
vi.mock('./workspace-git/import', () => ({ importIntoManagedWorkspaceRepo: vi.fn() }));

import { buildShareBundle } from './cloud-sync';
import {
  buildNotebookPackageMetadata,
  serializeNotebookPackageMetadata,
} from '../db/notebook-package';
import { serializeNotebookMarkdown } from '../db/notebook-markdown-codec';

let tempRoot: string | null = null;

afterEach(async () => {
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
});

describe('cloud sync snapshot producer', () => {
  it('preserves a transportable legacy backup above the hosted per-file limit', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'dnaforge-cloud-sync-legacy-cap-'));
    const content = 'A'.repeat(9 * 1024 * 1024);
    await writeFile(join(tempRoot, 'large-design.gb'), content, 'utf8');

    const bundle = await buildShareBundle({
      workspaceName: 'Project',
      roots: [{ path: tempRoot, name: 'Project' }],
    });

    expect(bundle.files).toHaveLength(1);
    expect(bundle.files[0]).toMatchObject({
      relativePath: 'Project/large-design.gb',
      sizeBytes: Buffer.byteLength(content, 'utf8'),
    });
    expect(bundle.excludedFiles).toEqual([]);
  });

  it('includes small design files, excludes private raw data, and never serializes absolute paths', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'dnaforge-cloud-sync-'));
    await writeFile(join(tempRoot, 'plasmid.gb'), 'LOCUS       TEST\nORIGIN\n//\n', 'utf8');
    await writeFile(join(tempRoot, 'reads.fastq'), '@read\nACGT\n+\n!!!!\n', 'utf8');

    const bundle = await buildShareBundle({
      workspaceName: 'Project',
      roots: [{ path: tempRoot, name: 'Project' }],
    });

    expect(bundle.files.map((file) => file.relativePath)).toEqual(['Project/plasmid.gb']);
    expect(bundle.schemaVersion).toBe(2);
    expect(validateShareBundle(bundle)).toMatchObject({ ok: true });
    expect(bundle.excludedFiles).toEqual([
      {
        relativePath: 'Project/reads.fastq',
        reason: 'private-raw-data',
        sizeBytes: expect.any(Number),
      },
    ]);
    expect(JSON.stringify(bundle)).not.toContain(tempRoot);
    expect(bundle.provenance.contentSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('excludes a notebook asset above the bundle cap without rejecting its authority', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'dnaforge-cloud-sync-large-notebook-asset-'));
    await writeCloudNotebookPackage(tempRoot, 'Lab notes', 'page-large-asset');
    const privateAsset = join(tempRoot, 'Lab notes', 'assets', 'reads.fastq');
    await mkdir(join(tempRoot, 'Lab notes', 'assets'), { recursive: true });
    await writeFile(privateAsset, '');
    await truncate(privateAsset, DEFAULT_SHARE_BUNDLE_LIMITS.maxBundleBytes + 1);

    const bundle = await buildShareBundle({
      workspaceName: 'Project',
      roots: [{ path: tempRoot, name: 'Project' }],
    });

    expect(bundle.files.map((file) => file.relativePath)).toEqual(
      expect.arrayContaining([
        'Project/Lab notes/.forge/notebook.json',
        'Project/Lab notes/Lab notes.md',
      ])
    );
    expect(bundle.excludedFiles).toContainEqual({
      relativePath: 'Project/Lab notes/assets/reads.fastq',
      reason: 'private-raw-data',
      sizeBytes: DEFAULT_SHARE_BUNDLE_LIMITS.maxBundleBytes + 1,
    });
  });

  it('excludes a notebook package atomically when its migration archive exceeds the bundle cap', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'dnaforge-cloud-sync-large-notebook-archive-'));
    await writeCloudNotebookPackage(tempRoot, 'Lab notes', 'page-large-archive');
    await writeFile(join(tempRoot, 'plasmid.gb'), 'LOCUS       TEST\nORIGIN\n//\n', 'utf8');
    const archivePath = join(tempRoot, 'Lab notes', '.forge', 'migrations', 'legacy.json');
    await mkdir(join(tempRoot, 'Lab notes', '.forge', 'migrations'), { recursive: true });
    await writeFile(archivePath, '');
    await truncate(archivePath, DEFAULT_SHARE_BUNDLE_LIMITS.maxBundleBytes + 1);
    await writeFile(
      join(tempRoot, 'Lab notes', '.forge', 'notebook.json'),
      serializeNotebookPackageMetadata(
        buildNotebookPackageMetadata({
          id: 'page-large-archive',
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

    const bundle = await buildShareBundle({
      workspaceName: 'Project',
      roots: [{ path: tempRoot, name: 'Project' }],
    });

    expect(bundle.files.map((file) => file.relativePath)).toEqual(['Project/plasmid.gb']);
    expect(bundle.excludedFiles.some((file) => file.reason === 'file-too-large')).toBe(true);
  });

  it('never exports installation-global LIMS data in a new public share', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'dnaforge-cloud-sync-lims-'));
    const limsRoot = join(tempRoot, '.waypoint', 'lims');
    await mkdir(join(limsRoot, 'log'), { recursive: true });
    await mkdir(join(limsRoot, 'sheets'), { recursive: true });
    await writeFile(join(tempRoot, 'project.gb'), 'LOCUS       PROJECT\nORIGIN\n//\n', 'utf8');
    await writeFile(join(limsRoot, 'manifest.json'), '{"private":"manifest"}', 'utf8');
    await writeFile(join(limsRoot, 'log', 'events.jsonl'), '{"private":"event"}\n', 'utf8');
    await writeFile(join(limsRoot, 'sheets', 'oligos.csv'), 'private,oligo\n', 'utf8');

    const bundle = await buildShareBundle({
      workspaceName: 'Project',
      roots: [{ path: tempRoot, name: 'Project' }],
    });

    expect(bundle.files.map((file) => file.relativePath)).toEqual(['Project/project.gb']);
    expect(JSON.stringify(bundle)).not.toContain('private');
    expect(bundle.files.every((file) => !file.relativePath.includes('.waypoint/lims'))).toBe(true);
  });

  it('backs up the hidden build record inside a plasmid package without opening arbitrary hidden directories', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'dnaforge-cloud-sync-package-'));
    const packageRoot = join(tempRoot, 'Accepted construct');
    await mkdir(join(packageRoot, '.forge'), { recursive: true });
    await mkdir(join(tempRoot, '.private'), { recursive: true });
    await mkdir(join(tempRoot, 'analysis', '.forge'), { recursive: true });
    await writeFile(
      join(packageRoot, 'Accepted construct.gb'),
      'LOCUS       ACCEPTED\nORIGIN\n//\n',
      'utf8'
    );
    await writeFile(
      join(packageRoot, '.forge', 'plasmid.json'),
      JSON.stringify({
        schema: 'waypoint.plasmid.v1',
        kind: 'plasmid',
        id: 'accepted-package',
        name: 'Accepted construct',
        product: { file: 'Accepted construct.gb' },
        assembly: { accepted: { designId: 'design-1' } },
      }),
      'utf8'
    );
    await writeFile(join(tempRoot, '.private', 'secret.gb'), 'LOCUS SECRET\n', 'utf8');
    await writeFile(
      join(tempRoot, 'analysis', '.forge', 'secret.gb'),
      'LOCUS SECRET TWO\n',
      'utf8'
    );

    const bundle = await buildShareBundle({
      workspaceName: 'Project',
      roots: [{ path: tempRoot, name: 'Project' }],
    });

    expect(bundle.files.map((file) => file.relativePath).sort()).toEqual([
      'Project/Accepted construct/.forge/plasmid.json',
      'Project/Accepted construct/Accepted construct.gb',
    ]);
    expect(JSON.stringify(bundle)).not.toContain('secret.gb');
  });

  it('backs up the product bytes and marker for a symlink-backed plasmid package', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'dnaforge-cloud-sync-symlink-package-'));
    const packageRoot = join(tempRoot, 'Linked construct');
    const backingRoot = join(tempRoot, 'backing');
    const productContent = 'LOCUS       LINKED\nORIGIN\n        1 acgt\n//\n';
    await mkdir(join(packageRoot, '.forge'), { recursive: true });
    await mkdir(backingRoot, { recursive: true });
    await writeFile(join(backingRoot, 'linked.source'), productContent, 'utf8');
    await symlink('../backing/linked.source', join(packageRoot, 'Linked construct.gb'));
    await writeFile(
      join(packageRoot, '.forge', 'plasmid.json'),
      JSON.stringify({
        schema: 'waypoint.plasmid.v1',
        kind: 'plasmid',
        id: 'linked-package',
        name: 'Linked construct',
        product: { file: 'Linked construct.gb' },
      }),
      'utf8'
    );

    const bundle = await buildShareBundle({
      workspaceName: 'Project',
      roots: [{ path: tempRoot, name: 'Project' }],
    });

    expect(bundle.files.map((file) => file.relativePath).sort()).toEqual([
      'Project/Linked construct/.forge/plasmid.json',
      'Project/Linked construct/Linked construct.gb',
    ]);
    expect(
      bundle.files.find(
        (file) => file.relativePath === 'Project/Linked construct/Linked construct.gb'
      )?.content
    ).toBe(productContent);
  });

  it('backs up a validated notebook package with binary assets and excludes unrelated assets', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'dnaforge-cloud-sync-notebook-'));
    const packageRoot = join(tempRoot, 'Lab notes');
    await mkdir(join(packageRoot, '.forge'), { recursive: true });
    await mkdir(join(packageRoot, 'assets'), { recursive: true });
    await mkdir(join(tempRoot, 'unrelated', 'assets'), { recursive: true });
    const canonical = serializeNotebookMarkdown({
      identity: { id: 'page-1', title: 'Lab notes', formatVersion: 2 },
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'canonical' }] }],
      },
    });
    await mkdir(join(packageRoot, '.forge', 'blocks'), { recursive: true });
    await writeFile(join(packageRoot, 'Lab notes.md'), canonical.markdown, 'utf8');
    for (const payload of canonical.payloads) {
      await writeFile(
        join(packageRoot, ...payload.relativePath.split('/')),
        payload.content,
        'utf8'
      );
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
    const binaryAsset = Buffer.from([0xff, 0x00, 0x80]);
    await writeFile(join(packageRoot, 'assets', 'model.bin'), binaryAsset);
    await writeFile(join(packageRoot, '.forge', 'blocks', 'stale-payload.json'), '{}', 'utf8');
    await writeFile(join(tempRoot, 'unrelated', 'assets', 'private.bin'), binaryAsset);

    const bundle = await buildShareBundle({
      workspaceName: 'Project',
      roots: [{ path: tempRoot, name: 'Project' }],
    });

    expect(bundle.files.map((file) => file.relativePath)).toEqual(
      expect.arrayContaining([
        'Project/Lab notes/.forge/notebook.json',
        'Project/Lab notes/Lab notes.md',
        'Project/Lab notes/assets/model.bin',
      ])
    );
    expect(bundle.files.map((file) => file.relativePath)).not.toContain(
      'Project/unrelated/assets/private.bin'
    );
    expect(bundle.files.map((file) => file.relativePath)).not.toContain(
      'Project/Lab notes/.forge/blocks/stale-payload.json'
    );
    const asset = bundle.files.find(
      (file) => file.relativePath === 'Project/Lab notes/assets/model.bin'
    );
    expect(asset).toMatchObject({ encoding: 'base64', contentType: 'application/octet-stream' });
    expect(Buffer.from(decodeBundleFileContent(asset!))).toEqual(binaryAsset);
    expect(validateShareBundle(bundle)).toMatchObject({ ok: true });
  });

  it.each(['assets', '.forge/blocks', '.forge/migrations'])(
    'rejects a notebook whose managed %s directory is a symlink outside the workspace',
    async (managedDirectory) => {
      tempRoot = await mkdtemp(join(tmpdir(), 'dnaforge-cloud-sync-symlink-notebook-'));
      const outside = await mkdtemp(join(tmpdir(), 'dnaforge-cloud-sync-outside-'));
      const packageRoot = join(tempRoot, 'Lab notes');
      const canonical = serializeNotebookMarkdown({
        identity: { id: 'page-symlink', title: 'Lab notes', formatVersion: 2 },
        content: { type: 'doc', content: [{ type: 'paragraph' }] },
      });
      await mkdir(join(packageRoot, '.forge'), { recursive: true });
      await mkdir(join(packageRoot, managedDirectory, '..'), { recursive: true });
      await writeFile(join(outside, 'private-canary.txt'), 'private canary', 'utf8');
      await symlink(outside, join(packageRoot, managedDirectory), 'dir');
      await writeFile(join(packageRoot, 'Lab notes.md'), canonical.markdown, 'utf8');
      await writeFile(
        join(packageRoot, '.forge', 'notebook.json'),
        serializeNotebookPackageMetadata(
          buildNotebookPackageMetadata({
            id: 'page-symlink',
            title: 'Lab notes',
            markdownFileName: 'Lab notes.md',
            updatedAt: '2026-08-25T00:00:00.000Z',
          })
        ),
        'utf8'
      );

      await expect(
        buildShareBundle({
          workspaceName: 'Project',
          roots: [{ path: tempRoot, name: 'Project' }],
        })
      ).rejects.toThrow(/symbolic link|real directory|not restorable/i);
      await rm(outside, { recursive: true, force: true });
    }
  );

  it('rejects the transitional state where legacy and v2 notebook authorities coexist', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'dnaforge-cloud-sync-dual-notebook-'));
    const packageRoot = join(tempRoot, 'Lab notes');
    const canonical = serializeNotebookMarkdown({
      identity: { id: 'page-dual', title: 'Lab notes', formatVersion: 2 },
      content: { type: 'doc', content: [{ type: 'paragraph' }] },
    });
    await mkdir(join(packageRoot, '.forge', 'migrations'), { recursive: true });
    await writeFile(join(packageRoot, 'Lab notes.md'), canonical.markdown, 'utf8');
    await writeFile(join(packageRoot, '.forge', 'migrations', 'legacy.json'), '{}', 'utf8');
    await writeFile(
      join(packageRoot, '.forge', 'notebook.json'),
      serializeNotebookPackageMetadata(
        buildNotebookPackageMetadata({
          id: 'page-dual',
          title: 'Lab notes',
          markdownFileName: 'Lab notes.md',
          updatedAt: '2026-08-25T00:00:00.000Z',
          migration: {
            fromFormatVersion: 1,
            completedAt: '2026-08-25T00:00:00.000Z',
            archivePath: 'migrations/legacy.json',
            sourceShape: 'legacy-wpnote',
          },
        })
      ),
      'utf8'
    );
    await writeFile(
      join(tempRoot, 'old-copy.wpnote.json'),
      JSON.stringify({
        schema: 'waypoint.notebook.v1',
        kind: 'notebook',
        id: 'page-dual',
        title: 'Old copy',
        content: { type: 'doc', content: [{ type: 'paragraph' }] },
        storage: { type: 'database', table: 'pages', id: 'page-dual' },
        updatedAt: '2026-08-24T00:00:00.000Z',
      }),
      'utf8'
    );

    await expect(
      buildShareBundle({
        workspaceName: 'Project',
        roots: [{ path: tempRoot, name: 'Project' }],
      })
    ).rejects.toThrow(/both legacy and v2 authorities/i);
  });

  it('rejects a portable notebook id shared by a v2 package and a loose legacy file', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'dnaforge-cloud-sync-mixed-duplicate-'));
    await writeCloudNotebookPackage(tempRoot, 'Notebook package', 'shared-mixed-id');
    await mkdir(join(tempRoot, 'archive'), { recursive: true });
    await writeFile(
      join(tempRoot, 'archive', 'old.wpnote.json'),
      `${JSON.stringify({
        schema: 'waypoint.notebook.v1',
        kind: 'notebook',
        id: 'shared-mixed-id',
        title: 'Old loose notebook',
        content: { type: 'doc', content: [{ type: 'paragraph' }] },
        storage: { type: 'database', table: 'pages', id: 'shared-mixed-id' },
        updatedAt: '2026-08-24T00:00:00.000Z',
      })}\n`,
      'utf8'
    );

    await expect(
      buildShareBundle({
        workspaceName: 'Project',
        roots: [{ path: tempRoot, name: 'Project' }],
      })
    ).rejects.toThrow('duplicate notebook id shared-mixed-id');
  });

  it('rejects marked notebook Markdown when the entire .forge directory is missing', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'dnaforge-cloud-sync-orphan-markdown-'));
    const packageRoot = join(tempRoot, 'Orphan notebook');
    const canonical = serializeNotebookMarkdown({
      identity: { id: 'orphan-page', title: 'Orphan notebook', formatVersion: 2 },
      content: { type: 'doc', content: [{ type: 'paragraph' }] },
    });
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(packageRoot, 'Orphan notebook.md'), canonical.markdown, 'utf8');

    await expect(
      buildShareBundle({
        workspaceName: 'Project',
        roots: [{ path: tempRoot, name: 'Project' }],
      })
    ).rejects.toThrow('missing its package metadata');

    const lateMarker = serializeNotebookMarkdown({
      identity: { id: 'orphan-page', title: 'Orphan notebook', formatVersion: 2 },
      preservedPreamble: 'A'.repeat(DEFAULT_SHARE_BUNDLE_LIMITS.maxFileBytes + 128),
      content: { type: 'doc', content: [{ type: 'paragraph' }] },
    });
    await writeFile(join(packageRoot, 'Orphan notebook.md'), lateMarker.markdown, 'utf8');
    await expect(
      buildShareBundle({
        workspaceName: 'Project',
        roots: [{ path: tempRoot, name: 'Project' }],
      })
    ).rejects.toThrow('missing its package metadata');
  });

  it.each(['nested-v2', 'nested-legacy-asset'] as const)(
    'refuses to produce a cloud bundle containing %s notebook authority',
    async (nestedShape) => {
      tempRoot = await mkdtemp(join(tmpdir(), 'dnaforge-cloud-sync-nested-notebook-'));
      await writeCloudNotebookPackage(tempRoot, 'Outer', 'outer-page');
      if (nestedShape === 'nested-v2') {
        await writeCloudNotebookPackage(join(tempRoot, 'Outer'), 'Inner', 'inner-page');
      } else {
        await mkdir(join(tempRoot, 'Outer', 'assets'), { recursive: true });
        await writeFile(
          join(tempRoot, 'Outer', 'assets', 'old.wpnote.json'),
          `${JSON.stringify({
            schema: 'waypoint.notebook.v1',
            kind: 'notebook',
            id: 'inner-page',
            title: 'Inner',
            content: { type: 'doc', content: [] },
            storage: { type: 'database', table: 'pages', id: 'inner-page' },
            updatedAt: '2026-08-25T00:00:00.000Z',
          })}\n`,
          'utf8'
        );
      }

      await expect(
        buildShareBundle({
          workspaceName: 'Project',
          roots: [{ path: tempRoot, name: 'Project' }],
        })
      ).rejects.toThrow(/nested notebook/i);
    }
  );

  it('rejects distinct roots whose serialized names collide case-insensitively', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'dnaforge-cloud-sync-root-collision-a-'));
    const secondRoot = await mkdtemp(join(tmpdir(), 'dnaforge-cloud-sync-root-collision-b-'));
    try {
      await writeCloudNotebookPackage(tempRoot, 'Lab notes', 'page-a');
      await writeCloudNotebookPackage(secondRoot, 'Lab notes', 'page-b');

      await expect(
        buildShareBundle({
          workspaceName: 'Combined',
          roots: [
            { path: tempRoot, name: 'Project' },
            { path: secondRoot, name: 'project' },
          ],
        })
      ).rejects.toThrow('distinct names');
    } finally {
      await rm(secondRoot, { recursive: true, force: true });
    }
  });

  it('refuses to create a cloud bundle from an unrestorable v2 notebook package', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'dnaforge-cloud-sync-invalid-notebook-'));
    const packageRoot = join(tempRoot, 'Lab notes');
    await mkdir(join(packageRoot, '.forge'), { recursive: true });
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

    await expect(
      buildShareBundle({
        workspaceName: 'Project',
        roots: [{ path: tempRoot, name: 'Project' }],
      })
    ).rejects.toThrow(/ENOENT|no such file|missing or unreadable|regular file|not restorable/i);
  });
});

async function writeCloudNotebookPackage(
  workspaceRoot: string,
  title: string,
  id: string
): Promise<void> {
  const packageRoot = join(workspaceRoot, title);
  const canonical = serializeNotebookMarkdown({
    identity: { id, title, formatVersion: 2 },
    content: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: title }] }],
    },
  });
  await mkdir(join(packageRoot, '.forge', 'blocks'), { recursive: true });
  await writeFile(join(packageRoot, `${title}.md`), canonical.markdown, 'utf8');
  for (const payload of canonical.payloads) {
    await writeFile(join(packageRoot, payload.relativePath), payload.content, 'utf8');
  }
  await writeFile(
    join(packageRoot, '.forge', 'notebook.json'),
    serializeNotebookPackageMetadata(
      buildNotebookPackageMetadata({
        id,
        title,
        markdownFileName: `${title}.md`,
        updatedAt: '2026-08-25T00:00:00.000Z',
      })
    ),
    'utf8'
  );
}

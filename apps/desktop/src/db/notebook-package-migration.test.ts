// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { WorkspaceTextFileAtomicWriteInput } from '../shared/workspace-file-atomic';

import { contentFingerprint } from './entity-substrate/adapter';
import { parseNotebookPackageDocument, parseNotebookPackageMetadata } from './notebook-package';
import {
  NOTEBOOK_PACKAGE_MIGRATORS,
  NotebookExternalConflictError,
  NotebookMigrationInterruptedError,
  migrateNotebookPackageAtPath,
  prepareNotebookPackageRename,
  publishNotebookPackageV2,
  readNotebookPackageV2,
  readCanonicalNotebookPackage,
  type NotebookPackageFileOps,
} from './notebook-package-migration';

class MemoryFileOps implements NotebookPackageFileOps {
  readonly files = new Map<string, string>();

  async exists(path: string): Promise<boolean> {
    return (
      this.files.has(path) ||
      [...this.files].some(([candidate]) => candidate.startsWith(`${path}/`))
    );
  }

  async mkdir(): Promise<void> {}

  async readTextFile(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`ENOENT: ${path}`);
    return value;
  }

  async writeTextFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const value = await this.readTextFile(oldPath);
    this.files.set(newPath, value);
    this.files.delete(oldPath);
  }

  async readDir(path: string) {
    const prefix = `${path}/`;
    const names = new Map<string, boolean>();
    for (const candidate of this.files.keys()) {
      if (!candidate.startsWith(prefix)) continue;
      const remainder = candidate.slice(prefix.length);
      const [name, ...rest] = remainder.split('/');
      if (name) names.set(name, rest.length === 0);
    }
    return [...names.entries()].map(([name, isFile]) => ({
      name,
      isFile,
      isDirectory: !isFile,
      isSymbolicLink: false,
    }));
  }

  async removeFile(path: string): Promise<void> {
    if (!this.files.delete(path)) throw new Error(`ENOENT: ${path}`);
  }

  async writeWorkspaceTextFileAtomic(input: WorkspaceTextFileAtomicWriteInput) {
    const current = this.files.get(input.path);
    if (input.mode === 'create') {
      if (current !== undefined) throw new Error('already exists');
    } else {
      const currentHash = createHash('sha256')
        .update(current ?? '', 'utf8')
        .digest('hex');
      if (current === undefined || currentHash !== input.expectedContentHash) {
        throw new Error('changed since it was opened');
      }
    }
    this.files.set(input.path, input.content);
    return {
      path: input.path,
      contentHash: createHash('sha256').update(input.content, 'utf8').digest('hex'),
    };
  }
}

function moveMemoryTree(fs: MemoryFileOps, oldRoot: string, newRoot: string): void {
  for (const [path, content] of [...fs.files.entries()]) {
    if (path !== oldRoot && !path.startsWith(`${oldRoot}/`)) continue;
    fs.files.set(`${newRoot}${path.slice(oldRoot.length)}`, content);
    fs.files.delete(path);
  }
}

const V1 = `${JSON.stringify(
  {
    schema: 'waypoint.notebook.v1',
    kind: 'notebook',
    id: 'raw-id',
    title: 'Legacy',
    content: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'legacy' }] }],
    },
    storage: { type: 'database', table: 'pages', id: 'raw-id' },
    updatedAt: '2026-08-20T12:00:00.000Z',
    unknownMetadata: { keep: true },
  },
  null,
  2
)}\n`;

const INPUT = {
  packageRoot: '/workspace/Legacy',
  workspaceRoot: '/workspace',
  id: 'raw-id',
  title: 'Legacy',
  content: {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'legacy' }] }],
  },
  sourceShape: 'v1-package' as const,
  existingMetadataRaw: V1,
  formerAuthorityRaw: V1,
  updatedAt: '2026-08-20T12:00:00.000Z',
  now: () => new Date('2026-08-25T12:00:00.000Z'),
};

const TABLE_CONTENT = {
  type: 'doc',
  content: [
    {
      type: 'embed',
      attrs: {
        type: 'table',
        refId: 'table-1',
        data: { rows: 1, cols: 1, cells: { A1: { value: 'result' } } },
      },
    },
  ],
};

function notebookContent(text: string) {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

describe('restart-safe notebook package migration', () => {
  it.each([
    '/workspace/Legacy',
    String.raw`C:\workspaces\Legacy`,
    String.raw`C:\workspaces/Legacy`,
    String.raw`\\server\share\Legacy`,
    'C:\\workspaces\\Legacy\\',
  ])(
    'reads canonical notebook authority without changing source bytes at %s',
    async (packageRoot) => {
      const fs = new MemoryFileOps();
      fs.files.set('/workspace/Legacy/.forge/notebook.json', V1);
      await publishNotebookPackageV2(fs, INPUT);
      const before = new Map(fs.files);
      const normalizedRoot = packageRoot.replace(/\\/gu, '/').replace(/\/+$/u, '');
      const readTextFile = async (path: string) => {
        const normalized = path.replace(/\\/gu, '/');
        if (!normalized.startsWith(`${normalizedRoot}/`))
          throw new Error('Unexpected package root');
        return fs.readTextFile(`/workspace/Legacy${normalized.slice(normalizedRoot.length)}`);
      };
      const result = await readCanonicalNotebookPackage(
        { exists: async () => true, readTextFile },
        packageRoot
      );
      expect(result.parsed.content).toEqual(INPUT.content);
      expect(result.metadata.id).toBe(INPUT.id);
      expect(fs.files).toEqual(before);
    }
  );

  it.each(['Other.md', 'sub/Legacy.md', '../Legacy.md', 'legacy.md', 'sub\\Legacy.md'])(
    'still refuses a noncanonical authority filename %s before reading content',
    async (path) => {
      const fs = new MemoryFileOps();
      fs.files.set('/workspace/Legacy/.forge/notebook.json', V1);
      await publishNotebookPackageV2(fs, INPUT);
      const metadata = parseNotebookPackageMetadata(
        await fs.readTextFile('/workspace/Legacy/.forge/notebook.json')
      );
      const invalid = JSON.stringify({ ...metadata, authority: { ...metadata.authority, path } });
      await expect(
        readCanonicalNotebookPackage(
          {
            exists: async () => true,
            readTextFile: async () => {
              throw new Error('Unexpected content read');
            },
          },
          String.raw`C:\workspaces\Legacy`,
          invalid
        )
      ).rejects.toThrow('Notebook canonical path does not match its package stem');
    }
  );

  it('drains a failed payload batch before returning without starting the next batch', async () => {
    const fs = new MemoryFileOps();
    fs.files.set('/workspace/Legacy/.forge/notebook.json', V1);
    await publishNotebookPackageV2(fs, {
      ...INPUT,
      content: {
        type: 'doc',
        content: Array.from({ length: 40 }, (_, index) => ({
          type: 'paragraph',
          content: [{ type: 'text', text: `payload ${index}` }],
        })),
      },
    });
    const before = new Map(fs.files);
    const read = fs.readTextFile.bind(fs);
    let started = 0;
    let active = 0;
    fs.readTextFile = async (path) => {
      if (!path.includes('/.forge/blocks/')) return read(path);
      const index = started++;
      active++;
      try {
        if (index === 0) throw new Error('fixture read failed');
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
        return read(path);
      } finally {
        active--;
      }
    };
    await expect(readNotebookPackageV2(fs, INPUT.packageRoot)).rejects.toThrow(
      'fixture read failed'
    );
    expect(started).toBe(16);
    expect(active).toBe(0);
    expect(fs.files).toEqual(before);
  });

  it('registers an ordered one-step migration into the current format', () => {
    expect(NOTEBOOK_PACKAGE_MIGRATORS).toEqual([
      { from: 1, to: 2, name: 'json-authority-to-markdown-v2' },
    ]);
  });

  it('migrates the checked-in rich v1 package fixture without losing content or preamble', async () => {
    const fs = new MemoryFileOps();
    const metadataRaw = readFileSync(
      `${__dirname}/__fixtures__/notebook-packages/v1-rich-notebook/.forge/notebook.json`,
      'utf8'
    );
    const siblingMarkdown = readFileSync(
      `${__dirname}/__fixtures__/notebook-packages/v1-rich-notebook/v1-rich-notebook.md`,
      'utf8'
    );
    const legacy = parseNotebookPackageDocument(metadataRaw);
    fs.files.set('/workspace/v1-rich-notebook/.forge/notebook.json', metadataRaw);
    fs.files.set('/workspace/v1-rich-notebook/v1-rich-notebook.md', siblingMarkdown);

    await migrateNotebookPackageAtPath(fs, {
      packageRoot: '/workspace/v1-rich-notebook',
      workspaceRoot: '/workspace',
    });
    const migrated = await readNotebookPackageV2(fs, '/workspace/v1-rich-notebook');

    expect(migrated.parsed.content).toEqual(legacy.content);
    expect(migrated.parsed.preservedPreamble).toBe(
      '---\nfixture: rich-v1\nunknown-key: preserve-exactly\n---\n'
    );
    expect(migrated.metadata).toMatchObject({
      id: 'fixture-rich-v1',
      formatVersion: 2,
      fixtureMetadata: { preserve: true },
    });
  });

  it('archives v1, validates and publishes Markdown before v2 metadata', async () => {
    const fs = new MemoryFileOps();
    fs.files.set('/workspace/Legacy/.forge/notebook.json', V1);
    const result = await publishNotebookPackageV2(fs, INPUT);

    const markdown = fs.files.get('/workspace/Legacy/Legacy.md');
    expect(markdown).toContain('legacy');
    const archive = [...fs.files.entries()].find(([path]) =>
      path.startsWith('/workspace/Legacy/.forge/migrations/v1-notebook-')
    );
    expect(archive?.[1]).toBe(V1);
    expect(archive?.[0]).toMatch(/\/v1-notebook-[a-f0-9]{64}\.json$/);
    const metadata = parseNotebookPackageMetadata(
      fs.files.get('/workspace/Legacy/.forge/notebook.json') ?? ''
    );
    expect(metadata).toMatchObject({
      formatVersion: 2,
      id: 'raw-id',
      unknownMetadata: { keep: true },
      authority: { type: 'markdown', path: 'Legacy.md' },
    });
    expect(metadata).not.toHaveProperty('content');
    expect(result.parsed.content).toEqual(INPUT.content);
  });

  it('is byte-idempotent on a second v2 save with stable input and timestamp', async () => {
    const fs = new MemoryFileOps();
    fs.files.set('/workspace/Legacy/.forge/notebook.json', V1);
    await publishNotebookPackageV2(fs, INPUT);
    const first = new Map(fs.files);
    const v2Raw = fs.files.get('/workspace/Legacy/.forge/notebook.json') ?? '';
    const second = await publishNotebookPackageV2(fs, {
      ...INPUT,
      sourceShape: 'v2-package',
      existingMetadataRaw: v2Raw,
      formerAuthorityRaw: null,
    });
    expect(fs.files).toEqual(first);
    expect(second.changed).toBe(false);
  });

  it('leaves old authority intact when interrupted before canonical publish', async () => {
    const fs = new MemoryFileOps();
    fs.files.set('/workspace/Legacy/.forge/notebook.json', V1);
    await expect(
      publishNotebookPackageV2(fs, { ...INPUT, interruptAt: 'after-stage-before-publish' })
    ).rejects.toEqual(
      expect.objectContaining<Partial<NotebookMigrationInterruptedError>>({
        point: 'after-stage-before-publish',
      })
    );
    expect(fs.files.get('/workspace/Legacy/.forge/notebook.json')).toBe(V1);
    expect(fs.files.has('/workspace/Legacy/Legacy.md')).toBe(false);
    expect(
      [...fs.files.entries()].find(([path]) =>
        path.startsWith('/workspace/Legacy/.forge/migrations/v1-notebook-')
      )?.[1]
    ).toBe(V1);
  });

  it('recovers a published Markdown document before using stale v1 input', async () => {
    const fs = new MemoryFileOps();
    fs.files.set('/workspace/Legacy/.forge/notebook.json', V1);
    await expect(
      publishNotebookPackageV2(fs, { ...INPUT, interruptAt: 'after-publish-before-metadata' })
    ).rejects.toBeInstanceOf(NotebookMigrationInterruptedError);
    const canonical = fs.files.get('/workspace/Legacy/Legacy.md');
    expect(canonical).toContain('legacy');

    const recovered = await publishNotebookPackageV2(fs, {
      ...INPUT,
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'STALE DB' }] }],
      },
    });
    expect(recovered.recovered).toBe(true);
    expect(fs.files.get('/workspace/Legacy/Legacy.md')).toBe(canonical);
    expect(JSON.stringify(recovered.parsed.content)).not.toContain('STALE DB');
    expect(
      parseNotebookPackageMetadata(fs.files.get('/workspace/Legacy/.forge/notebook.json') ?? '')
    ).toBeTruthy();
  });

  it('preserves an external Markdown edit after interrupted v1 publication', async () => {
    const fs = new MemoryFileOps();
    const canonicalPath = '/workspace/Legacy/Legacy.md';
    fs.files.set('/workspace/Legacy/.forge/notebook.json', V1);
    await expect(
      publishNotebookPackageV2(fs, { ...INPUT, interruptAt: 'after-publish-before-metadata' })
    ).rejects.toBeInstanceOf(NotebookMigrationInterruptedError);
    const external = (fs.files.get(canonicalPath) ?? '').replace(
      'legacy',
      'external published winner'
    );
    fs.files.set(canonicalPath, external);

    const recovered = await publishNotebookPackageV2(fs, INPUT);

    expect(recovered.recovered).toBe(true);
    expect(fs.files.get(canonicalPath)).toBe(external);
    expect(JSON.stringify(recovered.parsed.content)).toContain('external published winner');
  });

  it('refuses to overwrite a canonical file that changed after the editor read it', async () => {
    const fs = new MemoryFileOps();
    fs.files.set('/workspace/Legacy/.forge/notebook.json', V1);
    await publishNotebookPackageV2(fs, INPUT);
    const original = fs.files.get('/workspace/Legacy/Legacy.md') ?? '';
    fs.files.set('/workspace/Legacy/Legacy.md', original.replace('legacy', 'external'));
    const v2Raw = fs.files.get('/workspace/Legacy/.forge/notebook.json') ?? '';

    await expect(
      publishNotebookPackageV2(fs, {
        ...INPUT,
        sourceShape: 'v2-package',
        existingMetadataRaw: v2Raw,
        formerAuthorityRaw: null,
        expectedCanonicalFingerprint: '0000000000000000',
      })
    ).rejects.toBeInstanceOf(NotebookExternalConflictError);
    expect(fs.files.get('/workspace/Legacy/Legacy.md')).toContain('external');
  });

  it('keeps the originally validated CAS hash when the file changes during publication', async () => {
    const fs = new MemoryFileOps();
    fs.files.set('/workspace/Legacy/.forge/notebook.json', V1);
    const initial = await publishNotebookPackageV2(fs, INPUT);
    const v2Raw = fs.files.get('/workspace/Legacy/.forge/notebook.json') ?? '';
    const canonicalPath = '/workspace/Legacy/Legacy.md';
    const external = (fs.files.get(canonicalPath) ?? '').replace('legacy', 'external race winner');
    const originalWrite = fs.writeTextFile.bind(fs);
    let injectRace = true;
    fs.writeTextFile = async (path, content) => {
      await originalWrite(path, content);
      if (injectRace && content.includes('"state": "staged"')) {
        injectRace = false;
        fs.files.set(canonicalPath, external);
      }
    };

    await expect(
      publishNotebookPackageV2(fs, {
        ...INPUT,
        sourceShape: 'v2-package',
        existingMetadataRaw: v2Raw,
        formerAuthorityRaw: null,
        content: notebookContent('local stale editor'),
        expectedCanonicalFingerprint: initial.canonicalFingerprint,
      })
    ).rejects.toBeInstanceOf(NotebookExternalConflictError);

    expect(fs.files.get(canonicalPath)).toBe(external);
    expect([...fs.files.keys()].some((path) => path.includes('dnaforge-stage'))).toBe(false);
  });

  it('preserves a concurrent v1 authority update and retries from those newest bytes', async () => {
    const fs = new MemoryFileOps();
    const metaPath = '/workspace/Legacy/.forge/notebook.json';
    const updatedV1 = V1.replace('legacy', 'external v1 winner');
    fs.files.set(metaPath, V1);
    const originalWrite = fs.writeTextFile.bind(fs);
    let injectRace = true;
    fs.writeTextFile = async (path, content) => {
      await originalWrite(path, content);
      if (injectRace && content.includes('"state": "staged"')) {
        injectRace = false;
        fs.files.set(metaPath, updatedV1);
      }
    };

    await expect(
      migrateNotebookPackageAtPath(fs, {
        packageRoot: '/workspace/Legacy',
        workspaceRoot: '/workspace',
      })
    ).rejects.toBeInstanceOf(NotebookExternalConflictError);
    expect(fs.files.get(metaPath)).toBe(updatedV1);

    const retried = await migrateNotebookPackageAtPath(fs, {
      packageRoot: '/workspace/Legacy',
      workspaceRoot: '/workspace',
    });
    expect(JSON.stringify(retried?.parsed.content)).toContain('external v1 winner');
    expect(
      [...fs.files.entries()].find(([path]) =>
        path.includes('/.forge/migrations/v1-notebook-')
      )?.[1]
    ).toBe(updatedV1);
  });

  it('removes completed stage files but retains immutable payload revision history', async () => {
    const fs = new MemoryFileOps();
    fs.files.set('/workspace/Legacy/.forge/notebook.json', V1);
    await publishNotebookPackageV2(fs, { ...INPUT, content: TABLE_CONTENT });
    const oldPayloads = [...fs.files.keys()].filter((path) => path.includes('/.forge/blocks/'));
    expect(oldPayloads).toHaveLength(1);
    fs.files.set('/workspace/Legacy/.forge/notebook.md.dnaforge-stage-abandoned-1', 'old bytes');

    await publishNotebookPackageV2(fs, {
      ...INPUT,
      sourceShape: 'v2-package',
      existingMetadataRaw: fs.files.get('/workspace/Legacy/.forge/notebook.json') ?? '',
      formerAuthorityRaw: null,
      content: notebookContent('plain replacement'),
    });

    expect([...fs.files.keys()].some((path) => path.includes('dnaforge-stage'))).toBe(false);
    const currentPayloads = [...fs.files.keys()].filter((path) => path.includes('/.forge/blocks/'));
    expect(currentPayloads).toEqual(expect.arrayContaining(oldPayloads));
  });

  it('keeps payloads referenced by an external revision restored immediately after publish', async () => {
    const fs = new MemoryFileOps();
    fs.files.set('/workspace/Legacy/.forge/notebook.json', V1);
    const initial = await publishNotebookPackageV2(fs, { ...INPUT, content: TABLE_CONTENT });
    const canonicalPath = '/workspace/Legacy/Legacy.md';
    const externalRevision = fs.files.get(canonicalPath) ?? '';
    const externalPayloads = [...fs.files.keys()].filter((path) =>
      path.includes('/.forge/blocks/')
    );
    expect(externalPayloads).toHaveLength(1);
    const originalAtomicWrite = fs.writeWorkspaceTextFileAtomic.bind(fs);
    let restoreExternalRevision = true;
    fs.writeWorkspaceTextFileAtomic = async (input) => {
      const result = await originalAtomicWrite(input);
      if (restoreExternalRevision && input.path === canonicalPath) {
        restoreExternalRevision = false;
        fs.files.set(canonicalPath, externalRevision);
      }
      return result;
    };

    await expect(
      publishNotebookPackageV2(fs, {
        ...INPUT,
        sourceShape: 'v2-package',
        existingMetadataRaw: fs.files.get('/workspace/Legacy/.forge/notebook.json') ?? '',
        formerAuthorityRaw: null,
        content: notebookContent('local replacement'),
        expectedCanonicalFingerprint: initial.canonicalFingerprint,
      })
    ).rejects.toBeInstanceOf(NotebookExternalConflictError);

    expect(fs.files.get(canonicalPath)).toBe(externalRevision);
    expect(externalPayloads.every((path) => fs.files.has(path))).toBe(true);
    await expect(readNotebookPackageV2(fs, '/workspace/Legacy')).resolves.toMatchObject({
      parsed: { content: TABLE_CONTENT },
    });
  });

  it('uses an opaque notebook id only as archive data, never as a path component', async () => {
    for (const id of ['folder/../../benign-canary', 'C:\\..\\benign-canary']) {
      const fs = new MemoryFileOps();
      fs.files.set('/workspace/Legacy/.forge/notebook.json', V1);
      await publishNotebookPackageV2(fs, { ...INPUT, id });

      const archivePaths = [...fs.files.keys()].filter((path) => path.includes('/migrations/'));
      expect(archivePaths).toHaveLength(1);
      expect(
        archivePaths.every((path) => path.startsWith('/workspace/Legacy/.forge/migrations/'))
      ).toBe(true);
      expect(archivePaths.every((path) => !path.includes(id))).toBe(true);
      expect(archivePaths.some((path) => /v1-notebook-[a-f0-9]{64}\.json$/.test(path))).toBe(true);
    }
  });

  it('allows Keep my edits to replace the exact external revision it authorized', async () => {
    const fs = new MemoryFileOps();
    fs.files.set('/workspace/Legacy/.forge/notebook.json', V1);
    await publishNotebookPackageV2(fs, INPUT);
    const original = fs.files.get('/workspace/Legacy/Legacy.md') ?? '';
    const external = original.replace('legacy', 'external accepted revision');
    fs.files.set('/workspace/Legacy/Legacy.md', external);
    const v2Raw = fs.files.get('/workspace/Legacy/.forge/notebook.json') ?? '';
    const local = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'local kept revision' }] }],
    };

    const result = await publishNotebookPackageV2(fs, {
      ...INPUT,
      sourceShape: 'v2-package',
      existingMetadataRaw: v2Raw,
      formerAuthorityRaw: null,
      content: local,
      expectedCanonicalFingerprint: contentFingerprint(external),
      expectedProjectionContent: INPUT.content,
    });

    expect(result.parsed.content).toEqual(local);
    expect(result.canonicalFingerprint).toBe(
      contentFingerprint(fs.files.get('/workspace/Legacy/Legacy.md') ?? '')
    );
  });

  it('serializes concurrent publishers and rejects the stale second compare-and-swap', async () => {
    const fs = new MemoryFileOps();
    fs.files.set('/workspace/Legacy/.forge/notebook.json', V1);
    const initial = await publishNotebookPackageV2(fs, INPUT);
    const v2Raw = fs.files.get('/workspace/Legacy/.forge/notebook.json') ?? '';
    const firstContent = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first publisher' }] }],
    };
    const secondContent = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'second publisher' }] }],
    };

    const [first, second] = await Promise.allSettled([
      publishNotebookPackageV2(fs, {
        ...INPUT,
        sourceShape: 'v2-package',
        existingMetadataRaw: v2Raw,
        formerAuthorityRaw: null,
        content: firstContent,
        expectedCanonicalFingerprint: initial.canonicalFingerprint,
      }),
      publishNotebookPackageV2(fs, {
        ...INPUT,
        sourceShape: 'v2-package',
        existingMetadataRaw: v2Raw,
        formerAuthorityRaw: null,
        content: secondContent,
        expectedCanonicalFingerprint: initial.canonicalFingerprint,
      }),
    ]);

    expect(first.status).toBe('fulfilled');
    expect(second).toMatchObject({
      status: 'rejected',
      reason: expect.any(NotebookExternalConflictError),
    });
    expect((await readNotebookPackageV2(fs, '/workspace/Legacy')).parsed.content).toEqual(
      firstContent
    );
    expect([...fs.files.keys()].some((path) => path.includes('.dnaforge-tmp-'))).toBe(false);
  });

  it.each(['after-root-move', 'after-inner-markdown-move'] as const)(
    'recovers an interrupted package rename %s',
    async (interruption) => {
      const fs = new MemoryFileOps();
      fs.files.set('/workspace/Legacy/.forge/notebook.json', V1);
      await publishNotebookPackageV2(fs, INPUT);
      await prepareNotebookPackageRename(fs, {
        packageRoot: '/workspace/Legacy',
        nextPackageRoot: '/workspace/Renamed',
        title: 'Renamed',
        workspaceRoot: '/workspace',
      });
      const preparedJournal = fs.files.get('/workspace/Legacy/.forge/notebook-rename.json');
      const staleMetadataRaw = fs.files.get('/workspace/Legacy/.forge/notebook.json');
      expect(preparedJournal).toContain('"packageDepthFromWorkspaceRoot": 1');
      expect(preparedJournal).not.toContain('"workspaceRoot"');
      expect(preparedJournal).not.toContain('/workspace');
      moveMemoryTree(fs, '/workspace/Legacy', '/workspace/Renamed');
      if (interruption === 'after-inner-markdown-move') {
        await fs.rename('/workspace/Renamed/Legacy.md', '/workspace/Renamed/Renamed.md');
      }

      const recovered = await readNotebookPackageV2(fs, '/workspace/Renamed', staleMetadataRaw);

      expect(recovered.metadata).toMatchObject({
        id: 'raw-id',
        title: 'Renamed',
        authority: { path: 'Renamed.md' },
      });
      expect(recovered.parsed.content).toEqual(INPUT.content);
      expect(fs.files.has('/workspace/Renamed/Renamed.md')).toBe(true);
      expect(fs.files.has('/workspace/Renamed/Legacy.md')).toBe(false);
      expect(fs.files.get('/workspace/Renamed/.forge/notebook-rename.json')).toContain(
        '"state": "complete"'
      );
    }
  );

  it.each(['after-root-move', 'after-inner-markdown-move'] as const)(
    'recovers a markerless external rewrite after an interrupted rename %s',
    async (interruption) => {
      const fs = new MemoryFileOps();
      fs.files.set('/workspace/Legacy/.forge/notebook.json', V1);
      await publishNotebookPackageV2(fs, INPUT);
      fs.files.set('/workspace/Legacy/Legacy.md', '# Legacy\n\nExternal **revision**.\n');
      await prepareNotebookPackageRename(fs, {
        packageRoot: '/workspace/Legacy',
        nextPackageRoot: '/workspace/Renamed',
        title: 'Renamed',
        workspaceRoot: '/workspace',
      });
      moveMemoryTree(fs, '/workspace/Legacy', '/workspace/Renamed');
      if (interruption === 'after-inner-markdown-move')
        await fs.rename('/workspace/Renamed/Legacy.md', '/workspace/Renamed/Renamed.md');
      const recovered = await readNotebookPackageV2(fs, '/workspace/Renamed');
      expect(recovered.metadata).toMatchObject({
        id: 'raw-id',
        title: 'Renamed',
        authority: { path: 'Renamed.md' },
      });
      expect(JSON.stringify(recovered.parsed.content)).toContain('revision');
      expect(recovered.markdown).toContain('External **revision**.');
    }
  );

  it('fails closed when marked v2 Markdown is malformed instead of restoring stale input', async () => {
    const fs = new MemoryFileOps();
    fs.files.set('/workspace/Legacy/.forge/notebook.json', V1);
    await publishNotebookPackageV2(fs, INPUT);
    const malformed = '<!-- dnaforge:notebook {"codecVersion":999} -->\nexternal bytes\n';
    fs.files.set('/workspace/Legacy/Legacy.md', malformed);

    await expect(publishNotebookPackageV2(fs, INPUT)).rejects.toThrow();
    expect(fs.files.get('/workspace/Legacy/Legacy.md')).toBe(malformed);
  });
});

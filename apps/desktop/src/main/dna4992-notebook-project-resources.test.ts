// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: () => tmpdir(), getVersion: () => 'test' },
  dialog: { showErrorBox: vi.fn() },
}));

import { createTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { createNativeNotebookWorkingCopies } from './native-notebook-working-copies';
import { bindCatalogEntityFileInDb } from './catalog-file-binding';
import { notebookPackagePaths } from '../db/notebook-package';
import { createEmptyManagedWorkspace } from './workspace-git/import';
import { readCanonicalNotebookPackage } from '../db/notebook-package-migration';
import { startNativeDocumentCommandServer } from './native-document-command-server';
import type { RegisteredProjectAuthority } from './registered-project-authority';
import { NotebookDocumentModel } from '../shared/notebook-model/document';
import { canonicalNotebookJson, serializeNotebookMarkdown } from '../db/notebook-markdown-codec';
import { contentFingerprint } from '../shared/content-fingerprint';
import { nativeEntityReferenceHref } from '../shared/native-entity-reference';
import { stripWorkspaceScope } from '../shared/workspace-scoped-identity';
import { renameManagedWorkspace } from './workspace-git/lifecycle';

const projectName = 'Pownall Figure 4N — Evo2 regulatory pilot';
const filePath = 'analyses/evo2-klf17/selection.json';
const viewPath = 'views/Evo2 at klf17 — Nanog peaks vs controls.dnaforge-track-view.json';
const href = (path: string, name = projectName) =>
  `dnaforge-chat://workspace/${encodeURIComponent(name)}/${path.split('/').map(encodeURIComponent).join('/')}`;
const block = (target: string) => ({
  type: 'paragraph',
  content: [
    { type: 'text', text: 'Pilot evidence', marks: [{ type: 'link', attrs: { href: target } }] },
  ],
});

let directory: string,
  root: string,
  profile: string,
  projectId: string,
  viewId: string,
  db: Database.Database;
let native: ReturnType<typeof createNativeNotebookWorkingCopies>;
let registered: RegisteredProjectAuthority | undefined;
vi.mock('./ipc/database', () => ({ getDb: () => db }));

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'dna4992-notebook-resources-')));
  profile = join(directory, 'profile');
  db = createTestDb();
  ensureSchema(db, ':memory:');
  const project = await createEmptyManagedWorkspace(projectName, {
    db,
    managedRootDir: join(directory, 'managed-workspaces'),
  });
  root = project.repoPath;
  projectId = project.workspaceUuid;
  viewId = `${projectId}::track-view-e70e921e8d925c7b4654d05542c9556ea4a84260e53e1543228c9592fad0584b`;
  await mkdir(join(root, 'analyses/evo2-klf17'), { recursive: true });
  await mkdir(join(root, 'views'));
  await writeFile(join(root, filePath), '{"selection":"klf17"}\n');
  await writeFile(join(root, viewPath), '{"schema":"dnaforge.track-view.v1"}\n');
  const workspace = db.prepare('SELECT id FROM workspaces WHERE path=?').get(root) as {
    id: number;
  };
  db.prepare(
    "INSERT INTO catalog_entities(id,type,name,locator,storage_type,status,workspace_id,created_at,updated_at)VALUES(?,'track-view',?,?,'file','active',?,1,1)"
  ).run(
    viewId,
    'Evo2 at klf17 — Nanog peaks vs controls',
    `entity://track-view/${viewId}`,
    workspace.id
  );
  bindCatalogEntityFileInDb(db, {
    entityId: viewId,
    path: join(root, viewPath),
    workspaceRoot: root,
    fileKind: 'track-view',
    status: 'current',
  });
  registered = existsSync(join(__dirname, 'registered-project-authority.ts'))
    ? (
        await import(new URL('./registered-project-authority.ts', import.meta.url).href)
      ).createRegisteredProjectAuthority({
        db: () => db,
        managedRootDir: () => join(directory, 'managed-workspaces'),
      })
    : undefined;
  native = createNativeNotebookWorkingCopies({
    ...(registered ? { registeredProjects: registered } : {}),
    db: () => db,
    workspaceRoots: () => registered?.list().map((project) => project.path) ?? [root],
    writableWorkspaceRoots: () =>
      registered
        ?.list()
        .filter((project) => !project.pinned)
        .map((project) => project.path) ?? [root],
    profileDirectory: () => profile,
    captureWorkspace: (path, mutating) =>
      registered
        ? registered.capture(registered.resolve(path)?.projectId ?? path, mutating)
        : () => {},
    relocateEntityFile: async () => {
      throw new Error('This proof does not rename resources.');
    },
  });
});

afterEach(async () => {
  await native?.close();
  db?.close();
  await rm(directory, { recursive: true, force: true });
});

const create = () =>
  native.create({ title: 'Evo2 pilot report', workspaceRoot: root, requestId: 'dna4992-report' });
const inspect = (documentId: string) =>
  native.execute({ documentId, operation: { kind: 'inspect', limit: 50 } });

describe(' registered project notebook references', () => {
  it.each([
    [filePath, () => ({ kind: 'path', projectId, path: filePath, resourceKind: 'file' })],
    [
      'analyses/evo2-klf17',
      () => ({ kind: 'path', projectId, path: 'analyses/evo2-klf17', resourceKind: 'directory' }),
    ],
    [viewPath, () => ({ kind: 'entity', projectId, entityId: viewId })],
  ] as const)(
    'authors the original workspace URL %s as an exact portable resource',
    async (path, reference) => {
      const state = await create();
      const changed = await native.executePublic({
        pageId: state.documentId,
        expectedRevision: state.revision,
        operation: { kind: 'splice-blocks', index: 0, deleteCount: 1, blocks: [block(href(path))] },
      });
      const content = (await inspect(state.documentId)).blocks![0].block.content!;
      expect(content).toMatchObject([
        {
          type: 'mention',
          attrs: {
            entityType: 'project-resource',
            label: 'Pilot evidence',
            resourceReference: reference(),
          },
        },
      ]);
      expect(content[0].attrs?.referenceUri ?? null).toBeNull();
      await native.executePublic({
        pageId: state.documentId,
        expectedRevision: changed.revision as string,
        operation: { kind: 'save' },
      });
      expect(await readFile(notebookPackagePaths(state.path).markdownPath, 'utf8')).toContain(
        'Pilot evidence'
      );
      const saved = await readCanonicalNotebookPackage(
        {
          readTextFile: (path) => readFile(path, 'utf8'),
          exists: (path) =>
            access(path).then(
              () => true,
              () => false
            ),
        },
        state.path
      );
      expect(saved.parsed.content.content?.[0].content?.[0]).toMatchObject({
        type: 'mention',
        attrs: { entityType: 'project-resource', resourceReference: reference() },
      });
    }
  );

  it('rejects newly authored unresolved internal links without changing revision or saved bytes', async () => {
    const state = await create();
    const before = await readFile(notebookPackagePaths(state.path).markdownPath);
    const outside = join(directory, 'outside.json');
    await writeFile(outside, 'outside bytes');
    await symlink(outside, join(root, 'analyses/evo2-klf17/escape.json'));
    const targets = [
      href('missing.json'),
      href('../outside.json'),
      href('analyses/evo2-klf17/escape.json'),
      href(filePath, 'Unknown project'),
      'dnaforge-chat://reference/00000000-0000-4000-8000-000000000001',
      nativeEntityReferenceHref('missing-native-catalog-entity')!,
    ];
    for (const target of targets) {
      await expect(
        native.executePublic({
          pageId: state.documentId,
          expectedRevision: state.revision,
          operation: { kind: 'splice-blocks', index: 0, deleteCount: 1, blocks: [block(target)] },
        })
      ).rejects.toThrow();
      const after = await inspect(state.documentId);
      expect(after.revision).toBe(state.revision);
      expect(after.blockCount).toBe(state.blockCount);
      expect(await readFile(notebookPackagePaths(state.path).markdownPath)).toEqual(before);
    }
  });

  it('resolves a saved legacy opaque URI without creating a reference row or rewriting the notebook', async () => {
    const state = await create();
    const beforeRows = db.prepare('SELECT * FROM entity_references ORDER BY id').all();
    const beforePage = db.prepare('SELECT * FROM pages WHERE id=?').get(state.documentId);
    const beforeBytes = await readFile(notebookPackagePaths(state.path).markdownPath);
    const resolver = native as typeof native & {
      resolveResourceReference(input: { documentId: string; reference: string }): Promise<unknown>;
    };
    await expect(
      resolver.resolveResourceReference({ documentId: state.documentId, reference: href(filePath) })
    ).resolves.toMatchObject({
      reference: { kind: 'path', projectId, path: filePath, resourceKind: 'file' },
      workspaceRoot: root,
      path: join(root, filePath),
    });
    expect(db.prepare('SELECT * FROM entity_references ORDER BY id').all()).toEqual(beforeRows);
    expect(db.prepare('SELECT * FROM pages WHERE id=?').get(state.documentId)).toEqual(beforePage);
    expect(await readFile(notebookPackagePaths(state.path).markdownPath)).toEqual(beforeBytes);
  });

  it('keeps external URLs as ordinary hyperlinks', async () => {
    const state = await create();
    await native.executePublic({
      pageId: state.documentId,
      expectedRevision: state.revision,
      operation: {
        kind: 'splice-blocks',
        index: 0,
        deleteCount: 1,
        blocks: [block('https://example.org/evidence')],
      },
    });
    expect((await inspect(state.documentId)).blocks![0].block.content).toMatchObject(
      block('https://example.org/evidence').content
    );
  });

  it('canonicalizes a renderer-shaped link insertion in one undoable native edit', async () => {
    const created = await create();
    const before = await native.execute({
      documentId: created.documentId,
      operation: { kind: 'inspect-copy' },
    });
    const model = new NotebookDocumentModel(before.copy.content, before.title);
    const transaction = model.state.tr.replaceWith(
      0,
      model.state.doc.content.size,
      model.state.schema.nodeFromJSON(block(href(filePath)))
    );
    const changed = await native.execute({
      documentId: created.documentId,
      expectedRevision: before.revision,
      operation: {
        kind: 'apply-steps',
        steps: transaction.steps.map((step) => step.toJSON()),
        baseFingerprint: contentFingerprint(canonicalNotebookJson(transaction.before.toJSON())),
      },
    });
    expect(changed.copy.content.content?.[0].content?.[0]).toMatchObject({
      type: 'mention',
      attrs: {
        entityType: 'project-resource',
        resourceReference: { kind: 'path', projectId, path: filePath, resourceKind: 'file' },
      },
    });
    const undone = await native.execute({
      documentId: created.documentId,
      expectedRevision: changed.revision,
      operation: { kind: 'undo' },
    });
    expect(undone.copy.content).toEqual(before.copy.content);
  });

  it('keeps legacy reads and empty edits unchanged, then repairs valid targets on a real edit so project rename remains safe', async () => {
    const state = await create();
    const legacyContent = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'mention',
              attrs: {
                entityType: 'reference',
                referenceUri: href(filePath),
                label: 'Saved pilot evidence',
              },
            },
          ],
        },
        {
          type: 'paragraph',
          content: [
            {
              type: 'mention',
              attrs: {
                entityType: 'reference',
                referenceUri: href('missing-historical.json'),
                label: 'Missing historical evidence',
              },
            },
          ],
        },
      ],
    };
    const serialized = serializeNotebookMarkdown({
      identity: { id: stripWorkspaceScope(state.documentId), title: state.title, formatVersion: 2 },
      content: legacyContent,
    });
    const markdownPath = notebookPackagePaths(state.path).markdownPath;
    await writeFile(markdownPath, serialized.markdown);
    for (const payload of serialized.payloads) {
      const path = join(state.path, payload.relativePath);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, payload.content);
    }
    const legacy = await native.execute({
      documentId: state.documentId,
      expectedRevision: state.revision,
      operation: { kind: 'reload' },
    });
    const beforeBytes = await readFile(markdownPath);
    expect(legacy.copy.content.content?.[0].content?.[0].attrs).toMatchObject({
      entityType: 'reference',
      referenceUri: href(filePath),
    });
    const empty = await native.execute({
      documentId: state.documentId,
      expectedRevision: legacy.revision,
      operation: {
        kind: 'apply-steps',
        steps: [],
        baseFingerprint: contentFingerprint(canonicalNotebookJson(legacy.copy.content)),
      },
    });
    expect(empty.dirty).toBe(false);
    expect(empty.copy.content).toEqual(legacy.copy.content);
    expect(await readFile(markdownPath)).toEqual(beforeBytes);
    const changed = await native.execute({
      documentId: state.documentId,
      expectedRevision: empty.revision,
      operation: {
        kind: 'splice-blocks',
        index: empty.blockCount,
        deleteCount: 0,
        blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'Unrelated edit.' }] }],
      },
    });
    const target = {
      kind: 'path' as const,
      projectId,
      path: filePath,
      resourceKind: 'file' as const,
    };
    expect(changed.copy.content.content?.[0].content?.[0].attrs).toMatchObject({
      entityType: 'project-resource',
      resourceReference: target,
    });
    expect(changed.copy.content.content?.[1].content?.[0].attrs).toMatchObject({
      entityType: 'reference',
      referenceUri: href('missing-historical.json'),
    });
    await native.execute({
      documentId: state.documentId,
      expectedRevision: changed.revision,
      operation: { kind: 'save' },
    });
    expect(
      await renameManagedWorkspace(db, { repoPath: root, name: 'Renamed pilot project' })
    ).toMatchObject({ changed: 1 });
    const resolver = native as typeof native & {
      resolveResourceReference(input: {
        documentId: string;
        reference: typeof target;
      }): Promise<unknown>;
    };
    await expect(
      resolver.resolveResourceReference({ documentId: state.documentId, reference: target })
    ).resolves.toMatchObject({
      reference: target,
      workspaceRoot: root,
      path: join(root, filePath),
    });
  });

  it('enforces an explicit project grant at the native HTTP owner even when both projects are registered', async () => {
    const first = await create();
    const secondProject = await createEmptyManagedWorkspace('Other registered project', {
      db,
      managedRootDir: join(directory, 'managed-workspaces'),
    });
    const second = await native.create({
      title: 'Other private notebook',
      workspaceRoot: secondProject.repoPath,
      requestId: 'other-private-notebook',
    });
    const authority = {
      ownerInstanceId: 'dna4992-native-owner',
      token: 'dna4992-private-fixture-token',
    };
    const server = await startNativeDocumentCommandServer({
      owner: {
        inspect: async () => {
          throw new Error('Unused annotation command');
        },
        apply: async () => {
          throw new Error('Unused annotation command');
        },
        close: async () => {},
      },
      projectAuthority: registered,
      notebookOwner: native,
      getAuthority: () => authority,
    });
    const call = async (
      pageId: string,
      projectScope: { kind: 'app-following' } | { kind: 'project-roots'; roots: string[] }
    ) => {
      const response = await fetch(`${server.url}/internal/native-documents/call`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-DNAForge-Native-Document-Authority': authority.token,
        },
        body: JSON.stringify({
          ownerInstanceId: authority.ownerInstanceId,
          projectScope,
          command: 'notebook.execute',
          request: { pageId, operation: { kind: 'inspect' } },
        }),
      });
      return response.json();
    };
    try {
      expect(await call(first.documentId, { kind: 'project-roots', roots: [root] })).toMatchObject({
        ok: true,
        result: { pageId: first.documentId },
      });
      const refused = await call(second.documentId, { kind: 'project-roots', roots: [root] });
      expect(refused).toMatchObject({
        ok: true,
        result: { ok: false, stateChanged: false, partialEffects: [] },
      });
      expect(refused.result.error).toContain('PROJECT_ACCESS_DENIED');
      for (const field of [
        'pageId',
        'documentId',
        'path',
        'workspaceRoot',
        'title',
        'content',
        'blocks',
        'copy',
      ])
        expect(refused.result).not.toHaveProperty(field);
      expect(JSON.stringify(refused)).not.toContain('Other private notebook');
      expect(JSON.stringify(refused)).not.toContain(secondProject.repoPath);
      expect(await call(second.documentId, { kind: 'app-following' })).toMatchObject({
        ok: true,
        result: { pageId: second.documentId },
      });
      db.prepare('UPDATE workspaces SET archived_at=1 WHERE path=?').run(secondProject.repoPath);
      const archived = await call(second.documentId, { kind: 'app-following' });
      expect(archived).toMatchObject({
        ok: true,
        result: { ok: false, stateChanged: false, partialEffects: [] },
      });
      expect(archived.result.code).toBe('NOTEBOOK_NOT_FOUND');
      for (const field of [
        'pageId',
        'documentId',
        'path',
        'workspaceRoot',
        'title',
        'content',
        'blocks',
        'copy',
      ])
        expect(archived.result).not.toHaveProperty(field);
      expect(JSON.stringify(archived)).not.toContain('Other private notebook');
      expect(JSON.stringify(archived)).not.toContain(secondProject.repoPath);
    } finally {
      await server.close();
    }
  });
});

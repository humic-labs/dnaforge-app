import { withUserMessage } from '@waypoint/user-messages';
import { createKeyedMutex } from './workspace-git/keyed-mutex';
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, open, readdir, readFile, rename } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import type { JSONContent } from '@tiptap/core';
import { notebookPackagePaths } from '../db/notebook-package';
import { readCanonicalNotebookPackage } from '../db/notebook-package-migration';
import { notebookProjectionFingerprint } from '../shared/notebook-projection';
import type {
  NotebookConflictComparison,
  NotebookConflictResolution,
  ResolveNotebookConflictRequest,
} from '../shared/notebook-conflict';
import { NativeDocumentCommandError } from '../shared/native-document-error';
import { contentFingerprint } from '../shared/content-fingerprint';
import { contentHashInMain } from './content-hash';
import { publishNotebookPackageV2InMain } from './notebook-package-authority';
import { settleNotebookPublicationInMain } from './notebook-publication';
import { stripWorkspaceScope, workspaceScopeKey } from '../shared/workspace-scoped-identity';
import type { NativeNotebookScope } from './notebook-document-owner';
import { syncDirectory } from './fs-durability';
import { withKnownWorkspacePathMutation } from './workspace-sync-mutation-lease';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const changed = () =>
  withUserMessage(
    new NativeDocumentCommandError(
      'NOTEBOOK_CONFLICT_CHANGED',
      'The notebook changed after comparison. Compare the current versions again.',
      false
    ),
    'failure.the-compared-content-changed-or-still-conflicts-review-the-current-ver'
  );
const plainText = (node: JSONContent): string =>
  node.text ?? (node.content ?? []).map(plainText).join(node.type === 'paragraph' ? '' : '\n');

export function createNotebookConflictRecovery(options: {
  db(): Database.Database;
  profileDirectory(): string;
}) {
  const locked = createKeyedMutex();
  async function members(scope: NativeNotebookScope) {
    const result: Array<{ path: string; hash: string; size: number }> = [];
    async function walk(directory: string, depth: number) {
      if (depth > 40 || result.length > 10000)
        throw new Error('The notebook recovery snapshot exceeds its file traversal limit.');
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        const stat = await lstat(path);
        if (stat.isSymbolicLink())
          throw new Error('Notebook recovery cannot retain a linked package member.');
        if (stat.isDirectory()) await walk(path, depth + 1);
        else if (stat.isFile()) {
          const hash = await contentHashInMain({
            workspaceRoot: scope.path,
            workspaceRelativePath: relative(scope.path, path),
          });
          const after = await lstat(path);
          if (
            stat.ino !== after.ino ||
            stat.size !== after.size ||
            stat.mtimeMs !== after.mtimeMs ||
            stat.ctimeMs !== after.ctimeMs
          )
            throw changed();
          result.push({ path: relative(scope.path, path), hash, size: stat.size });
        } else throw new Error('Notebook recovery requires ordinary package files.');
      }
    }
    if (!(await lstat(scope.path)).isDirectory())
      throw new Error('Convert the legacy notebook package before comparing its versions.');
    await walk(scope.path, 0);
    scope.assertCurrent();
    return result.sort((a, b) => a.path.localeCompare(b.path));
  }
  async function capture(scope: NativeNotebookScope) {
    scope.assertCurrent();
    const db = options.db();
    const application = db.prepare('SELECT * FROM pages WHERE id=?').get(scope.documentId) as
      | { id: string; title: string; content: string; updated_at: number }
      | undefined;
    if (!application) throw new Error('The application version is unavailable for comparison.');
    const binding = db
      .prepare(
        "SELECT id,path,object_uuid FROM catalog_entity_files WHERE entity_id=? AND status='current'"
      )
      .get(scope.documentId);
    const files = await members(scope);
    const source = await readCanonicalNotebookPackage(
      {
        readTextFile: (path) => readFile(path, 'utf8'),
        exists: async (path) =>
          lstat(path).then(
            () => true,
            (error) => {
              if (error.code === 'ENOENT') return false;
              throw error;
            }
          ),
      },
      scope.path
    );
    if (stripWorkspaceScope(source.parsed.id) !== stripWorkspaceScope(scope.documentId))
      throw new NativeDocumentCommandError(
        'NOTEBOOK_BINDING_CHANGED',
        'The package identity changed before comparison.',
        false
      );
    const validateAssets = (node: JSONContent) => {
      if (node.type === 'embed' && node.attrs?.type === 'image') {
        const src = node.attrs.data?.src;
        if (typeof src === 'string' && src && !/^(?:data:|https?:|#)/i.test(src)) {
          const sourcePath = decodeURIComponent(src.split(/[?#]/, 1)[0]);
          const member = relative(scope.path, resolve(scope.path, sourcePath));
          if (
            isAbsolute(sourcePath) ||
            member.startsWith('..') ||
            !files.some((file) => file.path === member)
          )
            throw new NativeDocumentCommandError(
              'NOTEBOOK_RECOVERY_ASSET_UNAVAILABLE',
              'A notebook image cannot be retained from its package. Restore or attach that image before resolving these versions.',
              false
            );
        }
      }
      for (const child of node.content ?? []) validateAssets(child);
    };
    validateAssets(source.parsed.content);
    validateAssets(JSON.parse(application.content));
    const workspace = db
      .prepare('SELECT id,repo_uuid FROM workspaces WHERE path=?')
      .get(scope.workspaceRoot) as { id: number; repo_uuid: string | null };
    const sourcePath = relative(
      scope.workspaceRoot,
      notebookPackagePaths(scope.path).metaPath
    ).replace(/\\/g, '/');
    const baseline = db
      .prepare(
        "SELECT synchronized_fingerprint FROM entity_projection_sources WHERE adapter_kind='notebook' AND entity_id=? AND workspace_key=? AND relative_path=? AND projection_version=1"
      )
      .get(
        scope.documentId,
        `scope:${workspaceScopeKey(workspace.repo_uuid, workspace.id)}`,
        sourcePath
      ) as { synchronized_fingerprint: string } | undefined;
    const token = digest({
      documentId: scope.documentId,
      workspace,
      root: scope.workspaceRoot,
      path: scope.path,
      binding,
      application,
      files,
      baseline: baseline?.synchronized_fingerprint ?? null,
    });
    const currentPage = db.prepare('SELECT * FROM pages WHERE id=?').get(scope.documentId);
    if (
      JSON.stringify(currentPage) !== JSON.stringify(application) ||
      digest(await members(scope)) !== digest(files)
    )
      throw changed();
    return {
      token,
      application,
      files,
      source,
      baseFingerprint: baseline?.synchronized_fingerprint ?? null,
    };
  }
  async function writeDurable(path: string, value: unknown) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = path + '.tmp';
    const file = await open(temporary, 'w', 0o600);
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  }
  return {
    async inspect(scope: NativeNotebookScope): Promise<NotebookConflictComparison> {
      const captured = await capture(scope);
      const applicationText = plainText(JSON.parse(captured.application.content));
      return {
        documentId: scope.documentId,
        title: captured.source.parsed.title,
        token: captured.token,
        fileText: captured.source.markdown.slice(0, 32768),
        applicationText: applicationText.slice(0, 32768),
        previewsTruncated:
          captured.source.markdown.length > 32768 || applicationText.length > 32768,
        fileFingerprint: notebookProjectionFingerprint(
          captured.source.parsed.title,
          captured.source.parsed.content
        ),
        applicationFingerprint: notebookProjectionFingerprint(
          captured.application.title,
          captured.application.content
        ),
        baseFingerprint: captured.baseFingerprint,
      };
    },
    async resolve(
      scope: NativeNotebookScope,
      input: ResolveNotebookConflictRequest
    ): Promise<NotebookConflictResolution> {
      if (!/^[0-9a-f]{64}$/.test(input.token) || !['file', 'application'].includes(input.choice))
        throw new Error('The notebook conflict decision is invalid.');
      return locked(scope.documentId, () =>
        withKnownWorkspacePathMutation(options.db(), [scope.path], async () => {
          const retainedPath = join(options.profileDirectory(), 'notebook-conflicts', input.token);
          const receiptPath = join(retainedPath, 'resolution.json');
          const prior = await readFile(receiptPath, 'utf8').then(
            (bytes) =>
              JSON.parse(bytes) as {
                state: string;
                documentId: string;
                choice: string;
                selectedCanonicalFingerprint?: string;
                selectedProjectionFingerprint?: string;
              },
            (error) => {
              if (error.code === 'ENOENT') return null;
              throw error;
            }
          );
          if (prior && ['settled', 'resolving'].includes(prior.state)) {
            if (prior.documentId !== scope.documentId || prior.choice !== input.choice)
              throw changed();
            const current = await capture(scope);
            if (contentFingerprint(current.source.markdown) !== prior.selectedCanonicalFingerprint)
              throw changed();
            const pageFingerprint = notebookProjectionFingerprint(
              current.application.title,
              current.application.content
            );
            if (pageFingerprint !== prior.selectedProjectionFingerprint) {
              if (prior.state !== 'resolving') throw changed();
              const retained = JSON.parse(
                await readFile(join(retainedPath, 'application.json'), 'utf8')
              ) as { title: string; content: string };
              if (
                pageFingerprint !== notebookProjectionFingerprint(retained.title, retained.content)
              )
                throw changed();
              await settleNotebookPublicationInMain(options.db(), {
                pageId: scope.documentId,
                workspaceRoot: scope.workspaceRoot,
                sourcePath: notebookPackagePaths(scope.path).metaPath,
                sourceFingerprint: notebookProjectionFingerprint(
                  current.source.parsed.title,
                  current.source.parsed.content
                ),
                expectedProjectionFingerprint: pageFingerprint,
              });
            } else if (current.baseFingerprint !== prior.selectedProjectionFingerprint)
              throw changed();
            if (prior.state === 'resolving')
              await writeDurable(receiptPath, { ...prior, state: 'settled' });
            return {
              resolved: true,
              documentId: scope.documentId,
              choice: input.choice,
              retainedPath,
            };
          }
          const captured = await capture(scope);
          if (captured.token !== input.token) throw changed();
          await mkdir(join(retainedPath, 'package'), { recursive: true, mode: 0o700 });
          await writeDurable(join(retainedPath, 'application.json'), captured.application);
          for (const member of captured.files) {
            const target = join(retainedPath, 'package', member.path);
            await mkdir(dirname(target), { recursive: true, mode: 0o700 });
            await copyFile(join(scope.path, member.path), target, constants.COPYFILE_EXCL).catch(
              async (error) => {
                if (error.code !== 'EEXIST') throw error;
              }
            );
            if (
              (await contentHashInMain({
                workspaceRoot: join(retainedPath, 'package'),
                workspaceRelativePath: member.path,
              })) !== member.hash
            )
              throw new Error('The retained notebook snapshot failed its content verification.');
            const file = await open(target, 'r');
            try {
              await file.sync();
            } finally {
              await file.close();
            }
            await syncDirectory(dirname(target));
          }
          await writeDurable(join(retainedPath, 'manifest.json'), {
            version: 1,
            documentId: scope.documentId,
            token: input.token,
            files: captured.files,
            baseFingerprint: captured.baseFingerprint,
          });
          if ((await capture(scope)).token !== input.token) throw changed();
          await syncDirectory(dirname(retainedPath));
          await writeDurable(receiptPath, {
            version: 1,
            state: 'preserved',
            documentId: scope.documentId,
            choice: input.choice,
            token: input.token,
          });
          let selectedCanonicalFingerprint = contentFingerprint(captured.source.markdown);
          if (input.choice === 'application') {
            const published = await publishNotebookPackageV2InMain(
              {
                packageRoot: scope.path,
                workspaceRoot: scope.workspaceRoot,
                id: captured.source.parsed.id,
                title: captured.application.title,
                content: JSON.parse(captured.application.content),
                sourceShape: 'v2-package',
                existingMetadataRaw: JSON.stringify(captured.source.metadata),
                expectedCanonicalFingerprint: contentFingerprint(captured.source.markdown),
                preservedPreamble: captured.source.parsed.preservedPreamble,
                preservedTitleProjection: captured.source.parsed.preservedTitleProjection,
              },
              scope.assertCurrent, options.db()
            );
            selectedCanonicalFingerprint = published.canonicalFingerprint;
          }
          const selected = await readCanonicalNotebookPackage(
            {
              readTextFile: (path) => readFile(path, 'utf8'),
              exists: async (path) =>
                lstat(path).then(
                  () => true,
                  (error) => {
                    if (error.code === 'ENOENT') return false;
                    throw error;
                  }
                ),
            },
            scope.path
          );
          if (contentFingerprint(selected.markdown) !== selectedCanonicalFingerprint)
            throw changed();
          scope.assertCurrent();
          await writeDurable(receiptPath, {
            version: 1,
            state: 'resolving',
            documentId: scope.documentId,
            choice: input.choice,
            token: input.token,
            selectedCanonicalFingerprint,
            selectedProjectionFingerprint: notebookProjectionFingerprint(
              selected.parsed.title,
              selected.parsed.content
            ),
          });
          await settleNotebookPublicationInMain(options.db(), {
            pageId: scope.documentId,
            workspaceRoot: scope.workspaceRoot,
            sourcePath: notebookPackagePaths(scope.path).metaPath,
            sourceFingerprint: notebookProjectionFingerprint(
              selected.parsed.title,
              selected.parsed.content
            ),
            expectedProjectionFingerprint: notebookProjectionFingerprint(
              captured.application.title,
              captured.application.content
            ),
          });
          await writeDurable(receiptPath, {
            version: 1,
            state: 'settled',
            documentId: scope.documentId,
            choice: input.choice,
            token: input.token,
            selectedCanonicalFingerprint,
            selectedProjectionFingerprint: notebookProjectionFingerprint(
              selected.parsed.title,
              selected.parsed.content
            ),
          });
          return {
            resolved: true,
            documentId: scope.documentId,
            choice: input.choice,
            retainedPath,
          };
        })
      );
    },
  };
}

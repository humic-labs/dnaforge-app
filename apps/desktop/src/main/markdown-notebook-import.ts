import type Database from 'better-sqlite3';
import type { JSONContent } from '@tiptap/core';
import { createHash, randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import { access, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { readFileBoundedFromHandle } from './ipc/bounded-file-read';
import { z } from 'zod';
import lockfile from 'proper-lockfile';
import { contentFingerprint } from '../shared/content-fingerprint';
import { isSafeWorkspaceRelativePath } from '../shared/path-boundary';
import { isDeveloperImportSourcePath } from '../shared/developer-import-sources';
import {
  isAdoptableMarkdownPath,
  type MarkdownNotebookAdoption,
  type MarkdownNotebookAdoptionRequest,
  type MarkdownNotebookAdoptionIssue,
} from '../shared/markdown-notebook';
import { scopedProjectionId, workspaceScopeKey } from '../shared/workspace-scoped-identity';
import { notebookPackagePaths, parseNotebookPackageMetadata } from '../db/notebook-package';
import { parsePlainNotebookMarkdown } from '../db/notebook-markdown-codec';
import { readCanonicalNotebookPackage } from '../db/notebook-package-migration';
import { notebookProjectionFingerprint } from '../shared/notebook-projection';
import { publishNotebookPackageV2InMain } from './notebook-package-authority';
import { settleNotebookPublicationInMain } from './notebook-publication';
import { createNativeCatalogRepository } from './native-catalog-repository';
import { canonicalWorkspacePath } from './primer-artifact-files';
import { developerImportSourceRootsInDb } from './registry-source-eligibility';
import { assertKnownWorkspaceContentWritable } from './workspace-content-write-access';
import {
  withKnownWorkspacePathMutation,
  workspaceMutationRootIdentity,
} from './workspace-sync-mutation-lease';
import { MANAGED_DNA_FILE_EXTENSIONS } from '@waypoint/sequence-utils/sequence-file-types';
import { packagedCoordinateFormat } from '../shared/default-molecular-view';
import { MOLECULAR_DOCUMENT_SUFFIX } from '../shared/molecular-document';
import { isRecoveredComputeResultDirectory } from '../shared/compute-result-path';

const safeRelative = z.string().refine(isSafeWorkspaceRelativePath);
const receiptSchema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  source: safeRelative,
  destination: safeRelative,
  sourceHash: z.string(),
  canonicalFingerprint: z.string().optional(),
  archives: z.array(z.object({ path: safeRelative, hash: z.string() })).max(1000),
});
type Receipt = z.infer<typeof receiptSchema>;
const MAX_BYTES = 8 * 1024 * 1024;
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function isMigrationCandidate(path: string): boolean {
  const name = basename(path).toLowerCase();
  return (
    MANAGED_DNA_FILE_EXTENSIONS.includes(extname(name).slice(1)) ||
    packagedCoordinateFormat(name) !== null ||
    name.endsWith('.wpnote.json') ||
    (name.endsWith(MOLECULAR_DOCUMENT_SUFFIX) &&
      packagedCoordinateFormat(name.slice(0, -MOLECULAR_DOCUMENT_SUFFIX.length)) !== null)
  );
}
const exists = (path: string) =>
  access(path).then(
    () => true,
    (error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  );
interface ImportOptions {
  db(): Database.Database;
  roots(): readonly string[];
  readableRoots?(): readonly string[];
  captureWorkspace(root: string): () => void;
  withCleanPaths<T>(paths: readonly string[], operation: () => Promise<T>): Promise<T>;
  onAdopted?(result: MarkdownNotebookAdoption): void;
  onIssue?(issue: MarkdownNotebookAdoptionIssue): void;
  onMigrationCandidatesChanged?(root: string): boolean | void;
  settleMs?: number;
}

export class MarkdownNotebookImporter {
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly watchers = new Map<string, { close(): void }>();
  private readonly scans = new Map<string, Promise<void>>();
  private readonly failures = new Map<string, string>();
  private readonly archiveObservations = new Map<string, { signature: string; hash: string }>();
  private readonly migrationObservations = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  constructor(private readonly options: ImportOptions) {}

  async adopt(
    input: MarkdownNotebookAdoptionRequest,
    waitForStable = true
  ): Promise<MarkdownNotebookAdoption | null> {
    if (this.closed) throw new Error('Markdown notebook importer is closed.');
    const root = workspaceMutationRootIdentity(input.workspaceRoot);
    const previous = this.tails.get(root) ?? Promise.resolve();
    const pending = previous
      .catch(() => {})
      .then(() => this.adoptWithinRoot(root, input.path, waitForStable));
    this.tails.set(root, pending);
    try {
      return await pending;
    } finally {
      if (this.tails.get(root) === pending) this.tails.delete(root);
    }
  }

  refreshRoots(): void {
    if (this.closed) return;
    const roots = new Set(this.options.roots().map(workspaceMutationRootIdentity));
    for (const [root, watcher] of this.watchers) {
      if (!roots.has(root)) {
        watcher.close();
        this.watchers.delete(root);
        this.migrationObservations.delete(root);
      }
    }
    for (const root of roots) {
      if (!this.watchers.has(root)) {
        try {
          const watcher = watch(root, { recursive: true, persistent: false }, (_kind, name) => {
            if (
              !name ||
              /\.(md|markdown)$/i.test(String(name)) ||
              isMigrationCandidate(String(name))
            )
              this.requestScan(root);
          });
          watcher.on('error', (error) =>
            console.warn('[MarkdownNotebook] Watch failed:', root, error)
          );
          this.watchers.set(root, watcher);
        } catch (error) {
          console.warn('[MarkdownNotebook] Polling without native watch:', root, error);
        }
      }
      this.requestScan(root);
    }
    if (!this.timer && roots.size) {
      this.timer = setInterval(() => {
        for (const root of this.options.roots()) this.requestScan(root);
      }, 2000);
      this.timer.unref();
    }
    if (!roots.size && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private requestScan(root: string): void {
    if (this.closed || this.scans.has(root)) return;
    const pending = this.scan(root)
      .catch((error) => console.warn('[MarkdownNotebook] Discovery deferred:', error))
      .finally(() => this.scans.delete(root));
    this.scans.set(root, pending);
  }

  async scan(root: string): Promise<void> {
    root = workspaceMutationRootIdentity(root);
    const writable = () =>
      this.options.roots().some((path) => workspaceMutationRootIdentity(path) === root);
    if (!writable()) {
      this.migrationObservations.delete(root);
      return;
    }
    if (this.isDeveloperImportSource(root) || (await this.packageAt(root))) return;
    const paths: string[] = [];
    const migrationCandidates: string[] = [];
    let visited = 0;
    const walk = async (directory: string, depth: number): Promise<void> => {
      if (depth > 40 || visited > 10000 || this.closed) return;
      if (directory !== root && (await this.packageAt(directory))) return;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (++visited > 10000) return;
        if (entry.name.startsWith('.') || ['node_modules', '__pycache__'].includes(entry.name))
          continue;
        if (
          depth === 0 &&
          (entry.name === 'compute' || isRecoveredComputeResultDirectory(entry.name))
        )
          continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path, depth + 1);
        else if (entry.isFile() || entry.isSymbolicLink()) {
          if (entry.isFile() && isAdoptableMarkdownPath(relative(root, path))) paths.push(path);
          if (this.options.onMigrationCandidatesChanged && isMigrationCandidate(entry.name)) {
            try {
              const file = await stat(path, { bigint: true });
              if (Date.now() - Number(file.mtimeMs) >= (this.options.settleMs ?? 750))
                migrationCandidates.push(
                  [
                    relative(root, path),
                    file.dev,
                    file.ino,
                    file.size,
                    file.mtimeNs,
                    file.ctimeNs,
                  ].join(':')
                );
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
          }
        }
      }
    };
    await walk(root, 0);
    if (this.options.onMigrationCandidatesChanged && writable()) {
      assertKnownWorkspaceContentWritable(this.options.db(), root);
      const signature = migrationCandidates.sort().join('\n');
      if (signature !== this.migrationObservations.get(root)) {
        if (!signature || this.options.onMigrationCandidatesChanged(root) !== false)
          this.migrationObservations.set(root, signature);
      }
    }
    const receipts = join(root, '.forge', 'markdown-imports');
    if (await exists(receipts)) {
      for (const entry of await readdir(receipts, { withFileTypes: true })) {
        if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
        const receipt = await this.readReceipt(root, join(receipts, entry.name));
        if (!paths.includes(join(root, receipt.source))) paths.push(join(root, receipt.source));
      }
    }
    for (const path of paths) {
      if (this.closed) return;
      try {
        await this.adopt({ workspaceRoot: root, path }, false);
        this.failures.delete(path);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (this.failures.get(path) !== message) {
          this.failures.set(path, message);
          console.warn('[MarkdownNotebook] Preserved source pending adoption:', path, error);
          if (
            !/FILE_DOCUMENT_CLIENT_(?:NOT_READY|CHANGED|SYNC_TIMEOUT)|LEGACY_.*MIGRATION_REQUIRED/.test(
              message
            )
          )
            this.options.onIssue?.({ workspaceRoot: root, path, message });
        }
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    this.migrationObservations.clear();
    await Promise.allSettled([...this.scans.values(), ...this.tails.values()]);
  }

  private isDeveloperImportSource(...paths: string[]): boolean {
    const roots = developerImportSourceRootsInDb(this.options.db());
    return paths.some((path) => isDeveloperImportSourcePath(path, roots));
  }

  private async packageAt(path: string): Promise<string | null> {
    for (const name of [
      'notebook.json',
      'plasmid.json',
      'sequence.json',
      'protocol.json',
      'protocol-run.json',
    ]) {
      if (await exists(join(path, '.forge', name))) return name;
    }
    return null;
  }

  private async physical(root: string, path: string, allowMissing = false): Promise<string> {
    const checked = await canonicalWorkspacePath({
      workspaceRoot: root,
      path,
      allowMissing,
      artifactNoun: 'Markdown notebook',
    });
    if (workspaceMutationRootIdentity(checked.candidate) !== workspaceMutationRootIdentity(path)) {
      throw new Error(
        'Markdown notebook paths must have a physical identity inside their project.'
      );
    }
    return checked.candidate;
  }

  private async readReceipt(root: string, path: string): Promise<Receipt> {
    const bytes = await readFileBoundedFromHandle(await this.physical(root, path), 1024 * 1024);
    return receiptSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  }

  private async saveReceipt(root: string, path: string, receipt: Receipt): Promise<void> {
    await this.physical(root, path, true);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  }

  private async readSource(
    root: string,
    path: string
  ): Promise<{ bytes: Buffer; text: string; hash: string; mtime: number }> {
    await this.physical(root, path);
    const before = await stat(path, { bigint: true });
    const bytes = Buffer.from(await readFileBoundedFromHandle(path, MAX_BYTES));
    const after = await stat(path, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new Error('Markdown source changed while reading; adoption will retry.');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.includes('\0')) throw new Error('Markdown source contains binary data.');
    return { bytes, text, hash: sha(bytes), mtime: Number(after.mtimeMs) };
  }

  private async adoptWithinRoot(
    root: string,
    requested: string,
    waitForStable: boolean
  ): Promise<MarkdownNotebookAdoption | null> {
    if (
      this.isDeveloperImportSource(root, isAbsolute(requested) ? requested : join(root, requested))
    )
      return null;
    const writable = this.options
      .roots()
      .some((path) => workspaceMutationRootIdentity(path) === root);
    if (
      !writable &&
      !this.options.readableRoots?.().some((path) => workspaceMutationRootIdentity(path) === root)
    )
      throw new Error('Markdown project is no longer enrolled.');
    let compromised: Error | undefined;
    const assertEnrollment = writable
      ? this.options.captureWorkspace(root)
      : () => {
          if (
            !this.options
              .readableRoots?.()
              .some((path) => workspaceMutationRootIdentity(path) === root)
          )
            throw new Error('The Markdown project is no longer enrolled for reading.');
        };
    const assertCurrent = () => {
      assertEnrollment();
      if (compromised) throw compromised;
    };
    const project = this.project(root);
    const preferredRoot = project.path;
    let requestedPath = isAbsolute(requested) ? resolve(requested) : resolve(root, requested);
    const preferredMember = relative(preferredRoot, requestedPath);
    if (isSafeWorkspaceRelativePath(preferredMember)) requestedPath = join(root, preferredMember);
    const source = await this.physical(root, requestedPath, true);
    const member = relative(root, source).replace(/\\/g, '/');
    if (!isSafeWorkspaceRelativePath(member) || !isAdoptableMarkdownPath(member)) return null;
    let parent = dirname(source);
    while (parent !== root) {
      const kind = await this.packageAt(parent);
      if (kind) {
        if (kind !== 'notebook.json' || notebookPackagePaths(parent).markdownPath !== source)
          return null;
        const metadata = parseNotebookPackageMetadata(
          await readFile(await this.physical(root, notebookPackagePaths(parent).metaPath), 'utf8')
        );
        const project = this.project(root);
        const pageId = scopedProjectionId(
          workspaceScopeKey(project.repo_uuid, project.id),
          metadata.id
        );
        const page = this.options.db().prepare('SELECT title FROM pages WHERE id=?').get(pageId) as
          | { title: string }
          | undefined;
        if (page || !writable)
          return this.describe(root, source, parent, pageId, page?.title ?? metadata.title);
        return this.options.withCleanPaths([parent], () =>
          withKnownWorkspacePathMutation(this.options.db(), [root], () =>
            this.register(root, source, parent, metadata.id, assertCurrent)
          )
        );
      }
      parent = dirname(parent);
    }
    if (!writable || (await this.packageAt(root))) return null;
    return this.options.withCleanPaths([source], () =>
      withKnownWorkspacePathMutation(this.options.db(), [root], async () => {
        assertCurrent();
        assertKnownWorkspaceContentWritable(this.options.db(), root);
        const retainedArtifact = this.options
          .db()
          .prepare(
            `SELECT 1 FROM catalog_entity_files AS file
             JOIN catalog_entities AS entity ON entity.id = file.entity_id
             WHERE file.workspace_id = ? AND file.relative_path = ? AND file.status = 'current'
               AND entity.status = 'active' AND entity.type = 'file'
               AND json_valid(entity.metadata) AND json_extract(entity.metadata, '$.imported') = 1
               AND json_extract(entity.metadata, '$.projection') = 'fallback'`
          )
          .get(project.id, member);
        if (retainedArtifact) return null;
        const receiptDirectory = join(root, '.forge', 'markdown-imports');
        await this.physical(root, receiptDirectory, true);
        await mkdir(receiptDirectory, { recursive: true });
        const receiptPath = join(receiptDirectory, `${sha(member)}.json`);
        await this.physical(root, `${receiptPath}.lock`, true);
        const release = await lockfile.lock(receiptPath, {
          realpath: false,
          stale: 30000,
          update: 10000,
          retries: { retries: 4, minTimeout: 100, maxTimeout: 500 },
          onCompromised: (error) => {
            compromised = error;
          },
        });
        try {
          let receipt = (await exists(receiptPath))
            ? await this.readReceipt(root, receiptPath)
            : undefined;
          if (receipt && receipt.source !== member)
            throw new Error('Markdown import receipt does not match its source.');
          if (receipt) {
            const project = this.project(root);
            const pageId = scopedProjectionId(
              workspaceScopeKey(project.repo_uuid, project.id),
              receipt.id
            );
            const binding = this.options
              .db()
              .prepare(
                "SELECT path FROM catalog_entity_files WHERE entity_id=? AND status='current'"
              )
              .get(pageId) as { path: string } | undefined;
            if (binding)
              receipt.destination = relative(
                root,
                workspaceMutationRootIdentity(binding.path)
              ).replace(/\\/g, '/');
          }
          let inputPath = source;
          if (!(await exists(source))) {
            if (!receipt) return null;
            const changed = [];
            const available: string[] = [];
            for (const archive of receipt.archives) {
              const path = join(root, receipt.destination, archive.path);
              if (!(await exists(path))) continue;
              available.push(path);
              const information = await stat(await this.physical(root, path), { bigint: true });
              const signature = [
                information.dev,
                information.ino,
                information.size,
                information.mtimeNs,
                information.ctimeNs,
              ].join(':');
              const known = this.archiveObservations.get(path);
              const hash =
                known?.signature === signature
                  ? known.hash
                  : (await this.readSource(root, path)).hash;
              this.archiveObservations.set(path, { signature, hash });
              if (hash !== archive.hash) changed.push({ archive, path });
            }
            if (!changed.length && receipt.canonicalFingerprint) {
              const project = this.project(root);
              const pageId = scopedProjectionId(
                workspaceScopeKey(project.repo_uuid, project.id),
                receipt.id
              );
              const page = this.options
                .db()
                .prepare('SELECT title FROM pages WHERE id=?')
                .get(pageId) as { title: string } | undefined;
              if (page)
                return this.describe(
                  root,
                  source,
                  join(root, receipt.destination),
                  pageId,
                  page.title
                );
              return this.options.withCleanPaths([join(root, receipt.destination)], () =>
                this.register(
                  root,
                  source,
                  join(root, receipt!.destination),
                  receipt!.id,
                  assertCurrent
                )
              );
            }
            if (
              changed.length > 1 ||
              (changed[0] && changed[0].archive.hash !== receipt.sourceHash)
            )
              throw new Error(
                'Competing Markdown writers changed older source revisions; every revision was preserved.'
              );
            inputPath = changed[0]?.path ?? available.at(-1) ?? source;
          }
          let input = await this.readSource(root, inputPath);
          const settleMs = this.options.settleMs ?? 750;
          if (Date.now() - input.mtime < settleMs) {
            if (!waitForStable) return null;
            for (let attempt = 0; attempt < 3 && Date.now() - input.mtime < settleMs; attempt++) {
              await new Promise((done) =>
                setTimeout(
                  done,
                  Math.min(settleMs, Math.max(1, settleMs - (Date.now() - input.mtime)))
                )
              );
              assertCurrent();
              input = await this.readSource(root, inputPath);
            }
            if (Date.now() - input.mtime < settleMs)
              throw new Error(
                'The Markdown file is still being written. Its contents are preserved; open it again when writing finishes.'
              );
          }
          if (!receipt) {
            const stem =
              basename(source, extname(source))
                .normalize('NFC')
                .replace(/[/:\\?%*"<>|]/g, '-')
                .replace(/[. ]+$/, '') || 'Untitled';
            let destination = join(dirname(source), stem);
            for (let suffix = 2; ; suffix++) {
              await this.physical(root, destination, true);
              try {
                await mkdir(destination);
                break;
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
                destination = join(dirname(source), `${stem} (${suffix})`);
              }
            }
            receipt = {
              version: 1,
              id: randomUUID(),
              source: member,
              destination: relative(root, destination).replace(/\\/g, '/'),
              sourceHash: input.hash,
              archives: [],
            };
            await this.saveReceipt(root, receiptPath, receipt);
          }
          const packageRoot = join(root, receipt.destination);
          await this.physical(root, packageRoot);
          return this.options.withCleanPaths([packageRoot], async () => {
            const paths = notebookPackagePaths(packageRoot);
            if (await exists(paths.markdownPath)) {
              const canonical = await readFile(
                await this.physical(root, paths.markdownPath),
                'utf8'
              );
              if (
                receipt!.canonicalFingerprint &&
                contentFingerprint(canonical) !== receipt!.canonicalFingerprint
              ) {
                throw new Error(
                  'The notebook changed since its last Markdown import; both revisions were preserved.'
                );
              }
            }
            const parsed = parsePlainNotebookMarkdown({
              markdown: input.text,
              id: receipt!.id,
              title: basename(source, extname(source)),
            });
            await this.rebaseContent(root, dirname(source), packageRoot, parsed.content);
            await mkdir(paths.migrationsDir, { recursive: true });
            let archived = receipt!.archives.find(
              (entry) => join(packageRoot, entry.path) === inputPath
            );
            if (!archived) {
              archived = {
                path: `.forge/migrations/markdown-${input.hash}-${randomUUID()}.md`,
                hash: input.hash,
              };
              const archivePath = join(packageRoot, archived.path);
              if (await exists(archivePath))
                throw new Error(
                  'The Markdown recovery destination already exists; source was preserved.'
                );
              assertCurrent();
              receipt!.archives.push(archived);
              await this.saveReceipt(root, receiptPath, receipt!);
              assertCurrent();
              await rename(inputPath, archivePath);
              inputPath = archivePath;
            }
            const claimed = await this.readSource(root, inputPath);
            if (claimed.hash !== input.hash)
              throw new Error(
                'The Markdown source changed during conversion; the new bytes remain preserved for retry.'
              );
            const saved = await publishNotebookPackageV2InMain(
              {
                packageRoot,
                workspaceRoot: root,
                id: receipt!.id,
                title: parsed.title,
                content: parsed.content,
                sourceShape: 'new-package',
                preservedPreamble: parsed.preservedPreamble,
                preservedTitleProjection: parsed.preservedTitleProjection,
                existingMetadataRaw: (await exists(paths.metaPath))
                  ? await readFile(paths.metaPath, 'utf8')
                  : undefined,
                expectedCanonicalFingerprint: receipt!.canonicalFingerprint,
              },
              assertCurrent
            );
            archived.hash = claimed.hash;
            receipt!.sourceHash = claimed.hash;
            receipt!.canonicalFingerprint = saved.canonicalFingerprint;
            await this.saveReceipt(root, receiptPath, receipt!);
            const result = await this.register(
              root,
              source,
              packageRoot,
              receipt!.id,
              assertCurrent
            );
            this.options.onAdopted?.(result);
            return result;
          });
        } finally {
          await release();
        }
      })
    );
  }

  private project(root: string): { id: number; repo_uuid: string | null; path: string } {
    const rows = this.options
      .db()
      .prepare(
        'SELECT id,path,repo_uuid FROM workspaces WHERE archived_at IS NULL AND trashed_at IS NULL'
      )
      .all() as Array<{ id: number; path: string; repo_uuid: string | null }>;
    const matches = rows.filter((row) => workspaceMutationRootIdentity(row.path) === root);
    if (matches.length !== 1)
      throw new Error('Markdown source has no unique active owning project.');
    return matches[0];
  }

  private describe(
    root: string,
    source: string,
    packageRoot: string,
    pageId: string,
    title: string
  ): MarkdownNotebookAdoption {
    const project = this.project(root);
    return {
      workspaceRoot: project.path,
      sourcePath: join(project.path, relative(root, source)),
      path: join(project.path, relative(root, packageRoot)),
      pageId,
      title,
    };
  }

  private async register(
    root: string,
    source: string,
    packageRoot: string,
    id: string,
    assertCurrent: () => void
  ): Promise<MarkdownNotebookAdoption> {
    const project = this.project(root);
    const canonical = await readCanonicalNotebookPackage(
      { exists, readTextFile: async (path) => readFile(await this.physical(root, path), 'utf8') },
      packageRoot
    );
    const preferredPackageRoot = join(project.path, relative(root, packageRoot));
    if (canonical.metadata.id !== id) throw new Error('The Markdown package identity changed.');
    const pageId = scopedProjectionId(workspaceScopeKey(project.repo_uuid, project.id), id);
    const repo = createNativeCatalogRepository(this.options.db(), {
      assertCurrent,
      withMutation: async (_root, operation) => operation(undefined),
    });
    await repo.registerContextualCatalogEntity({
      id: pageId,
      type: 'notebook',
      name: canonical.parsed.title,
      locator: `entity://page/${pageId}`,
      storageType: 'database',
      workspaceRoot: project.path,
      metadata: { createdBy: 'markdown-import', backingStore: 'pages' },
    });
    await repo.bindCatalogEntityToFile({
      entityId: pageId,
      path: preferredPackageRoot,
      fileKind: 'waypoint-notebook',
      workspaceRoot: project.path,
      sizeBytes: Buffer.byteLength(canonical.markdown),
      status: 'current',
    });
    const row = this.options
      .db()
      .prepare('SELECT title,content FROM pages WHERE id=?')
      .get(pageId) as { title: string; content: string } | undefined;
    await settleNotebookPublicationInMain(this.options.db(), {
      pageId,
      workspaceRoot: project.path,
      sourcePath: notebookPackagePaths(preferredPackageRoot).metaPath,
      sourceFingerprint: notebookProjectionFingerprint(
        canonical.parsed.title,
        canonical.parsed.content
      ),
      expectedProjectionFingerprint: row
        ? notebookProjectionFingerprint(row.title, row.content)
        : null,
    });
    return this.describe(root, source, packageRoot, pageId, canonical.parsed.title);
  }

  private async rebaseContent(
    root: string,
    sourceDirectory: string,
    packageRoot: string,
    node: JSONContent
  ): Promise<void> {
    const urlPath = (url: string): string => {
      const path = url.split(/[?#]/, 1)[0];
      try {
        return decodeURIComponent(path);
      } catch {
        return path;
      }
    };
    const rebase = (url: string): string => {
      if (!url || /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(url)) return url;
      const match = /^([^?#]*)(.*)$/.exec(url)!;
      const target = resolve(sourceDirectory, urlPath(match[1]));
      return (
        relative(packageRoot, target)
          .replace(/\\/g, '/')
          .split('/')
          .map(encodeURIComponent)
          .join('/') + match[2]
      );
    };
    for (const mark of node.marks ?? []) {
      if (mark.type === 'link' && typeof mark.attrs?.href === 'string')
        mark.attrs.href = rebase(mark.attrs.href);
    }
    if (node.type === 'embed' && node.attrs?.type === 'image') {
      const data = node.attrs.data as {
        src?: string;
        notebookPackagePath?: string;
        fileName?: string;
        mediaType?: string;
      };
      if (data.src && !/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(data.src)) {
        const imagePath = resolve(sourceDirectory, urlPath(data.src));
        const bytes = await this.readSourceBytes(root, imagePath);
        if (bytes) {
          let destination = join(notebookPackagePaths(packageRoot).assetsDir, basename(imagePath));
          await mkdir(dirname(destination), { recursive: true });
          await this.physical(root, destination, true);
          if ((await exists(destination)) && sha(await readFile(destination)) !== sha(bytes)) {
            const extension = extname(imagePath);
            destination = join(
              dirname(destination),
              `${basename(imagePath, extension)}-${sha(bytes).slice(0, 12)}${extension}`
            );
          }
          await this.physical(root, destination, true);
          if (!(await exists(destination))) await writeFile(destination, bytes, { flag: 'wx' });
          else if (sha(await readFile(destination)) !== sha(bytes))
            throw new Error('The notebook image revision conflicts with an existing asset.');
          data.src = `assets/${basename(destination)}`;
          data.notebookPackagePath = relative(root, packageRoot).replace(/\\/g, '/');
          data.fileName = basename(imagePath);
          data.mediaType = (
            {
              '.png': 'image/png',
              '.jpg': 'image/jpeg',
              '.jpeg': 'image/jpeg',
              '.gif': 'image/gif',
              '.webp': 'image/webp',
              '.svg': 'image/svg+xml',
            } as Record<string, string>
          )[extname(imagePath).toLowerCase()];
        } else data.src = rebase(data.src);
      }
    }
    for (const child of node.content ?? [])
      await this.rebaseContent(root, sourceDirectory, packageRoot, child);
  }

  private async readSourceBytes(root: string, path: string): Promise<Buffer | null> {
    if (!(await exists(path))) return null;
    await this.physical(root, path);
    const size = (await stat(path)).size;
    if (size > 50 * 1024 * 1024) throw new Error('Notebook image exceeds 50 MiB.');
    return Buffer.from(await readFileBoundedFromHandle(path, 50 * 1024 * 1024));
  }
}

import type Database from 'better-sqlite3';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, rename } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import type { JSONContent } from '@tiptap/core';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import { canonicalNotebookJson } from '../db/notebook-markdown-codec';
import { parseNotebookPackageDocument, notebookPackagePaths } from '../db/notebook-package';
import {
  readCanonicalNotebookPackage,
  type PublishNotebookPackageResult,
} from '../db/notebook-package-migration';
import { stripWorkspaceScope } from '../shared/workspace-scoped-identity';
import { NotebookDocumentModel } from '../shared/notebook-model/document';
import { canonicalWorkspacePath } from './primer-artifact-files';
import { publishNotebookPackageV2InMain } from './notebook-package-authority';
import { syncDirectory } from './fs-durability';
import { migrationPathsIntersect } from './workspace-git/migration-paths';
import {
  claimRegularFileNoClobber,
  publishFileContentNoClobber,
} from './workspace-git/exclusive-file-claim';

const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const member = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !/[\\\0]/u.test(path) &&
      path.split('/').every((part) => part && part !== '.' && part !== '..')
  );
const identity = z.object({ device: z.string(), inode: z.string() }).strict();
const receiptSchema = z
  .object({
    schema: z.literal('dnaforge.flat-notebook-migration.v1'),
    documentId: z.string().min(1),
    source: member,
    package: member,
    archive: member,
    packageIdentity: identity,
    sourceIdentity: identity.extend({ sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict(),
    originalRaw: z.string(),
    content: z.custom<JSONContent>(
      (value) => !!value && typeof value === 'object' && (value as JSONContent).type === 'doc'
    ),
    title: z.string(),
    updatedAt: z.string(),
  })
  .strict();

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function durable(path: string, bytes: string): Promise<void> {
  await publishFileContentNoClobber(path, bytes);
  await syncDirectory(dirname(path));
}

async function ensureDirectory(path: string): Promise<void> {
  try {
    await mkdir(path);
    await syncDirectory(dirname(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if (!(await lstat(path)).isDirectory())
    throw new Error(`NOTEBOOK_MIGRATION_DIRECTORY_CHANGED: ${path}`);
}

async function readSource(path: string): Promise<{ bytes: Buffer; device: string; inode: string }> {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile()) throw new Error(`NOTEBOOK_MIGRATION_SOURCE_NOT_REGULAR: ${path}`);
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await file.stat({ bigint: true });
    const bytes = await file.readFile();
    const after = await lstat(path, { bigint: true });
    if (
      !after.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    )
      throw new Error(`NOTEBOOK_MIGRATION_SOURCE_CHANGED: ${path}`);
    return { bytes, device: String(after.dev), inode: String(after.ino) };
  } finally {
    await file.close();
  }
}

export async function migrateFlatNotebookInMain(input: {
  db?: Database.Database;
  workspaceRoot: string;
  sourcePath: string;
  documentId: string;
  assertCurrent(): void;
  protectedPaths?: readonly string[];
  desired?: { content: JSONContent; title: string; expectedRaw: string };
}): Promise<{
  packageRoot: string;
  archivePath: string;
  result: PublishNotebookPackageResult;
  retainedPaths: string[];
  expectedContentSha256: Record<string, string | null>;
}> {
  const safe = async (path: string, allowMissing = true) =>
    (
      await canonicalWorkspacePath({
        workspaceRoot: input.workspaceRoot,
        path,
        allowMissing,
        artifactNoun: 'notebook migration',
      })
    ).candidate;
  await safe(input.sourcePath);
  const base = join(input.workspaceRoot, '.dnaforge-notebook-migrations');
  const root = join(
    base,
    sha(`${input.documentId}:${relative(input.workspaceRoot, input.sourcePath)}`)
  );
  input.assertCurrent();
  await safe(base);
  await ensureDirectory(base);
  await safe(root);
  await ensureDirectory(root);
  let compromised: Error | undefined;
  const release = await lockfile.lock(join(root, 'receipt.json'), {
    realpath: false,
    stale: 2000,
    update: 1000,
    retries: { retries: 30, minTimeout: 100, maxTimeout: 100 },
    onCompromised: (error) => {
      compromised = error;
    },
  });
  const assertCurrent = () => {
    input.assertCurrent();
    if (compromised) throw compromised;
  };
  try {
    const receiptPath = join(root, 'receipt.json');
    let receipt: z.infer<typeof receiptSchema>;
    if (await exists(receiptPath)) {
      receipt = receiptSchema.parse(
        JSON.parse((await readSource(await safe(receiptPath, false))).bytes.toString('utf8'))
      );
      if (
        receipt.documentId !== input.documentId ||
        join(input.workspaceRoot, receipt.source) !== input.sourcePath
      )
        throw new Error('NOTEBOOK_MIGRATION_RECEIPT_CHANGED');
      if (
        input.desired &&
        (input.desired.expectedRaw !== receipt.originalRaw ||
          input.desired.title !== receipt.title ||
          canonicalNotebookJson(input.desired.content) !== canonicalNotebookJson(receipt.content))
      )
        throw new Error('NOTEBOOK_MIGRATION_RETRY_CHANGED');
    } else {
      const source = await readSource(await safe(input.sourcePath, false));
      const originalRaw = source.bytes.toString('utf8');
      const legacy = parseNotebookPackageDocument(originalRaw);
      if (
        legacy.id !== stripWorkspaceScope(input.documentId) ||
        (input.desired && input.desired.expectedRaw !== originalRaw)
      )
        throw new Error('NOTEBOOK_MIGRATION_SOURCE_CHANGED');
      const stem =
        basename(input.sourcePath)
          .replace(/\.wpnote\.json$/iu, '')
          .replace(/[/:\\?%*"<>|]/gu, '-') || 'Untitled';
      let packageRoot = '';
      for (let suffix = 1; suffix <= 1000; suffix++) {
        const candidate = join(
          dirname(input.sourcePath),
          suffix === 1 ? stem : `${stem} (${suffix})`
        );
        if (input.protectedPaths?.some((path) => migrationPathsIntersect(candidate, path)))
          continue;
        await safe(candidate);
        assertCurrent();
        try {
          await mkdir(candidate);
          packageRoot = candidate;
          await syncDirectory(dirname(candidate));
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      }
      if (!packageRoot) throw new Error('NOTEBOOK_MIGRATION_NO_FREE_PACKAGE');
      let archivePath = input.sourcePath + '.legacy';
      for (
        let suffix = 2;
        (await exists(archivePath)) ||
        input.protectedPaths?.some((path) => migrationPathsIntersect(archivePath, path));
        suffix++
      ) {
        if (suffix > 1000) throw new Error('NOTEBOOK_MIGRATION_NO_FREE_ARCHIVE');
        archivePath = `${input.sourcePath}.legacy.${suffix}`;
      }
      const packageStat = await lstat(packageRoot);
      receipt = {
        schema: 'dnaforge.flat-notebook-migration.v1',
        documentId: input.documentId,
        source: relative(input.workspaceRoot, input.sourcePath).split(sep).join('/'),
        package: relative(input.workspaceRoot, packageRoot).split(sep).join('/'),
        archive: relative(input.workspaceRoot, archivePath).split(sep).join('/'),
        packageIdentity: { device: String(packageStat.dev), inode: String(packageStat.ino) },
        sourceIdentity: { device: source.device, inode: source.inode, sha256: sha(source.bytes) },
        originalRaw,
        content:
          input.desired?.content ??
          new NotebookDocumentModel(legacy.content as JSONContent, legacy.title).content,
        title: input.desired?.title ?? legacy.title,
        updatedAt: legacy.updatedAt,
      };
      assertCurrent();
      await durable(receiptPath, JSON.stringify(receipt));
    }
    const packageRoot = await safe(join(input.workspaceRoot, receipt.package), false);
    const archivePath = await safe(join(input.workspaceRoot, receipt.archive));
    if (
      input.protectedPaths?.some(
        (path) =>
          migrationPathsIntersect(packageRoot, path) || migrationPathsIntersect(archivePath, path)
      )
    )
      throw new Error('NOTEBOOK_MIGRATION_DESTINATION_OWNED');
    const heldPath = join(root, 'source.wpnote.json');
    const packageStat = await lstat(packageRoot);
    if (
      !packageStat.isDirectory() ||
      String(packageStat.dev) !== receipt.packageIdentity.device ||
      String(packageStat.ino) !== receipt.packageIdentity.inode
    )
      throw new Error('NOTEBOOK_MIGRATION_PACKAGE_CHANGED');
    const assertSource = async (path: string) => {
      const source = await readSource(await safe(path, false));
      if (
        source.device !== receipt.sourceIdentity.device ||
        source.inode !== receipt.sourceIdentity.inode ||
        sha(source.bytes) !== receipt.sourceIdentity.sha256
      )
        throw new Error(`NOTEBOOK_MIGRATION_SOURCE_CHANGED: ${path}`);
    };
    const metadataPath = notebookPackagePaths(packageRoot).metaPath;
    if (await exists(metadataPath)) {
      const current = await readCanonicalNotebookPackage(
        { exists, readTextFile: (path) => readFile(path, 'utf8') },
        packageRoot
      );
      if (
        current.metadata.id !== stripWorkspaceScope(input.documentId) ||
        current.parsed.title !== receipt.title ||
        canonicalNotebookJson(current.parsed.content) !== canonicalNotebookJson(receipt.content)
      )
        throw new Error('NOTEBOOK_MIGRATION_PACKAGE_CHANGED');
    }
    assertCurrent();
    const result = await publishNotebookPackageV2InMain(
      {
        workspaceRoot: input.workspaceRoot,
        packageRoot,
        id: stripWorkspaceScope(input.documentId),
        title: receipt.title,
        content: receipt.content,
        sourceShape: 'legacy-wpnote',
        formerAuthorityRaw: receipt.originalRaw,
        existingMetadataRaw: receipt.originalRaw,
        updatedAt: receipt.updatedAt,
      },
      assertCurrent,
      input.db
    );
    if (await exists(heldPath)) {
      await assertSource(heldPath);
      if (await exists(input.sourcePath)) throw new Error('NOTEBOOK_MIGRATION_SOURCE_REAPPEARED');
      await assertSource(archivePath);
    } else {
      await assertSource(input.sourcePath);
      if (!(await exists(archivePath))) {
        assertCurrent();
        await claimRegularFileNoClobber(input.sourcePath, archivePath, {
          open: async () => {
            throw new Error('NOTEBOOK_MIGRATION_HARD_LINK_REQUIRED');
          },
        });
        await syncDirectory(dirname(archivePath));
      }
      await assertSource(archivePath);
      await assertSource(input.sourcePath);
      assertCurrent();
      await rename(input.sourcePath, heldPath);
      await Promise.all([syncDirectory(dirname(input.sourcePath)), syncDirectory(root)]);
      try {
        await assertSource(heldPath);
      } catch (error) {
        await link(heldPath, input.sourcePath).catch(() => undefined);
        throw error;
      }
    }
    assertCurrent();
    const completePath = join(root, 'complete.json');
    const completeBytes = JSON.stringify({
      schema: 'dnaforge.flat-notebook-migration-complete.v1',
      package: receipt.package,
      sourceSha256: receipt.sourceIdentity.sha256,
    });
    if (!(await exists(completePath))) await durable(completePath, completeBytes);
    if ((await readFile(completePath, 'utf8')) !== completeBytes)
      throw new Error('NOTEBOOK_MIGRATION_COMPLETION_CHANGED');
    await assertSource(heldPath);
    await assertSource(archivePath);
    if (await exists(input.sourcePath)) throw new Error('NOTEBOOK_MIGRATION_SOURCE_REAPPEARED');
    return {
      packageRoot,
      archivePath,
      result,
      retainedPaths: [receiptPath, completePath, heldPath, archivePath],
      expectedContentSha256: {
        [input.sourcePath]: null,
        [heldPath]: receipt.sourceIdentity.sha256,
        [archivePath]: receipt.sourceIdentity.sha256,
        [receiptPath]: sha(JSON.stringify(receipt)),
        [completePath]: sha(completeBytes),
      },
    };
  } finally {
    await release();
  }
}

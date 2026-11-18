import { randomUUID } from 'node:crypto';
import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import type Database from 'better-sqlite3';
import {
  isSafeRelativePath,
  validateDeepShareBundleV1,
  type DeepShareBundleV1,
} from '@waypoint/share-bundle';

import { assertIndependentWorkImport, isWorkImportCandidate } from './work-task-import';
import { createDesktopSyncClient, type DesktopSyncClient } from './desktop-sync-client';
import {
  LEGACY_LIMS_NOT_IMPORTED_WARNING,
  rehydrateWorkspaceSyncState,
  validateWorkspaceSyncStateForStrictRestore,
} from './workspace-sync-restore';
import { commitAllIfDirty, initManagedRepo, resolveHeadCommit } from './workspace-git';
import { convertTreeToPlasmidPackages } from './workspace-git/convert-tree-to-packages';
import {
  isImportShareUrl,
  parseImportShareUrl,
  type ParsedImportShareUrl,
} from './workspace-sync-import-share-url';
import {
  DEEP_SHARE_LINEAGE_NOTICE,
  SHARE_LINEAGE_RELATIVE_PATH,
  type ShareLineageV2,
} from '../shared/share-lineage';
import { observeWorkspaceSync, workspaceSyncErrorCode } from './workspace-sync-observation';
import type { AdministrationShareImportReview } from '../shared/administration';

export type { ParsedImportShareUrl };
export { isImportShareUrl, parseImportShareUrl };

export interface DeepShareImportResponse {
  status: 'ok';
  shareId: string;
  shortId: string;
  createdAt: string | null;
  bundle: DeepShareBundleV1;
}

export interface DeepShareImportClient {
  load(request: { shortId: string; token: string }): Promise<DeepShareImportResponse>;
}

export interface ImportShareIntoManagedWorkspaceInput {
  shortId: string;
  token: string;
  managedRootDir: string;
  db: Database.Database;
  nowMs?: number;
  createWorkspaceUuid?: () => string;
  createLocalId?: () => string;
  client?: DeepShareImportClient;
  prepared?: PreparedDeepShareImport;
  assertAuthority?: () => Promise<void>;
}

export interface PreparedDeepShareImport {
  response: DeepShareImportResponse;
  review: AdministrationShareImportReview;
  managedRootDir: string;
}

function assertIndependentShareFiles(bundle: DeepShareBundleV1) {
  for (const file of bundle.files) {
    if (!isWorkImportCandidate(file.relativePath)) continue;
    const text =
      file.content.encoding === 'utf8'
        ? file.content.text
        : Buffer.from(file.content.data, 'base64').toString('utf8');
    assertIndependentWorkImport(file.relativePath, text);
  }
}

export async function prepareDeepShareImport(
  input: Omit<ImportShareIntoManagedWorkspaceInput, 'prepared'>
): Promise<PreparedDeepShareImport> {
  const response = await (input.client ?? createAuthenticatedDeepShareImportClient()).load({
    shortId: input.shortId,
    token: input.token,
  });
  const parsed = validateDeepShareBundleV1(response.bundle);
  if (!parsed.ok) throw new Error('Deep Share bundle validation failed.');
  if (!response.shareId || response.shortId !== input.shortId)
    throw new Error('Deep Share source identity did not match the requested link.');
  const bundle = structuredClone(parsed.bundle);
  assertIndependentShareFiles(bundle);
  const workspaceUuid = input.createWorkspaceUuid?.() ?? randomUUID();
  const displayName = privateForkName(input.db, bundle.source.artifact.name);
  const repoPath = join(input.managedRootDir, workspaceUuid, 'repo');
  if (await pathExists(dirname(repoPath)))
    throw new Error('The proposed private-fork destination already exists.');
  await input.assertAuthority?.();
  return {
    response: { ...response, bundle: structuredClone(bundle) },
    managedRootDir: resolve(input.managedRootDir),
    review: {
      source: {
        shareId: response.shareId,
        shortId: response.shortId,
        bundleSha256: bundle.contentSha256,
        artifactName: bundle.source.artifact.name,
        fileCount: bundle.files.length,
        conversationCount: bundle.chats.length,
        totalBytes: bundle.files.reduce((sum, file) => sum + file.sizeBytes, 0),
      },
      destination: { kind: 'new-private-project', workspaceUuid, displayName, repoPath },
    },
  };
}

export interface ImportShareIntoManagedWorkspaceResult {
  ok: true;
  workspaceUuid: string;
  displayName: string;
  repoPath: string;
  lineage: ShareLineageV2;
  warnings: string[];
}

export async function importShareIntoManagedWorkspace(
  input: ImportShareIntoManagedWorkspaceInput
): Promise<ImportShareIntoManagedWorkspaceResult> {
  const startedAt = Date.now();
  try {
    const result = await importShareIntoManagedWorkspaceUnobserved(input);
    observeWorkspaceSync({
      sync_operation: 'share_import',
      sync_outcome: 'imported',
      duration_ms: Math.max(0, Date.now() - startedAt),
    });
    return result;
  } catch (error) {
    observeWorkspaceSync({
      sync_operation: 'share_import',
      sync_outcome: 'failed',
      error_code: workspaceSyncErrorCode(error),
      duration_ms: Math.max(0, Date.now() - startedAt),
    });
    throw error;
  }
}

async function importShareIntoManagedWorkspaceUnobserved(
  input: ImportShareIntoManagedWorkspaceInput
): Promise<ImportShareIntoManagedWorkspaceResult> {
  const prepared = input.prepared ?? (await prepareDeepShareImport(input));
  if (
    resolve(input.managedRootDir) !== prepared.managedRootDir ||
    prepared.review.source.shortId !== input.shortId
  )
    throw new Error('The prepared import belongs to a different source or destination.');
  const response = prepared.response;
  const parsed = validateDeepShareBundleV1(response.bundle);
  if (!parsed.ok) {
    throw new Error(`Deep Share bundle is invalid: ${parsed.errors.join('; ')}`);
  }
  const bundle = parsed.bundle;
  assertIndependentShareFiles(bundle);
  if (!response.shareId || !response.shortId) {
    throw new Error('Deep Share import response is incomplete.');
  }
  if (
    bundle.contentSha256 !== prepared.review.source.bundleSha256 ||
    response.shareId !== prepared.review.source.shareId ||
    response.shortId !== prepared.review.source.shortId
  )
    throw new Error('The prepared import source changed after review.');

  const nowMs = input.nowMs ?? Date.now();
  const createLocalId = input.createLocalId ?? randomUUID;
  const workspaceUuid = prepared.review.destination.workspaceUuid;
  const displayName = prepared.review.destination.displayName;
  if (privateForkName(input.db, bundle.source.artifact.name) !== displayName)
    throw new Error('The reviewed destination name changed. Prepare this import again.');
  const finalWorkspaceDir = join(input.managedRootDir, workspaceUuid);
  const finalRepoPath = join(finalWorkspaceDir, 'repo');
  if (resolve(finalRepoPath) !== resolve(prepared.review.destination.repoPath))
    throw new Error('The prepared import destination changed after review.');
  const stagingDir = join(
    input.managedRootDir,
    `.deep-share-import-${workspaceUuid}-${randomUUID()}`
  );
  const stagingRepoPath = join(stagingDir, 'repo');
  const conversationIdMap = Object.fromEntries(
    bundle.chats.map((conversation) => [conversation.id, createLocalId()])
  );
  const lineage: ShareLineageV2 = {
    schemaVersion: 2,
    source: {
      shareId: response.shareId,
      shortId: response.shortId,
      workspaceId: bundle.source.workspaceId,
      artifact: bundle.source.artifact,
      pinnedVersion: {
        id: bundle.source.pinnedVersionId,
        number: bundle.source.pinnedVersionNumber,
        contentSha256: bundle.source.pinnedVersionContentSha256,
      },
      bundle: { schema: bundle.schema, contentSha256: bundle.contentSha256 },
      parent: bundle.parent,
      sharedAt: response.createdAt,
    },
    importedAt: new Date(nowMs).toISOString(),
    localWorkspaceUuid: workspaceUuid,
    conversationIdMap,
    notice: DEEP_SHARE_LINEAGE_NOTICE,
  };

  await input.assertAuthority?.();
  await mkdir(input.managedRootDir, { recursive: true });
  if (await pathExists(finalWorkspaceDir)) {
    throw new Error('The new private-fork workspace path already exists.');
  }

  let promoted = false;
  try {
    await mkdir(stagingRepoPath, { recursive: true });
    await materializeFiles(stagingRepoPath, bundle);
    validateWorkspaceSyncStateForStrictRestore(stagingRepoPath);
    const lineagePath = join(stagingRepoPath, ...SHARE_LINEAGE_RELATIVE_PATH.split('/'));
    await mkdir(dirname(lineagePath), { recursive: true });
    await writeFile(lineagePath, `${JSON.stringify(lineage, null, 2)}\n`, 'utf8');

    await initManagedRepo(stagingRepoPath);
    const conversion = await convertTreeToPlasmidPackages(stagingRepoPath);
    if (conversion.failures.length > 0) {
      throw new Error(
        `Shared project conversion failed: ${conversion.failures
          .map((failure) => `${failure.path}: ${failure.message}`)
          .join('; ')}`
      );
    }
    await commitAllIfDirty(stagingRepoPath, 'Import Deep Share private fork', {
      forceInclude: conversion.requiredGitFiles,
    });
    const head = await resolveHeadCommit(stagingRepoPath);
    if (!head) throw new Error('Could not create the private-fork Git commit.');

    await input.assertAuthority?.();
    await rename(stagingDir, finalWorkspaceDir);
    promoted = true;
    await input.assertAuthority?.();

    let legacyLimsIgnored = false;
    input.db.transaction(() => {
      const workspaceId = Number(
        input.db
          .prepare(
            `INSERT INTO workspaces (name, path, repo_uuid, created_at, last_opened_at)
             VALUES (?, ?, ?, ?, ?)`
          )
          .run(displayName, finalRepoPath, workspaceUuid, nowMs, nowMs).lastInsertRowid
      );
      insertPortableChats(input.db, {
        bundle,
        workspaceUuid,
        workspacePath: finalRepoPath,
        conversationIdMap,
        createLocalId,
        nowMs,
      });
      const rehydrated = rehydrateWorkspaceSyncState(input.db, {
        workspaceId,
        workspaceRoot: finalRepoPath,
        nowMs,
        strict: true,
      });
      legacyLimsIgnored = rehydrated.legacyLimsIgnored;
    })();

    return {
      ok: true,
      workspaceUuid,
      displayName,
      repoPath: finalRepoPath,
      lineage,
      warnings: legacyLimsIgnored ? [LEGACY_LIMS_NOT_IMPORTED_WARNING] : [],
    };
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    if (promoted) {
      await rm(finalWorkspaceDir, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  }
}

export function createAuthenticatedDeepShareImportClient(
  client: DesktopSyncClient = createDesktopSyncClient(),
  expectedAccountId?: string
): DeepShareImportClient {
  return {
    load: async ({ shortId, token }) => {
      try {
        return await client.requestJson<DeepShareImportResponse>(
          `/api/desktop-sync/share-links/${encodeURIComponent(shortId)}/import`,
          { method: 'POST', body: { token }, ...(expectedAccountId ? { expectedAccountId } : {}) }
        );
      } catch {
        throw new Error(
          'The Deep Share link could not be loaded for this account. Check its availability and sign-in.'
        );
      }
    },
  };
}

async function materializeFiles(repoPath: string, bundle: DeepShareBundleV1): Promise<void> {
  const root = resolve(repoPath);
  for (const file of bundle.files) {
    if (
      !isSafeRelativePath(file.relativePath) ||
      file.relativePath === SHARE_LINEAGE_RELATIVE_PATH ||
      file.relativePath === '.git' ||
      file.relativePath.startsWith('.git/')
    ) {
      throw new Error(`Deep Share file path is reserved or unsafe: ${file.relativePath}`);
    }
    const destination = resolve(repoPath, ...file.relativePath.split('/'));
    if (destination !== root && !destination.startsWith(`${root}${sep}`)) {
      throw new Error(`Deep Share file escapes the private-fork root: ${file.relativePath}`);
    }
    const bytes =
      file.content.encoding === 'utf8'
        ? Buffer.from(file.content.text, 'utf8')
        : Buffer.from(file.content.data, 'base64');
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }
}

function insertPortableChats(
  db: Database.Database,
  input: {
    bundle: DeepShareBundleV1;
    workspaceUuid: string;
    workspacePath: string;
    conversationIdMap: Record<string, string>;
    createLocalId(): string;
    nowMs: number;
  }
): void {
  const artifactById = new Map(
    input.bundle.manifest.artifacts.map((artifact) => [artifact.id, artifact])
  );
  const referenceIdByArtifactId = new Map<string, string>();
  for (const artifact of input.bundle.manifest.artifacts) {
    const referenceId = input.createLocalId();
    referenceIdByArtifactId.set(artifact.id, referenceId);
    db.prepare(
      `INSERT INTO entity_references
       (id, entity_type, display_label, locator, deep_link_params, data, source, status,
        workspace_scope, workspace_root_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, 'deep-share-import', 'created', ?, ?, ?, ?)`
    ).run(
      referenceId,
      artifact.type,
      artifact.name,
      `catalog:${input.workspaceUuid}:${artifact.id}`,
      JSON.stringify({ importedArtifactId: artifact.id }),
      input.workspaceUuid,
      input.workspacePath,
      input.nowMs,
      input.nowMs
    );
  }

  for (const conversation of input.bundle.chats) {
    const conversationId = input.conversationIdMap[conversation.id];
    if (!conversationId) throw new Error('Deep Share conversation mapping is incomplete.');
    const createdAt = timestamp(conversation.createdAt, input.nowMs);
    const updatedAt = timestamp(conversation.updatedAt, createdAt);
    db.prepare(
      `INSERT INTO conversations
       (id, title, workspace_path, pinned, provider, model, created_at, updated_at)
       VALUES (?, ?, ?, 0, NULL, NULL, ?, ?)`
    ).run(
      conversationId,
      `Shared context: ${conversation.title}`.slice(0, 240),
      input.workspacePath,
      createdAt,
      updatedAt
    );
    for (const message of conversation.messages) {
      const messageId = input.createLocalId();
      db.prepare(
        `INSERT INTO messages
         (id, conversation_id, turn_id, role, content, tool_name, tool_call_id, created_at)
         VALUES (?, ?, NULL, ?, ?, NULL, NULL, ?)`
      ).run(
        messageId,
        conversationId,
        message.role,
        message.content,
        timestamp(message.createdAt, createdAt)
      );
      message.references.forEach((reference, position) => {
        if (!artifactById.has(reference.artifactId)) {
          throw new Error('Deep Share message references an artifact outside the manifest.');
        }
        const referenceId = referenceIdByArtifactId.get(reference.artifactId);
        if (!referenceId) throw new Error('Imported artifact reference mapping is incomplete.');
        db.prepare(
          `INSERT INTO message_references (message_id, reference_id, position)
           VALUES (?, ?, ?)`
        ).run(messageId, referenceId, position);
      });
    }
  }
}

function privateForkName(db: Database.Database, artifactName: string): string {
  const base = `Private fork of ${artifactName.trim() || 'shared artifact'}`.slice(0, 150);
  const existing = new Set(
    (db.prepare('SELECT name FROM workspaces').all() as Array<{ name?: unknown }>).flatMap((row) =>
      typeof row.name === 'string' ? [row.name] : []
    )
  );
  if (!existing.has(base)) return base;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${base} (${suffix})`.slice(0, 160);
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error('Could not allocate a private-fork project name.');
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function timestamp(value: string, fallback: number): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

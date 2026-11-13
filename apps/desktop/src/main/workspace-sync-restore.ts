import { writeEntityProjectionReceiptInDb } from './entity-projection-receipt-store';
import { notebookProjectionFingerprint } from '../shared/notebook-projection';
import { userMessage } from '@waypoint/user-messages';
import { randomUUID } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import type Database from 'better-sqlite3';
import { assertScientificCloudTransferSupported } from './scientific-cloud-admission';
import { classifyNotebookPackageMemberPath } from '@waypoint/share-bundle';

import {
  notebookPackagePaths,
  parseNotebookPackageDocument,
  parseNotebookPackageMetadata,
  type NotebookPackageDocument,
} from '../db/notebook-package';
import {
  NOTEBOOK_MARKER_PREFIX,
  notebookPayloadPathsFromMarkdown,
  parseNotebookMarkdown,
} from '../db/notebook-markdown-codec';
import { normalizePathForBoundary } from '../shared/path-boundary';
import {
  scopedProjectionId,
  stripWorkspaceScope,
  workspaceScopeKey,
} from '../shared/workspace-scoped-identity';

export interface RehydrateWorkspaceSyncStateResult {
  notebooksRestored: number;
  lims: null;
  legacyLimsIgnored: boolean;
}

export const LEGACY_LIMS_NOT_IMPORTED_WARNING = userMessage('sync.legacyDataKept');

const SYNC_SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.DS_Store',
  'dist',
  'dist-electron',
  'out',
]);

export function rehydrateWorkspaceSyncState(
  db: Database.Database,
  input: {
    workspaceId: number;
    workspaceRoot: string;
    nowMs?: number;
    strict?: boolean;
    scientificHistoryFormat?: 1;
  }
): RehydrateWorkspaceSyncStateResult {
  assertScientificCloudTransferSupported(db, input.workspaceId, input.scientificHistoryFormat);
  const nowMs = input.nowMs ?? Date.now();
  const discovered = discoverWorkspaceArtifacts(input.workspaceRoot, {
    detectOrphanNotebookMarkdown: input.strict === true,
  });
  if (input.strict) assertStrictWorkspaceArtifacts(discovered);
  const notebooksRestored = rehydrateNotebooksFromWorkspace(db, {
    workspaceId: input.workspaceId,
    workspaceRoot: input.workspaceRoot,
    nowMs,
    strict: input.strict === true,
    artifacts: discovered.notebooks,
  });
  return {
    notebooksRestored,
    lims: null,
    legacyLimsIgnored: discovered.legacyLimsIgnored,
  };
}

export function validateWorkspaceSyncStateForStrictRestore(workspaceRoot: string): void {
  const discovered = discoverWorkspaceArtifacts(workspaceRoot, {
    detectOrphanNotebookMarkdown: true,
  });
  assertStrictWorkspaceArtifacts(discovered);
  const notebookPathsById = new Map<string, string>();
  for (const artifact of discovered.notebooks) {
    const document = readNotebookDocument(artifact, true);
    if (!document) {
      throw new Error(`Remote workspace notebook is unreadable: ${artifact.metaPath}`);
    }
    const portableId = stripWorkspaceScope(document.id);
    const existingPath = notebookPathsById.get(portableId);
    if (existingPath && existingPath !== artifact.packageRoot) {
      throw new Error(
        `Remote workspace contains duplicate notebook id: ${portableId} (${existingPath}, ${artifact.packageRoot})`
      );
    }
    notebookPathsById.set(portableId, artifact.packageRoot);
  }
}

function assertStrictWorkspaceArtifacts(discovered: DiscoveredWorkspaceArtifacts): void {
  if (discovered.orphanNotebookMarkdown.length > 0) {
    throw new Error(
      `Remote workspace notebook Markdown is missing package metadata: ${discovered.orphanNotebookMarkdown.join(', ')}`
    );
  }
  if (discovered.nestedNotebookAuthorities.length > 0) {
    throw new Error(
      `Remote workspace contains a notebook authority nested inside another notebook package: ${discovered.nestedNotebookAuthorities.join(', ')}`
    );
  }
}

function rehydrateNotebooksFromWorkspace(
  db: Database.Database,
  input: {
    workspaceId: number;
    workspaceRoot: string;
    nowMs: number;
    strict: boolean;
    artifacts: readonly DiscoveredNotebook[];
  }
): number {
  const scope = resolveWorkspaceScopeSync(db, input.workspaceId);
  const restoredProjectionIds = new Set<string>();
  let restored = 0;
  for (const artifact of input.artifacts) {
    const document = readNotebookDocument(artifact, input.strict);
    if (!document) continue;
    const projectionId = scopedProjectionId(scope, document.id);
    if (input.strict && restoredProjectionIds.has(projectionId)) {
      throw new Error(`Remote workspace contains duplicate notebook id: ${document.id}`);
    }
    restoredProjectionIds.add(projectionId);
    upsertPageRow(db, document, input.nowMs, projectionId);
    upsertNotebookCatalog(db, {
      workspaceId: input.workspaceId,
      workspaceRoot: input.workspaceRoot,
      packageRoot: artifact.packageRoot,
      document,
      projectionId,
      nowMs: input.nowMs,
    });
    writeEntityProjectionReceiptInDb(
      db,
      {
        adapterKind: 'notebook',
        entityId: projectionId,
        workspaceKey: `scope:${scope}`,
        relativePath: relative(input.workspaceRoot, artifact.metaPath).split(sep).join('/'),
        projectionVersion: 1,
      },
      notebookProjectionFingerprint(document.title, document.content)
    );
    restored += 1;
  }
  reconcileRemovedNotebookProjections(db, {
    workspaceId: input.workspaceId,
    restoredProjectionIds,
    nowMs: input.nowMs,
  });
  return restored;
}

function reconcileRemovedNotebookProjections(
  db: Database.Database,
  input: {
    workspaceId: number;
    restoredProjectionIds: ReadonlySet<string>;
    nowMs: number;
  }
): void {
  const current = db
    .prepare(
      `SELECT cef.id AS file_id, cef.entity_id
       FROM catalog_entity_files cef
       JOIN catalog_entities ce ON ce.id = cef.entity_id
       WHERE cef.workspace_id = ?
         AND cef.file_kind = 'waypoint-notebook'
         AND cef.status = 'current'
         AND ce.type = 'notebook'`
    )
    .all(input.workspaceId) as Array<{ file_id: string; entity_id: string }>;

  for (const row of current) {
    if (input.restoredProjectionIds.has(row.entity_id)) continue;
    db.prepare(
      `UPDATE catalog_entity_files
       SET status = 'missing', missing_since = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ?`
    ).run(input.nowMs, input.nowMs, row.file_id, input.workspaceId);
    db.prepare(
      `UPDATE catalog_entities
       SET status = 'missing', updated_at = ?
       WHERE id = ? AND workspace_id = ?`
    ).run(input.nowMs, row.entity_id, input.workspaceId);
    db.prepare(`DELETE FROM pages WHERE id = ?`).run(row.entity_id);
  }
}

function resolveWorkspaceScopeSync(db: Database.Database, workspaceId: number): string | null {
  const row = db.prepare(`SELECT repo_uuid FROM workspaces WHERE id = ?`).get(workspaceId) as
    | { repo_uuid: string | null }
    | undefined;
  return workspaceScopeKey(row?.repo_uuid ?? null, workspaceId);
}

interface DiscoveredNotebook {
  packageRoot: string;
  metaPath: string;
}

interface DiscoveredWorkspaceArtifacts {
  notebooks: DiscoveredNotebook[];
  legacyLimsIgnored: boolean;
  orphanNotebookMarkdown: string[];
  nestedNotebookAuthorities: string[];
}

function discoverWorkspaceArtifacts(
  workspaceRoot: string,
  options: { detectOrphanNotebookMarkdown?: boolean } = {}
): DiscoveredWorkspaceArtifacts {
  const discovered: DiscoveredWorkspaceArtifacts = {
    notebooks: [],
    legacyLimsIgnored: false,
    orphanNotebookMarkdown: [],
    nestedNotebookAuthorities: [],
  };
  const walk = (dir: string, containingPackageRoot: string | null = null) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    const metaPath = join(dir, '.forge', 'notebook.json');
    let metadataIsRegularFile = false;
    try {
      const forgeStats = lstatSync(join(dir, '.forge'));
      if (!forgeStats.isSymbolicLink() && forgeStats.isDirectory()) {
        const metadataStats = lstatSync(metaPath);
        metadataIsRegularFile = !metadataStats.isSymbolicLink() && metadataStats.isFile();
      }
    } catch {}
    const activePackageRoot = metadataIsRegularFile ? dir : containingPackageRoot;
    if (metadataIsRegularFile) {
      discovered.notebooks.push({ packageRoot: dir, metaPath });
      if (containingPackageRoot) discovered.nestedNotebookAuthorities.push(metaPath);
      if (!options.detectOrphanNotebookMarkdown) return;
    }

    for (const name of entries) {
      if (SYNC_SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      const relativeSegments = relative(workspaceRoot, full).split(sep);
      const waypointIndex = relativeSegments.lastIndexOf('.waypoint');
      if (waypointIndex >= 0 && relativeSegments[waypointIndex + 1] === 'lims') {
        discovered.legacyLimsIgnored = true;
        continue;
      }
      let stats;
      try {
        stats = lstatSync(full);
      } catch {
        continue;
      }

      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) {
        if (activePackageRoot && full === join(activePackageRoot, '.forge')) continue;
        walk(full, activePackageRoot);
        continue;
      }
      const relativePath = relative(workspaceRoot, full).split(sep).join('/').toLowerCase();
      const notebookPathClassification = classifyNotebookPackageMemberPath(relativePath);
      if (
        options.detectOrphanNotebookMarkdown &&
        stats.isFile() &&
        notebookPathClassification?.contentType === 'text/markdown' &&
        (!activePackageRoot || full !== notebookPackagePaths(activePackageRoot).markdownPath) &&
        readFileSync(full, 'utf8').includes(NOTEBOOK_MARKER_PREFIX)
      ) {
        discovered.orphanNotebookMarkdown.push(full);
        continue;
      }
      if (stats.isFile() && name.toLowerCase().endsWith('.wpnote.json')) {
        discovered.notebooks.push({ packageRoot: full, metaPath: full });
        if (activePackageRoot) discovered.nestedNotebookAuthorities.push(full);
      }
    }
  };
  walk(workspaceRoot);
  return discovered;
}

function readNotebookDocument(
  artifact: DiscoveredNotebook,
  strict: boolean
): NotebookPackageDocument | null {
  let versioned = false;
  try {
    const raw = readRegularNotebookFile(artifact.metaPath);
    const candidate = JSON.parse(raw) as unknown;
    versioned =
      typeof candidate === 'object' &&
      candidate !== null &&
      !Array.isArray(candidate) &&
      'formatVersion' in candidate;

    if (versioned) {
      const metadata = parseNotebookPackageMetadata(raw);
      const paths = notebookPackagePaths(artifact.packageRoot);
      const declaredMarkdownPath = join(artifact.packageRoot, metadata.authority.path);
      if (declaredMarkdownPath !== paths.markdownPath) {
        throw new Error('Notebook canonical Markdown path does not match its package stem.');
      }
      const markdown = readRegularNotebookFile(paths.markdownPath);
      const payloads = new Map<string, string>();
      for (const relativePath of notebookPayloadPathsFromMarkdown(markdown)) {
        payloads.set(
          relativePath,
          readRegularNotebookFile(join(artifact.packageRoot, relativePath))
        );
      }
      const parsed = parseNotebookMarkdown({
        markdown,
        payloads,
        expected: { id: metadata.id, title: metadata.title, formatVersion: metadata.formatVersion },
      });
      const document: NotebookPackageDocument = {
        ...metadata,
        schema: 'waypoint.notebook.v1',
        kind: 'notebook',
        id: parsed.id,
        title: parsed.title,
        content: parsed.content,
        updatedAt: metadata.updatedAt,
        storage: { type: 'database', table: 'pages', id: parsed.id },
      };
      notebookUpdatedAtMs(document);
      return document;
    }

    const document = parseNotebookPackageDocument(raw);
    notebookUpdatedAtMs(document);
    return document;
  } catch (error) {
    if (strict || versioned) {
      throw new Error(
        `Remote workspace notebook metadata is invalid at ${artifact.metaPath}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    return null;
  }
}

function readRegularNotebookFile(path: string): string {
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Notebook package member must be a regular file: ${path}`);
  }
  return readFileSync(path, 'utf8');
}

function notebookUpdatedAtMs(document: NotebookPackageDocument): number {
  const updatedAtMs = Date.parse(document.updatedAt);
  if (!Number.isFinite(updatedAtMs)) {
    throw new Error(`Notebook package has invalid updatedAt: ${document.updatedAt}`);
  }
  return updatedAtMs;
}

function upsertPageRow(
  db: Database.Database,
  document: NotebookPackageDocument,
  nowMs: number,
  projectionId: string
): void {
  const contentJson = JSON.stringify(document.content ?? { type: 'doc', content: [] });
  const updatedAtMs = notebookUpdatedAtMs(document);
  const existing = db.prepare(`SELECT id FROM pages WHERE id = ?`).get(projectionId) as
    | { id: string }
    | undefined;
  if (existing) {
    db.prepare(`UPDATE pages SET title = ?, content = ?, updated_at = ? WHERE id = ?`).run(
      document.title,
      contentJson,
      updatedAtMs,
      projectionId
    );
    return;
  }
  db.prepare(
    `INSERT INTO pages (id, title, content, date, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?)`
  ).run(projectionId, document.title, contentJson, nowMs, updatedAtMs);
}

export function upsertNotebookCatalog(
  db: Database.Database,
  input: {
    workspaceId: number;
    workspaceRoot: string;
    packageRoot: string;
    document: NotebookPackageDocument;
    projectionId: string;
    nowMs: number;
  }
): void {
  const locator = `entity://page/${input.projectionId}`;
  const entity = db
    .prepare(`SELECT id FROM catalog_entities WHERE id = ?`)
    .get(input.projectionId) as { id: string } | undefined;
  if (entity) {
    db.prepare(
      `UPDATE catalog_entities
       SET name = ?, locator = ?, workspace_id = ?, status = 'active', updated_at = ?
       WHERE id = ?`
    ).run(input.document.title, locator, input.workspaceId, input.nowMs, input.projectionId);
  } else {
    db.prepare(
      `INSERT INTO catalog_entities
       (id, type, name, locator, storage_type, status, workspace_id, metadata, created_at, updated_at)
       VALUES (?, 'notebook', ?, ?, 'database', 'active', ?, NULL, ?, ?)`
    ).run(
      input.projectionId,
      input.document.title,
      locator,
      input.workspaceId,
      input.nowMs,
      input.nowMs
    );
  }

  const bindPath = input.packageRoot;
  const relativePath = toPosixRelative(input.workspaceRoot, bindPath);
  const bindLocation = normalizePathForBoundary(bindPath);
  const bindings = db
    .prepare(
      `SELECT id, path FROM catalog_entity_files
       WHERE entity_id = ? AND workspace_id = ?
       ORDER BY CASE WHEN status = 'current' THEN 0 ELSE 1 END, created_at ASC`
    )
    .all(input.projectionId, input.workspaceId) as Array<{ id: string; path: string }>;
  const atLocation = bindings.find(
    (binding) => normalizePathForBoundary(binding.path) === bindLocation
  );
  const current = atLocation ?? bindings[0];

  if (current) {
    db.prepare(
      `UPDATE catalog_entity_files
       SET status = 'historical', updated_at = ?
       WHERE entity_id = ? AND status = 'current' AND id <> ?`
    ).run(input.nowMs, input.projectionId, current.id);
    db.prepare(
      `UPDATE catalog_entity_files
       SET path = ?, relative_path = ?, file_kind = 'waypoint-notebook',
           workspace_id = ?, status = 'current', last_seen_at = ?, missing_since = NULL,
           updated_at = ?
       WHERE id = ?`
    ).run(
      atLocation?.path ?? bindPath,
      relativePath,
      input.workspaceId,
      input.nowMs,
      input.nowMs,
      current.id
    );
    return;
  }

  db.prepare(
    `INSERT INTO catalog_entity_files
     (id, entity_id, workspace_id, path, relative_path, file_kind, content_hash, size_bytes,
      modified_at, status, last_seen_at, missing_since, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'waypoint-notebook', NULL, 0, ?, 'current', ?, NULL, ?, ?)`
  ).run(
    randomUUID(),
    input.projectionId,
    input.workspaceId,
    bindPath,
    relativePath,
    input.nowMs,
    input.nowMs,
    input.nowMs,
    input.nowMs
  );
}

function toPosixRelative(workspaceRoot: string, absPath: string): string {
  const rel = relative(workspaceRoot, absPath);
  return rel.split(sep).join('/');
}

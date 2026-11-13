import { platform } from '../../platform';
import {
  isNotebookPackageMetaPath,
  parseNotebookPackageDocument,
  serializeNotebookPackageDocument,
  NOTEBOOK_PACKAGE_SCHEMA,
  type NotebookPackageDocument,
} from '../notebook-package';
import { readNotebookPackageV2 } from '../notebook-package-migration';
import { readNotebookSourceSnapshot } from './notebook-source-snapshot';
import {
  registerEntityAdapter,
  type EntityProjectionState,
  type WorkspaceEntityAdapter,
} from './adapter';
import { announceProjectionUpdated } from './adapter-events';
import { scopedProjectionId } from '../../shared/workspace-scoped-identity';
import { resolveWorkspaceId, resolveWorkspaceScope } from '../workspace-catalog';
import { isDeveloperImportSourcePath } from '../../shared/developer-import-sources';
import { notebookPackagePaths } from '../notebook-package';
import { notebookDocumentFromCanonicalSource as sourceDocument } from '../notebook-projection-source';
import { notebookProjectionFingerprint } from '../../shared/notebook-projection';

export const notebookEntityAdapter: WorkspaceEntityAdapter<NotebookPackageDocument> = {
  kind: 'notebook',
  schema: NOTEBOOK_PACKAGE_SCHEMA,

  matchesPath(path) {
    return isNotebookPackageMetaPath(path) || path.toLowerCase().endsWith('.wpnote.json');
  },

  async parse(bytes, path) {
    if (isNotebookPackageMetaPath(path)) {
      const suffix = '/.forge/notebook.json';
      const packageRoot = path.slice(0, -suffix.length);
      try {
        const { metadata, parsed } = await readNotebookPackageV2(platform().fs, packageRoot, bytes);
        return sourceDocument({ metadata, parsed });
      } catch (error) {
        const candidate = JSON.parse(bytes) as { formatVersion?: unknown };
        if (candidate.formatVersion !== undefined) throw error;
      }
    }
    return parseNotebookPackageDocument(bytes);
  },
  async parseSource(bytes, path, fileMtimeMs) {
    const candidate: unknown = JSON.parse(bytes);
    if (
      isNotebookPackageMetaPath(path) &&
      candidate &&
      typeof candidate === 'object' &&
      'formatVersion' in candidate
    ) {
      const snapshot = await readNotebookSourceSnapshot(path, bytes);
      return { document: sourceDocument(snapshot), fileMtimeMs: snapshot.fileMtimeMs };
    }
    return { document: await notebookEntityAdapter.parse(bytes, path), fileMtimeMs };
  },
  serialize(doc) {
    return serializeNotebookPackageDocument(doc);
  },

  identity(doc, ctx) {
    return scopedProjectionId(ctx.workspaceScope, doc.id);
  },

  projectionFingerprint(doc) {
    return notebookProjectionFingerprint(doc.title, doc.content);
  },

  async getProjection(id): Promise<EntityProjectionState | null> {
    const db = platform().db;
    const rows = await db.select<{ title: string; content: string; updated_at: number }[]>(
      'SELECT title, content, updated_at FROM pages WHERE id = ?',
      [id]
    );
    if (rows.length === 0) return null;
    return {
      fingerprint: notebookProjectionFingerprint(rows[0].title, rows[0].content),
      updatedAtMs: Number(rows[0].updated_at) || 0,
    };
  },

  async writeProjection(doc, id, _fileMtimeMs, path, ctx, expectedProjection) {
    await platform().db.replaceNotebookProjection(
      {
        pageId: id,
        workspaceRoot: ctx.workspaceRoot,
        sourcePath: path,
        sourceFingerprint: notebookProjectionFingerprint(doc.title, doc.content),
        expectedProjectionFingerprint: expectedProjection?.fingerprint ?? null,
      },
      ctx.mutationToken
    );
    announceProjectionUpdated('notebook', id);
  },
};

export async function settlePublishedNotebookProjection(input: {
  pageId: string;
  title: string;
  content: unknown;
  workspaceRoot: string | null;
  artifact: { path: string; fileKind: string; authorityFingerprint?: string } | null | undefined;
  expectedProjectionFingerprint?: string | null;
  mutationToken?: string;
}): Promise<boolean> {
  if (
    !input.artifact ||
    input.artifact.fileKind !== 'waypoint-notebook' ||
    !input.artifact.authorityFingerprint ||
    isDeveloperImportSourcePath(input.artifact.path)
  )
    return false;
  const [workspaceId, workspaceScope] = await Promise.all([
    resolveWorkspaceId(input.workspaceRoot),
    resolveWorkspaceScope(input.workspaceRoot),
  ]);
  const ctx = { workspaceRoot: input.workspaceRoot, workspaceId, workspaceScope };
  const path = input.artifact.path.toLowerCase().endsWith('.wpnote.json')
    ? input.artifact.path
    : notebookPackagePaths(input.artifact.path).metaPath;
  const fingerprint = notebookProjectionFingerprint(input.title, input.content);
  const expectedProjectionFingerprint =
    input.expectedProjectionFingerprint === undefined
      ? ((await notebookEntityAdapter.getProjection(input.pageId, ctx, path))?.fingerprint ?? null)
      : input.expectedProjectionFingerprint;
  await platform().db.replaceNotebookProjection(
    {
      pageId: input.pageId,
      workspaceRoot: input.workspaceRoot,
      sourcePath: path,
      sourceFingerprint: fingerprint,
      expectedProjectionFingerprint,
    },
    input.mutationToken
  );
  return true;
}

let registered = false;
export function registerNotebookEntityAdapter(): void {
  if (registered) return;
  registered = true;
  registerEntityAdapter(notebookEntityAdapter);
}

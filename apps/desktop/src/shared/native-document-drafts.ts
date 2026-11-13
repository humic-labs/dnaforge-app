import type { FileDocumentTarget } from './file-document';
import type { NativeDocumentKind } from './document-lifecycle';
import { sha256Hex } from './sha256';
import { resolveExplicitProjectRoot } from './project-root-selection';
export interface NativeDirtyDocument {
  documentId: string;
  target: FileDocumentTarget;
  path: string;
  workspaceRoot: string;
  kind: NativeDocumentKind;
  revision?: string;
  readOnly: boolean;
  dirty: boolean;
  saving: boolean;
  recovery: boolean;
  inspectionRequired: boolean;
}

export interface NativeDirtyDocumentPage {
  documents: NativeDirtyDocument[];
  nextCursor: string | null;
}
export async function pageNativeDirtyDocuments(
  input: { project?: string; operation: { kind: 'list-dirty'; limit?: number; cursor?: string } },
  context: {
    projects: readonly { name: string; path: string; pinned?: boolean }[];
    documents: readonly NativeDirtyDocument[];
  }
): Promise<NativeDirtyDocumentPage> {
  const limit = input.operation.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Error('INVALID_DIRTY_DOCUMENT_PAGE: Use a page size of 1 to 100.');
  const project = input.project
    ? resolveExplicitProjectRoot(context.projects, input.project)
    : null;
  if (input.project && !project)
    throw new Error('DIRTY_DOCUMENT_PROJECT_UNAVAILABLE: Choose an exact admitted project.');
  const paths = new Set(
    context.projects.map((entry) => entry.path.replace(/\\/g, '/').replace(/\/+$/, ''))
  );
  const candidates = context.documents
    .filter(
      (entry) =>
        paths.has(entry.workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '')) &&
        (!project ||
          entry.workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '') ===
            project.path.replace(/\\/g, '/').replace(/\/+$/, ''))
    )
    .map((entry) => structuredClone(entry))
    .sort((a, b) => (a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : 0));
  const unique = new Map<string, NativeDirtyDocument>();
  for (const document of candidates) {
    const existing = unique.get(document.documentId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(document))
      throw new Error(
        'DIRTY_DOCUMENT_OWNERSHIP_AMBIGUOUS: Inspect the conflicting native document owners.'
      );
    unique.set(document.documentId, document);
  }
  const documents = [...unique.values()];
  const scope = await sha256Hex(
    JSON.stringify({
      project: project?.path,
      projects: context.projects
        .map((entry) => ({ name: entry.name, path: entry.path }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      documents,
    })
  );
  let after: string | undefined;
  if (input.operation.cursor) {
    let cursor: unknown;
    try {
      cursor = JSON.parse(decodeURIComponent(input.operation.cursor));
    } catch {
      throw new Error('INVALID_DIRTY_DOCUMENT_CURSOR: Use the returned cursor unchanged.');
    }
    if (
      !cursor ||
      typeof cursor !== 'object' ||
      !('v' in cursor) ||
      cursor.v !== 1 ||
      !('scope' in cursor) ||
      typeof cursor.scope !== 'string' ||
      !('after' in cursor) ||
      typeof cursor.after !== 'string'
    )
      throw new Error('INVALID_DIRTY_DOCUMENT_CURSOR: Use the returned cursor unchanged.');
    if (cursor.scope !== scope)
      throw new Error(
        'DIRTY_DOCUMENT_SCOPE_CHANGED: Restart inspection after the native dirty inventory changes.'
      );
    after = cursor.after;
  }
  const rest = after ? documents.filter((entry) => entry.documentId > after!) : documents;
  const page = rest.slice(0, limit);
  return {
    documents: page,
    nextCursor:
      rest.length > limit
        ? encodeURIComponent(
            JSON.stringify({ v: 1, scope, after: page[page.length - 1]!.documentId })
          )
        : null,
  };
}

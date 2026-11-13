import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, relative, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import {
  defineBlob,
  listWorkspaceResources,
  inspectResourceRevision,
  inspectResourceState,
  parseWorkspaceVersionId,
} from '@waypoint/workspace-revisions';
import { createScientificReader, defineScientificDocument } from '@waypoint/scientific-objects';
import {
  parseScientificDocumentIdentity,
  parseWorkspaceIdentity,
  scientificDocumentFailure,
  scientificDocumentFormat,
  validateScientificDocumentSnapshot,
  type ScientificDocumentReadResult,
} from '@waypoint/domain-services';
import { type DesktopScientificDocumentReadRequest } from '../shared/scientific-document-ipc';
import { HARD_CAP_BYTES } from '../shared/oversized-guard';
import { workspaceScopeKey } from '../shared/workspace-scoped-identity';
import { canonicalWorkspacePath } from './primer-artifact-files';
import { ScientificObjectStore } from './scientific-object-store';
import { scientificNativeCodecs } from './scientific-native-codecs';
import { scientificWorkspaceIdForRoot } from './scientific-workspace-identity';
import { findCurrentSequenceEditHead } from './sequence-edit-lineage';
import { findKnownWorkspaceRoot } from './workspace-sync-mutation-lease';
type ReadFile = (path: string, options: { readonly signal?: AbortSignal }) => Promise<Uint8Array>;
type Canonicalize = typeof canonicalWorkspacePath;
const readDocumentBytes: ReadFile = (path, options) => readFile(path, options);
interface WorkspaceIdentityDatabase {
  prepare(sql: string): {
    get(value: string): { id: number; repo_uuid: string | null } | undefined;
  };
}
export function resolveMainWorkspaceIdentity(
  workspaceRoot: string,
  database: WorkspaceIdentityDatabase
): string | null {
  const row = database
    .prepare(
      'SELECT id, repo_uuid FROM workspaces WHERE path = ? AND archived_at IS NULL AND trashed_at IS NULL LIMIT 1'
    )
    .get(workspaceRoot);
  return row ? workspaceScopeKey(row.repo_uuid, row.id) : null;
}
export async function readScientificDocumentInMain(
  request: DesktopScientificDocumentReadRequest,
  options: {
    signal?: AbortSignal;
    read?: ReadFile;
    canonicalize?: Canonicalize;
    database?: Database.Database;
  } = {}
): Promise<ScientificDocumentReadResult> {
  let workspace;
  let document;
  try {
    workspace = parseWorkspaceIdentity(request.workspace);
    document = parseScientificDocumentIdentity(request.document);
  } catch (error) {
    const code =
      error instanceof Error && 'code' in error && error.code === 'INVALID_WORKSPACE_IDENTITY'
        ? 'INVALID_WORKSPACE_IDENTITY'
        : 'INVALID_DOCUMENT_IDENTITY';
    return scientificDocumentFailure(
      code,
      error instanceof Error ? error.message : 'Invalid identity.'
    );
  }

  try {
    const candidate = resolve(request.workspaceRoot, document);
    const canonical = await (options.canonicalize ?? canonicalWorkspacePath)({
      workspaceRoot: request.workspaceRoot,
      path: candidate,
      artifactNoun: 'scientific document',
      ...(options.database ? { allowMissing: true } : {}),
    });
    if (options.signal?.aborted)
      return scientificDocumentFailure('CANCELLED', 'Scientific document read was cancelled.');
    const workspaceId =
      options.database && scientificWorkspaceIdForRoot(options.database, canonical.root);
    if (options.database && workspaceId === null)
      return scientificDocumentFailure(
        'ACCESS_DENIED',
        'The active scientific workspace is unavailable.'
      );
    if (options.database && workspaceId) {
      const row = options.database
        .prepare('SELECT repo_uuid FROM workspaces WHERE id = ?')
        .get(workspaceId) as { repo_uuid: string | null };
      if (
        workspaceScopeKey(row.repo_uuid, workspaceId) !== workspace ||
        findKnownWorkspaceRoot(options.database, canonical.candidate) !== canonical.root
      )
        return scientificDocumentFailure(
          'ACCESS_DENIED',
          'Scientific document does not match its active owning workspace.'
        );
      const store = new ScientificObjectStore(options.database, workspaceId);
      const { graph, head: currentHead, reader: currentReader } = store.read();
      const captured = request.acceptedHead ? parseWorkspaceVersionId(request.acceptedHead) : null;
      if (captured && !captured.ok) throw new Error('The captured accepted version is invalid.');
      const head = captured?.ok ? captured.value : currentHead;
      const reader =
        head === currentHead
          ? currentReader
          : createScientificReader({
              graph,
              head,
              readBlob: (blob) => store.readBlob(blob),
              codecs: scientificNativeCodecs,
            });
      const paths = head === null ? null : listWorkspaceResources(graph, head);
      if (paths && !paths.ok) throw new Error('Accepted scientific paths are unavailable.');
      const path = relative(canonical.root, canonical.candidate).replace(/\\/gu, '/');
      const slot = paths?.ok
        ? paths.value.find((slot) => !slot.tombstone && slot.path === path)
        : undefined;
      const snapshot = slot && reader.current(slot.resourceId);
      const auxiliary = (() => {
        if (!slot || snapshot) return null;
        const revision = inspectResourceRevision(graph, slot.revisionId);
        if (!revision.ok || !revision.value.stateHash)
          throw new Error('Accepted native revision is unavailable.');
        const state = inspectResourceState(graph, revision.value.stateHash);
        if (!state.ok || state.value.layout !== 'file')
          throw new Error('Accepted native file is unavailable.');
        const bytes = store.readBlob(state.value.blob);
        if (!bytes) throw new Error('Accepted native bytes are unavailable.');
        return {
          resourceId: slot.resourceId,
          revisionId: slot.revisionId,
          content: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        };
      })();
      const binding = options.database
        .prepare(
          "SELECT entity_id FROM catalog_entity_files WHERE path IN (?, ?) AND status = 'current' LIMIT 1"
        )
        .get(candidate, canonical.candidate) as { entity_id: string } | undefined;
      const admittedBinding =
        binding && paths?.ok
          ? paths.value.find((slot) => slot.resourceId === binding.entity_id)
          : undefined;
      if (
        (admittedBinding && (admittedBinding.tombstone || admittedBinding.path !== path)) ||
        (!snapshot &&
          paths?.ok &&
          paths.value.some((slot) => slot.tombstone && slot.lastPath === path))
      )
        return scientificDocumentFailure(
          'DOCUMENT_NOT_FOUND',
          'The accepted document was moved or deleted; open its current identity or restore it explicitly.'
        );
      if (snapshot && binding && snapshot.resourceId !== binding.entity_id)
        return scientificDocumentFailure(
          'ACCESS_DENIED',
          'Accepted document identity does not match its catalog binding.'
        );
      if ((snapshot || auxiliary) && head) {
        const content =
          auxiliary?.content ??
          snapshot!.representation?.text ??
          defineScientificDocument(snapshot!.document).text;
        const blob = defineBlob(new TextEncoder().encode(content));
        if (blob.byteLength > HARD_CAP_BYTES)
          return scientificDocumentFailure(
            'UNSUPPORTED_FORMAT',
            'Accepted scientific document exceeds the read limit.'
          );
        const parent =
          snapshot?.document.kind === 'sequence'
            ? findCurrentSequenceEditHead(options.database, snapshot.resourceId, blob.hash)
            : null;
        return {
          ok: true,
          document: validateScientificDocumentSnapshot({
            workspace,
            document,
            name:
              snapshot && 'name' in snapshot.document
                ? snapshot.document.name
                : basename(canonical.candidate),
            format: scientificDocumentFormat(document),
            content,
            byteLength: blob.byteLength,
            revision: {
              kind: 'accepted-object',
              contentSha256: blob.hash.slice('sha256:'.length),
              resourceId: auxiliary?.resourceId ?? snapshot!.resourceId,
              resourceRevisionId: auxiliary?.revisionId ?? snapshot!.revisionId,
              workspaceVersionId: head,
              sequenceEditParentEventId: parent?.id ?? null,
            },
            support: { route: 'desktop', access: 'read-write' },
          }),
        };
      }
    }
    const bytes = await (options.read ?? readDocumentBytes)(canonical.candidate, {
      signal: options.signal,
    });
    if (bytes.byteLength > HARD_CAP_BYTES) {
      return scientificDocumentFailure(
        'UNSUPPORTED_FORMAT',
        `Scientific document exceeds the ${HARD_CAP_BYTES}-byte read limit.`
      );
    }
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return scientificDocumentFailure(
        'INVALID_ENCODING',
        'Scientific document must contain valid UTF-8 text.'
      );
    }
    return {
      ok: true,
      document: validateScientificDocumentSnapshot({
        workspace,
        document,
        name: basename(canonical.candidate),
        format: scientificDocumentFormat(document),
        content,
        byteLength: bytes.byteLength,
        revision: {
          kind: 'local-file',
          contentSha256: createHash('sha256').update(bytes).digest('hex'),
        },
        support: { route: 'desktop', access: 'read-write' },
      }),
    };
  } catch (error) {
    if (options.signal?.aborted || (error as NodeJS.ErrnoException).name === 'AbortError') {
      return scientificDocumentFailure('CANCELLED', 'Scientific document read was cancelled.');
    }
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return scientificDocumentFailure('DOCUMENT_NOT_FOUND', 'Scientific document was not found.');
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return scientificDocumentFailure('ACCESS_DENIED', 'Scientific document access was denied.');
    }
    if (
      error instanceof Error &&
      /inside the owning workspace|symbolic links/iu.test(error.message)
    ) {
      return scientificDocumentFailure(
        'ACCESS_DENIED',
        'Scientific document is outside the owning workspace.'
      );
    }
    return scientificDocumentFailure(
      'SERVICE_UNAVAILABLE',
      'The local scientific document service is unavailable.'
    );
  }
}

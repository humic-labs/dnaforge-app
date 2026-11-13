import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { parseScientificDocumentIdentity, parseWorkspaceIdentity } from '@waypoint/domain-services';
import { parseResourceId, parseResourceRevisionId } from '@waypoint/workspace-revisions';
import {
  NativeArtifactPublicationPendingError,
  prepareNativeArtifactSubmission,
  type ScientificArtifactPort,
} from '../shared/scientific-artifact-port';
import type { ArtifactFiles } from '../shared/artifact-io';
import type { SqliteIpcValue } from '../shared/sqlite-ipc';
import { readPrimerById } from '../shared/primer-artifacts/primer-repository';
import { pathRelativeToBoundary } from '../shared/path-boundary';
import { workspaceScopeKey } from '../shared/workspace-scoped-identity';
import { createScientificRelationshipGitReader } from '../shared/scientific-relationship-git';
import { ScientificObjectStore } from './scientific-object-store';
import { readScientificDocumentInMain } from './scientific-document-reader';
import { submitScientificObjectInMain } from './scientific-object-commands';
import { reconcileScientificProjections } from './scientific-projection-service';

export function createNativeScientificArtifactPort(options: {
  db: Database.Database;
  workspaceRoot: string;
  assertCurrent(): void;
  publicationAuthority?: { mutationLease: () => void; databaseFence: () => void };
  files: Pick<ArtifactFiles, 'exists' | 'readTextFile'>;
}): ScientificArtifactPort {
  const scope = (root: string) => {
    options.assertCurrent();
    if (root !== options.workspaceRoot)
      throw new Error('Scientific operation changed its owning project.');
    const row = options.db
      .prepare(
        'SELECT id, repo_uuid FROM workspaces WHERE path = ? AND archived_at IS NULL AND trashed_at IS NULL'
      )
      .get(root) as { id: number; repo_uuid: string | null } | undefined;
    if (!row) throw new Error('The scientific project is unavailable.');
    return { ...row, workspace: parseWorkspaceIdentity(workspaceScopeKey(row.repo_uuid, row.id)) };
  };
  const namespace: ScientificArtifactPort['namespace'] = async (root) => {
    const current = scope(root);
    const catalog = new ScientificObjectStore(options.db, current.id).catalog();
    return catalog.head === null
      ? null
      : { ...catalog, head: catalog.head, workspace: current.workspace };
  };
  const readText: ScientificArtifactPort['readText'] = async (
    path,
    root,
    _legacy,
    acceptedHead
  ) => {
    const current = scope(root),
      relative = pathRelativeToBoundary(path, root);
    if (!relative) throw new Error('The scientific document is outside its owning project.');
    const result = await readScientificDocumentInMain(
      {
        operationId: randomUUID(),
        workspaceRoot: root,
        workspace: current.workspace,
        document: parseScientificDocumentIdentity(relative),
        ...(acceptedHead ? { acceptedHead } : {}),
      },
      { database: options.db }
    );
    options.assertCurrent();
    if (!result.ok)
      throw Object.assign(new Error(result.error.message), { code: result.error.code });
    return {
      content: result.document.content,
      acceptedRevision:
        result.document.revision.kind === 'accepted-object' ? result.document.revision : null,
    };
  };
  const relationshipGitPaths = createScientificRelationshipGitReader({
    namespace,
    files: options.files,
    read: async (input) => {
      const current = scope(input.workspaceRoot);
      if (current.workspace !== input.request.workspace)
        throw new Error('Scientific relationship scope changed.');
      const resource = parseResourceId(input.request.resourceId);
      if (!resource.ok) throw new Error('Invalid scientific resource identity.');
      const { reader } = new ScientificObjectStore(options.db, current.id).read();
      if (input.request.revisionId === undefined) return reader.current(resource.value);
      const revision = parseResourceRevisionId(input.request.revisionId);
      if (!revision.ok) throw new Error('Invalid scientific revision identity.');
      return reader.revision({ resourceId: resource.value, revisionId: revision.value });
    },
  });
  return {
    namespace,
    readText,
    relationshipGitPaths,
    primerById: (id) =>
      readPrimerById(
        {
          select: async <T>(sql: string, params: SqliteIpcValue[] = []) => {
            options.assertCurrent();
            return options.db.prepare(sql).all(...params) as T;
          },
        },
        id
      ),
    publish: async (supplied) => {
      const input = structuredClone(supplied),
        current = scope(input.workspaceRoot);
      const result = await submitScientificObjectInMain(
        options.db,
        prepareNativeArtifactSubmission(input, current.workspace),
        { ...options.publicationAuthority, beforeAccept: options.assertCurrent }
      );
      const accepted = result.accepted;
      if (result.receipt.outcome === 'conflict' || result.receipt.outcome === 'rejected')
        throw new Error('The accepted artifact changed. Inspect it again before saving.');
      if (!accepted) throw new Error('Scientific publication returned no accepted revision.');
      if (result.delivery?.kind !== 'complete')
        throw new NativeArtifactPublicationPendingError(
          accepted,
          `file delivery remains pending: ${result.delivery?.kind === 'blocked' ? result.delivery.error : 'unavailable'}`
        );
      try {
        options.assertCurrent();
        if (!result.nativeProjectionComplete || result.replayed)
          await reconcileScientificProjections({ db: options.db, workspaceId: current.id });
        const loaded = await readText(input.artifactPath, input.workspaceRoot);
        if (
          loaded.acceptedRevision?.resourceRevisionId !== accepted.resourceRevisionId ||
          loaded.acceptedRevision.resourceId !== accepted.resourceId ||
          loaded.content !== input.representation.text
        )
          throw new Error('A different artifact revision is current. Inspect it before saving.');
        options.assertCurrent();
      } catch (error) {
        throw new NativeArtifactPublicationPendingError(
          accepted,
          error instanceof Error ? error.message : 'native reconstruction remains incomplete.'
        );
      }
      return accepted;
    },
  };
}

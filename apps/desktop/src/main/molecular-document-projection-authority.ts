import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  MOLECULAR_DOCUMENT_FILE_KIND,
  type MolecularDocumentSourceProjection,
  type ReconcileMolecularDocumentSourcesRequest,
} from '../shared/molecular-document';
import type { CatalogEntityLinkRow } from '../shared/catalog-associations';
import { scopedProjectionId, workspaceScopeKey } from '../shared/workspace-scoped-identity';
import { readMolecularDocumentFile } from './molecular-document-library';
import { assertWorkspaceWriteAllowed } from './workspace-write-admission';

const requestSchema = z
  .object({
    path: z.string().min(1),
    workspaceRoot: z.string().min(1),
    entityId: z.string().min(1),
    documentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

type SourcePin = { referenceId: string; coordinateSha256: string; artifactRevisionId?: string };

export async function reconcileMolecularDocumentSourceLinksInMain(
  db: Database.Database,
  input: ReconcileMolecularDocumentSourcesRequest,
  runDatabase: <T>(work: () => T) => T = (work) => work()
): Promise<MolecularDocumentSourceProjection> {
  const request = requestSchema.parse(input);
  const saved = await readMolecularDocumentFile({
    path: request.path,
    workspaceRoot: request.workspaceRoot,
  });
  if (saved.revision !== request.documentHash)
    throw new Error('The molecular document changed before its source projection. Reopen it.');
  return runDatabase(() =>
    db.transaction(() => {
      const owner = db
        .prepare('SELECT id,repo_uuid FROM workspaces WHERE path=?')
        .get(request.workspaceRoot) as { id: number; repo_uuid: string | null } | undefined;
      const scope = owner && workspaceScopeKey(owner.repo_uuid, owner.id);
      if (!owner || !scope || scopedProjectionId(scope, saved.document.id) !== request.entityId)
        throw new Error('The molecular document projection must use its exact project identity.');
      const binding = db
        .prepare(
          `SELECT 1 FROM catalog_entities e JOIN catalog_entity_files f ON f.entity_id=e.id
      WHERE e.id=? AND e.type='molecular-document' AND e.storage_type='file' AND e.status='active'
      AND e.workspace_id=? AND f.workspace_id=? AND f.path=? AND f.file_kind=? AND f.status='current'`
        )
        .get(request.entityId, owner.id, owner.id, request.path, MOLECULAR_DOCUMENT_FILE_KIND);
      if (!binding)
        throw new Error(
          'The molecular document projection requires its exact current file binding.'
        );
      const pinsByTarget = new Map<string, SourcePin[]>();
      for (const entry of saved.document.history) {
        const source = entry.snapshot.source;
        if (!source.artifactEntityId) continue;
        const candidates = [
          ...new Set([scopedProjectionId(scope, source.artifactEntityId), source.artifactEntityId]),
        ];
        const target = candidates.find((id) =>
          db
            .prepare(
              "SELECT 1 FROM catalog_entities WHERE id=? AND workspace_id=? AND status='active'"
            )
            .get(id, owner.id)
        );
        if (!target) continue;
        const pins = pinsByTarget.get(target) ?? [];
        pins.push({
          referenceId: entry.referenceId,
          coordinateSha256: entry.snapshot.coordinates.sha256,
          ...(source.artifactRevisionId ? { artifactRevisionId: source.artifactRevisionId } : {}),
        });
        pinsByTarget.set(target, pins);
      }
      const previous = db
        .prepare(
          "SELECT * FROM catalog_entity_links WHERE source_entity_id=? AND relation='uses-source'"
        )
        .all(request.entityId) as CatalogEntityLinkRow[];
      const obsolete = previous.filter((link) => !pinsByTarget.has(link.target_entity_id));
      const changed = [...pinsByTarget].filter(([target, pins]) => {
        const old = previous.find((link) => link.target_entity_id === target);
        return (
          !old ||
          old.confidence !== 'confirmed' ||
          !isDeepStrictEqual(old.evidence === null ? null : JSON.parse(old.evidence), {
            documentId: saved.document.id,
            pins,
          })
        );
      });
      if (obsolete.length || changed.length)
        assertWorkspaceWriteAllowed(db, [request.workspaceRoot, request.path]);
      for (const link of obsolete)
        db.prepare('DELETE FROM catalog_entity_links WHERE id=?').run(link.id);
      for (const [targetEntityId, pins] of changed) {
        const now = Date.now();
        db.prepare(
          `INSERT INTO catalog_entity_links(id,source_entity_id,relation,target_entity_id,confidence,evidence,created_at,updated_at)
          VALUES(?,?,'uses-source',?,'confirmed',?,?,?)
          ON CONFLICT(source_entity_id,relation,target_entity_id) DO UPDATE SET confidence=excluded.confidence,evidence=excluded.evidence,updated_at=excluded.updated_at`
        ).run(
          randomUUID(),
          request.entityId,
          targetEntityId,
          JSON.stringify({ documentId: saved.document.id, pins }),
          now,
          now
        );
      }
      return {
        entityId: request.entityId,
        revision: saved.revision,
        sourceLinkCount: pinsByTarget.size,
      };
    })()
  );
}

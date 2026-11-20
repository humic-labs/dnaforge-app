import type { PrimerRecoveryDependencies } from './primer-recovery-port';
import { readBoundPrimerArtifact, sha256Hex } from '../primers/primer-artifact';
import { isSafeWorkspaceRelativePath, pathRelativeToBoundary } from '../path-boundary';

export const PRIMER_SAVED_SOURCE_EVENT = 'primer_saved_source';
export const PRIMER_RELOCATION_SOURCE_EVENT = 'primer_relocation_source';

export interface PrimerRestoreSelection {
  id: string;
  root: string;
  relativePath: string;
  sha256: string;
}

export interface PrimerRestoreBinding {
  root: string;
  relativePath: string;
  path: string;
  sha256: string;
  revision: number;
  content: string | null;
}

export const primerRestoreBindingQuery = `SELECT w.path AS root, f.relative_path AS relativePath, f.path, json_extract(e.fields,'$.artifact.revision') AS revision,
       json_extract(e.fields,'$.artifact.contentHash') AS sha256, json_extract(s.payload,'$.content') AS content
     FROM lims_entity e JOIN workspaces w ON e.workspace_id=w.id
     JOIN catalog_entities c ON c.id=e.id AND c.workspace_id=w.id AND c.type='primer' AND c.status IN ('active','missing')
     JOIN catalog_entity_files f ON f.entity_id=e.id AND f.workspace_id=w.id AND f.file_kind='primer-artifact' AND f.status IN ('current','missing')
     LEFT JOIN catalog_entity_events s ON s.entity_id=e.id AND s.event_type IN (?,?)
       AND f.relative_path=json_extract(s.payload,'$.relativePath') AND json_extract(e.fields,'$.artifact.contentHash')=json_extract(s.payload,'$.sha256')
     WHERE e.id=? AND e.tombstone=0 AND e.archived_at IS NULL AND w.archived_at IS NULL AND w.trashed_at IS NULL AND w.access_mode='writable'
       AND json_extract(e.fields,'$.artifact.schema')='dnaforge.primer'
       AND f.relative_path=json_extract(e.fields,'$.artifact.relativePath')
       AND f.content_hash='sha256:'||json_extract(e.fields,'$.artifact.contentHash')
       AND NOT EXISTS (SELECT 1 FROM catalog_entity_files other WHERE other.entity_id=e.id AND other.id<>f.id AND other.status='current')
       AND NOT EXISTS (SELECT 1 FROM org_registry_local_records o WHERE o.entity_id=e.id)
       AND NOT EXISTS (SELECT 1 FROM scientific_revision_refs r WHERE r.workspace_id=w.id AND r.ref_name='accepted' AND r.head IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM scientific_materialization_jobs j WHERE j.workspace_id=w.id AND j.status<>'succeeded')
       AND NOT EXISTS (SELECT 1 FROM catalog_entity_events m WHERE f.status='missing' AND m.entity_id=e.id AND m.event_type='file_missing'
         AND m.created_at>=f.missing_since AND json_extract(m.payload,'$.path')=f.path
         AND json_extract(m.payload,'$.reason') IN ('deleted','moved-to-trash'))
     ORDER BY s.rowid DESC LIMIT 1`;

type SourcePlatform = Pick<ReturnType<PrimerRecoveryDependencies['io']>, 'db' | 'fs'> & {
  lims?: {
    readCommittedPrimerSource?(request: {
      entityId: string;
      mutationToken?: string;
    }): Promise<string | null>;
  };
};

export async function readRetainedPrimerSource(
  platform: SourcePlatform,
  id: string,
  mutationToken?: string
) {
  const [source] = await platform.db.select<PrimerRestoreBinding[]>(primerRestoreBindingQuery, [
    PRIMER_SAVED_SOURCE_EVENT,
    PRIMER_RELOCATION_SOURCE_EVENT,
    id,
  ]);
  if (!source || !isSafeWorkspaceRelativePath(source.relativePath)) return null;
  if (pathRelativeToBoundary(source.path, source.root) !== source.relativePath) return null;
  if (!(await platform.fs.exists(source.root))) return null;
  if (
    !(await platform.fs.validateWorkspacePath({
      workspaceRoot: source.root,
      path: source.path,
      allowMissing: true,
    }))
  )
    return null;
  const content =
    source.content ??
    (await platform.lims?.readCommittedPrimerSource?.({ entityId: id, mutationToken }));
  if (content == null) return null;
  if (typeof content !== 'string' || (await sha256Hex(content)) !== source.sha256)
    throw new Error('The retained primer document does not match its saved checksum.');
  const artifact = readBoundPrimerArtifact(content, source.relativePath, id);
  if (artifact.artifactRevision !== source.revision)
    throw new Error('The retained primer document does not match its saved revision.');
  return { ...source, content, artifact };
}

import type Database from 'better-sqlite3';
import { savedFileWorkspace } from './saved-file-publication';
import { stageExistingFileSource } from './saved-file-sources';
import { assertCommittedDatabaseReadAllowed } from './workspace-sync-database-fence';

export async function retainTrackProjectionSource(
  db: Database.Database,
  source: { project: string; entityId: string; sha256: string },
  admission: {
    resolveProject(project: string): Promise<string>;
    captureReadable(root: string): (() => void) | Promise<() => void>;
  },
  read: (root: string) => Promise<{ path: string; revision: string }>,
  blobRoot?: string
) {
  const root = await admission.resolveProject(source.project);
  const check = await admission.captureReadable(root);
  const assertCurrent = () => {
    check();
    assertCommittedDatabaseReadAllowed(db);
  };
  assertCurrent();
  const workspace = savedFileWorkspace(db, root);
  if (!workspace) throw new Error('The source has no owning project.');
  const owner = {
    workspaceId: workspace.id,
    entityId: source.entityId,
  };
  const prior = db
    .prepare(
      `SELECT 1 FROM retained_file_source_revisions WHERE workspace_id=? AND entity_id=?
      AND status='committed' AND json_array_length(manifest_json,'$.members')=1
      AND json_extract(manifest_json,'$.members[0].sha256')=? LIMIT 1`
    )
    .get(owner.workspaceId, owner.entityId, source.sha256);
  if (prior) return;
  const checked = await read(root);
  const stage = await stageExistingFileSource(db, checked.path, checked.revision, blobRoot);
  assertCurrent();
  stage(owner);
}

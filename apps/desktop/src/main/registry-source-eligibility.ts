import type Database from 'better-sqlite3';
import { isSafeWorkspaceRelativePath, stripTrailingSep } from '../shared/path-boundary';
import {
  isEntityRecordArtifactProjection,
  REGISTRY_ARTIFACT_SEARCH_PROJECTION_KEY,
} from '../shared/registry-file-types';
import {
  configuredDeveloperImportSourceRoots,
  DEVELOPER_IMPORT_SOURCE_ROOTS_SETTING_KEY,
  isDeveloperImportSourcePath,
  normalizeDeveloperImportSourceRoots,
  parseStoredDeveloperImportSourceRoots,
} from '../shared/developer-import-sources';

function storedDeveloperImportSourceRoots(db: Database.Database): string[] {
  const row = db
    .prepare('SELECT value FROM settings WHERE key=?')
    .get(DEVELOPER_IMPORT_SOURCE_ROOTS_SETTING_KEY) as { value: string } | undefined;
  return parseStoredDeveloperImportSourceRoots(row?.value);
}

export function rememberDeveloperImportSourceRootsInDb(
  db: Database.Database,
  configuredRoots: readonly string[] = configuredDeveloperImportSourceRoots()
): void {
  if (configuredRoots.length === 0) return;
  const previous = storedDeveloperImportSourceRoots(db);
  const roots = normalizeDeveloperImportSourceRoots([...previous, ...configuredRoots]);
  if (JSON.stringify(previous) === JSON.stringify(roots)) return;
  db.prepare(
    `INSERT INTO settings(key,value,updated_at) VALUES(?,?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`
  ).run(DEVELOPER_IMPORT_SOURCE_ROOTS_SETTING_KEY, JSON.stringify(roots), Date.now());
  db.prepare(
    `UPDATE catalog_entities SET status='missing'
    WHERE type='record' AND storage_type='database' AND locator='entity://lims/'||id
      AND CASE WHEN json_valid(metadata) THEN json_extract(metadata,'$.${REGISTRY_ARTIFACT_SEARCH_PROJECTION_KEY}') ELSE 0 END=1
      AND id IN (SELECT id FROM lims_entity WHERE NOT (${registrySourceEligibilitySql(db)}))`
  ).run();
}

export function developerImportSourceRootsInDb(db: Database.Database): string[] {
  return normalizeDeveloperImportSourceRoots([
    ...storedDeveloperImportSourceRoots(db),
    ...configuredDeveloperImportSourceRoots(),
  ]);
}

export function registrySourceEligibilitySql(db: Database.Database): string {
  const roots = developerImportSourceRootsInDb(db);
  if (roots.length === 0) return '1';
  db.function('dnaforge_is_developer_import_source', { deterministic: true }, (path: unknown) =>
    typeof path === 'string' && isDeveloperImportSourcePath(path, roots) ? 1 : 0
  );
  db.function(
    'dnaforge_is_developer_source_entity_artifact',
    { deterministic: true },
    (workspacePath: unknown, fieldsJson: unknown) => {
      if (typeof workspacePath !== 'string' || typeof fieldsJson !== 'string') return 0;
      let fields: unknown;
      try {
        fields = JSON.parse(fieldsJson);
      } catch {
        return 0;
      }
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return 0;
      if (!isEntityRecordArtifactProjection(fields as Record<string, unknown>)) return 0;
      const artifact = (fields as { artifact: { relativePath?: unknown } }).artifact;
      if (
        typeof artifact.relativePath !== 'string' ||
        !isSafeWorkspaceRelativePath(artifact.relativePath)
      )
        return 0;
      const path = `${stripTrailingSep(workspacePath)}/${artifact.relativePath.replace(/\\/g, '/')}`;
      return isDeveloperImportSourcePath(path, roots) ? 1 : 0;
    }
  );
  return `CASE
    WHEN EXISTS (SELECT 1 FROM catalog_entity_files current_file
                 WHERE current_file.entity_id=lims_entity.id AND current_file.status='current')
    THEN EXISTS (SELECT 1 FROM catalog_entity_files current_file
                 WHERE current_file.entity_id=lims_entity.id AND current_file.status='current'
                   AND NOT dnaforge_is_developer_import_source(current_file.path))
    ELSE NOT (
      dnaforge_is_developer_import_source(
        CASE WHEN json_valid(lims_entity.fields)
             THEN json_extract(lims_entity.fields,'$._managedSequenceDocument.packageRoot') END)
      OR (lims_entity.kind='notebook' AND dnaforge_is_developer_import_source(
        CASE WHEN json_valid(lims_entity.fields)
             THEN json_extract(lims_entity.fields,'$.packagePath') END))
      OR EXISTS (SELECT 1 FROM catalog_entities file_entity
                 WHERE file_entity.id=lims_entity.id AND file_entity.storage_type='file'
                   AND substr(file_entity.locator,1,7)='file://'
                   AND dnaforge_is_developer_import_source(substr(file_entity.locator,8)))
      OR EXISTS (SELECT 1 FROM workspaces artifact_owner
                 WHERE artifact_owner.id=lims_entity.workspace_id
                   AND dnaforge_is_developer_source_entity_artifact(
                     artifact_owner.path,lims_entity.fields))
    ) END`;
}

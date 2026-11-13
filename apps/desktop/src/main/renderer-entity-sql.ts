import type Database from 'better-sqlite3';

const guardedDatabases = new WeakSet<Database.Database>();
const activeRendererStatements = new WeakSet<Database.Database>();

export function installRendererEntitySqlGuard(db: Database.Database): void {
  if (guardedDatabases.has(db)) return;
  db.function('dnaforge_renderer_entity_sql', () => (activeRendererStatements.has(db) ? 1 : 0));
  for (const [table, identityColumns] of [
    ['catalog_entities', '*'],
    ['catalog_entity_files', '*'],
    ['catalog_entity_links', '*'],
    ['catalog_entity_events', '*'],
    ['catalog_provider_bindings', '*'],
    ['catalog_workspace_placements', '*'],
    ['indexed_files', '*'],
    ['sequences', '*'],
    ['workspaces', 'id,name,path,repo_uuid,origin_path,access_mode,archived_at,trashed_at'],
    ['pages', '*'],
    ['entity_projection_sources', '*'],
    ['entity_references', '*'],
    ['entity_reference_revisions', '*'],
  ]) {
    for (const operation of [
      'INSERT',
      identityColumns === '*' ? 'UPDATE' : `UPDATE OF ${identityColumns}`,
      'DELETE',
    ]) {
      const suffix = operation.split(' ')[0].toLowerCase();
      db.exec(`CREATE TEMP TRIGGER dnaforge_renderer_${table}_${suffix}
        BEFORE ${operation} ON main.${table}
        WHEN dnaforge_renderer_entity_sql() = 1
        BEGIN SELECT RAISE(ABORT, 'ENTITY_IDENTITY_REQUIRES_NATIVE_COMMAND'); END;`);
    }
  }
  const authorityTables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND (name GLOB 'lims_*' OR name GLOB 'scientific_*')"
    )
    .all() as Array<{ name: string }>;
  for (const { name } of authorityTables) {
    if (!/^(?:lims|scientific)_[a-z0-9_]+$/u.test(name))
      throw new Error('Invalid native authority table name.');
    const reason = name.startsWith('scientific_')
      ? 'SCIENTIFIC_AUTHORITY_REQUIRES_NATIVE_COMMAND'
      : 'REGISTRY_AUTHORITY_REQUIRES_NATIVE_COMMAND';
    for (const operation of ['INSERT', 'UPDATE', 'DELETE'])
      db.exec(`CREATE TEMP TRIGGER dnaforge_renderer_${name}_${operation.toLowerCase()}
      BEFORE ${operation} ON main.${name} WHEN dnaforge_renderer_entity_sql()=1
      BEGIN SELECT RAISE(ABORT, '${reason}'); END;`);
  }
  const canonical = (
    id: string,
    details: string
  ) => `(COALESCE(CASE WHEN json_valid(${details}) THEN json_extract(${details},'$.authority') END,'')='primer_artifact'
    OR EXISTS(SELECT 1 FROM catalog_entities WHERE id=${id} AND type='primer')
    OR EXISTS(SELECT 1 FROM lims_entity WHERE id=${id} AND kind IN ('oligo','rna_oligo')))`;
  db.exec(`CREATE TEMP TRIGGER dnaforge_renderer_legacy_primer_creation
    BEFORE INSERT ON main.primers WHEN dnaforge_renderer_entity_sql()=1
    BEGIN SELECT RAISE(ABORT, 'PRIMER_CREATION_REQUIRES_NATIVE_COMMAND'); END;
    CREATE TEMP TRIGGER dnaforge_renderer_legacy_primer_identity
    BEFORE UPDATE OF id,workspace_id ON main.primers WHEN dnaforge_renderer_entity_sql()=1
      AND (NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id)
    BEGIN SELECT RAISE(ABORT, 'PRIMER_IDENTITY_REQUIRES_NATIVE_COMMAND'); END;`);
  const writableLegacyOwner = (owner: string) =>
    `(${owner} IS NULL OR EXISTS(SELECT 1 FROM workspaces WHERE id=${owner} AND access_mode='writable' AND archived_at IS NULL AND trashed_at IS NULL))`;
  for (const operation of ['UPDATE', 'DELETE'])
    db.exec(`CREATE TEMP TRIGGER dnaforge_renderer_legacy_primer_owner_${operation.toLowerCase()}
    BEFORE ${operation} ON main.primers WHEN dnaforge_renderer_entity_sql()=1 AND NOT ${writableLegacyOwner('OLD.workspace_id')}
    BEGIN SELECT RAISE(ABORT, 'PRIMER_OWNER_REQUIRES_WRITABLE_WORKSPACE'); END;`);
  db.exec(`CREATE TEMP TRIGGER dnaforge_renderer_legacy_binding_identity
    BEFORE UPDATE OF id,primer_id,sequence_id ON main.primer_bindings WHEN dnaforge_renderer_entity_sql()=1
      AND (NEW.id IS NOT OLD.id OR NEW.primer_id IS NOT OLD.primer_id OR NEW.sequence_id IS NOT OLD.sequence_id)
    BEGIN SELECT RAISE(ABORT, 'PRIMER_BINDING_IDENTITY_REQUIRES_NATIVE_COMMAND'); END;
    CREATE TEMP TRIGGER dnaforge_renderer_legacy_binding_replacement
    BEFORE INSERT ON main.primer_bindings WHEN dnaforge_renderer_entity_sql()=1 AND EXISTS(SELECT 1 FROM primer_bindings WHERE id=NEW.id)
    BEGIN SELECT RAISE(ABORT, 'PRIMER_BINDING_REPLACEMENT_REQUIRES_NATIVE_COMMAND'); END;`);
  for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
    const old = operation === 'INSERT' ? '0' : canonical('OLD.id', 'OLD.origin_details');
    const next =
      operation === 'DELETE'
        ? '0'
        : `(${canonical('NEW.id', 'NEW.origin_details')} OR ${canonical('NEW.id', '(SELECT origin_details FROM primers WHERE id=NEW.id)')})`;
    db.exec(`CREATE TEMP TRIGGER dnaforge_renderer_canonical_primers_${operation.toLowerCase()}
      BEFORE ${operation} ON main.primers WHEN dnaforge_renderer_entity_sql()=1 AND (${old} OR ${next})
      BEGIN SELECT RAISE(ABORT, 'CANONICAL_PRIMER_REQUIRES_NATIVE_COMMAND'); END;`);
    const bindingOwner = (prefix: string) =>
      `(${canonical(`${prefix}.primer_id`, `(SELECT origin_details FROM primers WHERE id=${prefix}.primer_id)`)} )`;
    const oldBinding = operation === 'INSERT' ? '0' : bindingOwner('OLD');
    const nextBinding = operation === 'DELETE' ? '0' : bindingOwner('NEW');
    db.exec(`CREATE TEMP TRIGGER dnaforge_renderer_canonical_bindings_${operation.toLowerCase()}
      BEFORE ${operation} ON main.primer_bindings WHEN dnaforge_renderer_entity_sql()=1 AND (${oldBinding} OR ${nextBinding})
      BEGIN SELECT RAISE(ABORT, 'CANONICAL_PRIMER_REQUIRES_NATIVE_COMMAND'); END;`);
    const ownerPrefix = operation === 'DELETE' ? 'OLD' : 'NEW';
    db.exec(`CREATE TEMP TRIGGER dnaforge_renderer_legacy_binding_owner_${operation.toLowerCase()}
      BEFORE ${operation} ON main.primer_bindings WHEN dnaforge_renderer_entity_sql()=1
        AND NOT ${writableLegacyOwner(`(SELECT workspace_id FROM primers WHERE id=${ownerPrefix}.primer_id)`)}
      BEGIN SELECT RAISE(ABORT, 'PRIMER_OWNER_REQUIRES_WRITABLE_WORKSPACE'); END;`);
  }
  guardedDatabases.add(db);
}

export function withRendererEntitySql<T>(
  db: Database.Database,
  sql: string,
  operation: () => T
): T {
  if (/\b(?:CREATE|DROP|ALTER|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX)\b/iu.test(sql))
    throw new Error('Renderer database statements cannot change database schema or authority.');
  installRendererEntitySqlGuard(db);
  activeRendererStatements.add(db);
  try {
    return operation();
  } finally {
    activeRendererStatements.delete(db);
  }
}

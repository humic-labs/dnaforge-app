import type Database from 'better-sqlite3';

export function registeredSpecializedAuthority(
  db: Database.Database,
  entityId: string
): 'primer_artifact' | 'sequence_package' | null {
  const rows = db
    .prepare('SELECT DISTINCT authority_kind FROM org_registry_local_records WHERE entity_id=?')
    .all(entityId) as Array<{ authority_kind: string }>;
  const specialized = rows.find(
    (row) => row.authority_kind === 'primer_artifact' || row.authority_kind === 'sequence_package'
  );
  if (!specialized) return null;
  if (rows.length !== 1)
    throw new Error(
      'The registered record has conflicting saved authorities. Preserve its files and review its organization connection.'
    );
  return specialized.authority_kind === 'primer_artifact' ? 'primer_artifact' : 'sequence_package';
}

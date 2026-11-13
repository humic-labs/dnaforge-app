import { LIMS_REGISTRATION_STATUSES, type LimsEntity } from './lims';

export function parseLimsEntitySnapshot(value: unknown): LimsEntity {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Saved entity result is invalid.');
  const row = Object.fromEntries(Object.entries(value));
  const text = (key: string) => {
    const value = row[key];
    if (typeof value !== 'string') throw new Error(`Saved entity ${key} is invalid.`);
    return value;
  };
  const nullableText = (key: string) => (row[key] === null ? null : text(key));
  const number = (key: string) => {
    const value = row[key];
    if (typeof value !== 'number' || !Number.isFinite(value))
      throw new Error(`Saved entity ${key} is invalid.`);
    return value;
  };
  const nullableNumber = (key: string) => (row[key] === null ? null : number(key));
  const registrationStatus = LIMS_REGISTRATION_STATUSES.find(
    (status) => status === row.registrationStatus
  );
  if (
    !registrationStatus ||
    typeof row.tombstone !== 'boolean' ||
    !row.fields ||
    typeof row.fields !== 'object' ||
    Array.isArray(row.fields)
  )
    throw new Error('Saved entity state is invalid.');
  return {
    id: text('id'),
    kind: text('kind'),
    schemaId: nullableText('schemaId'),
    schemaRevisionId: text('schemaRevisionId'),
    name: text('name'),
    registryId: nullableText('registryId'),
    fields: Object.fromEntries(Object.entries(row.fields)),
    registrationStatus,
    domainStatus: nullableText('domainStatus'),
    workspaceId: nullableNumber('workspaceId'),
    actor: nullableText('actor'),
    eventSeq: nullableNumber('eventSeq'),
    tombstone: row.tombstone,
    createdAt: number('createdAt'),
    updatedAt: number('updatedAt'),
    archivedAt: nullableNumber('archivedAt'),
  };
}

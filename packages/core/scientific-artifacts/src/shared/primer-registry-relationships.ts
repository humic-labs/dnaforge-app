export interface PrimerRegistryRelationship {
  id: string;
  fromEntityId: string;
  toEntityId: string;
  type: string;
  payload: Record<string, unknown>;
  project:
    | { status: 'assigned'; repoUuid: string }
    | { status: 'unassigned' }
    | { status: 'unresolved' };
  actor: string | null;
  sourceEventSeq: number | null;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const validId = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
const finiteTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

function requireJsonSafeRelationshipValue(value: unknown): void {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return;
  if (Array.isArray(value)) {
    value.forEach(requireJsonSafeRelationshipValue);
    return;
  }
  if (isRecord(value)) {
    Object.values(value).forEach(requireJsonSafeRelationshipValue);
    return;
  }
  throw new Error('Primer Registry relationship payload must contain finite JSON values.');
}

export function parsePrimerRegistryRelationships(
  value: unknown,
  primerId: string
): PrimerRegistryRelationship[] {
  if (!Array.isArray(value)) throw new Error('Primer Registry relationships must be a list.');
  const ids = new Set<string>();
  const tuples = new Set<string>();
  for (const link of value) {
    if (
      !isRecord(link) ||
      !validId(link.id) ||
      !validId(link.fromEntityId) ||
      !validId(link.toEntityId) ||
      !validId(link.type) ||
      !isRecord(link.payload) ||
      (link.fromEntityId !== primerId && link.toEntityId !== primerId) ||
      link.fromEntityId === link.toEntityId ||
      !isRecord(link.project) ||
      !['assigned', 'unassigned', 'unresolved'].includes(String(link.project.status)) ||
      (link.project.status === 'assigned' && !validId(link.project.repoUuid)) ||
      (link.actor !== null && typeof link.actor !== 'string') ||
      (link.sourceEventSeq !== null &&
        (!Number.isSafeInteger(link.sourceEventSeq) || Number(link.sourceEventSeq) < 1)) ||
      typeof link.archived !== 'boolean' ||
      !finiteTime(link.createdAt) ||
      !finiteTime(link.updatedAt) ||
      (link.archivedAt !== null && !finiteTime(link.archivedAt)) ||
      (!link.archived && link.archivedAt !== null)
    )
      throw new Error('Primer Registry relationship evidence is invalid.');
    requireJsonSafeRelationshipValue(link.payload);
    const tuple = JSON.stringify([link.fromEntityId, link.toEntityId, link.type]);
    if (ids.has(link.id) || tuples.has(tuple))
      throw new Error('Primer Registry relationship identities must be unique.');
    ids.add(link.id);
    tuples.add(tuple);
  }
  return value as PrimerRegistryRelationship[];
}

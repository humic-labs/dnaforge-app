import type { DnaSequenceRef, LimsEntity, LimsRegistrySort } from './lims';

export const LIMS_ENTITY_QUERY_HARD_MAX = 50_000;

export function startOfDayMs(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function endOfDayMs(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1);
  return d.getTime();
}

export interface RegistrySortKey {
  name: string;
  id: string;
  updatedAt: number;
  kind: string;
  registrationStatus: string;
  registryId: string | null;
}

export function compareRegistryIds(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

export function compareRegistrySummaries(
  a: RegistrySortKey,
  b: RegistrySortKey,
  sort: LimsRegistrySort
): number {
  const tie = a.id.localeCompare(b.id);
  switch (sort) {
    case 'name_asc':
      return a.name.localeCompare(b.name) || tie;
    case 'name_desc':
      return b.name.localeCompare(a.name) || tie;
    case 'kind_asc':
      return a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || tie;
    case 'kind_desc':
      return b.kind.localeCompare(a.kind) || a.name.localeCompare(b.name) || tie;
    case 'status_asc':
      return (
        a.registrationStatus.localeCompare(b.registrationStatus) ||
        a.name.localeCompare(b.name) ||
        tie
      );
    case 'status_desc':
      return (
        b.registrationStatus.localeCompare(a.registrationStatus) ||
        a.name.localeCompare(b.name) ||
        tie
      );
    case 'registry_id_asc':
      return compareRegistryIds(a.registryId, b.registryId) || tie;
    case 'registry_id_desc':
      return compareRegistryIds(b.registryId, a.registryId) || tie;
    case 'updated_asc':
      return a.updatedAt - b.updatedAt || tie;
    case 'updated_desc':
    default:
      return b.updatedAt - a.updatedAt || tie;
  }
}

export function entitySequenceSearchText(entity: LimsEntity): string {
  const sequence = entity.fields.sequence as DnaSequenceRef | undefined;
  if (!sequence) return '';
  if (sequence.mode === 'inline') return sequence.bases ?? '';
  if (sequence.mode === 'file') {
    return [sequence.sourceFormat, sequence.topology].filter(Boolean).join(' ');
  }
  return '';
}

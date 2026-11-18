import type { DnaSequenceRef, LimsEntity, LimsQueryRegistrySummariesInput } from './lims';
import {
  compareRegistrySummaries,
  endOfDayMs,
  entitySequenceSearchText,
  startOfDayMs,
} from './lims-registry';
import { rollUpToSpeciesTaxon, type SpeciesTaxon } from './lims-taxonomy';
import { registryRepresentationForEntity } from './registry-entity-opening';
import { calendarDay } from '@waypoint/scientific-objects';
import { parseLimsTemporalField } from '@waypoint/scientific-artifacts/shared/lims-temporal';

export type RegistryDateFieldReader = (
  entity: LimsEntity,
  key: string
) => { schemaId: string; type: 'date' | 'datetime' } | null;

export interface RegistryEntityPage {
  entities: LimsEntity[];
  totalCount: number;
  limit: number;
  offset: number;
}

export function createRegistryQuery(
  input: LimsQueryRegistrySummariesInput = {},
  readDateField?: RegistryDateFieldReader
): (candidates: readonly LimsEntity[]) => RegistryEntityPage {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const offset = Math.max(input.offset ?? 0, 0);
  const search = input.search?.trim().toLowerCase();
  const nameLike = input.nameLike?.trim().toLowerCase();
  const sequenceLike = input.sequenceLike?.trim().toLowerCase();
  const registryIdLike = input.registryIdLike?.trim().toLowerCase();
  const kinds = input.kinds && input.kinds.length > 0 ? new Set(input.kinds) : null;
  const statuses =
    input.registrationStatuses && input.registrationStatuses.length > 0
      ? new Set<string>(input.registrationStatuses)
      : null;
  const speciesTaxids =
    input.speciesTaxids && input.speciesTaxids.length > 0 ? new Set(input.speciesTaxids) : null;
  const sort = input.sort ?? 'updated_desc';
  const idFilter = input.ids ? new Set(input.ids) : null;
  if (
    input.workspaceIds !== undefined &&
    (!Array.isArray(input.workspaceIds) ||
      input.workspaceIds.some((id) => !Number.isSafeInteger(id) || id <= 0))
  ) {
    throw new Error('Registry project filters require valid project IDs.');
  }
  const projectFilter = input.workspaceIds ? new Set(input.workspaceIds) : null;
  const filters = input.dateFilters ?? [];
  if (!Array.isArray(filters) || filters.length > 20)
    throw new Error('Choose at most twenty date filters.');
  const numericDate = (value: string, type: 'date' | 'datetime'): number | string => {
    if (type === 'date') return calendarDay(value).toString();
    if (
      !/^\d{4}-\d{2}-\d{2}T\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/u.test(value) ||
      !Number.isFinite(Date.parse(value))
    )
      throw new Error('Date and time filters require an explicit UTC offset.');
    calendarDay(value.slice(0, 10));
    return Date.parse(value);
  };
  const fieldValue = (entity: LimsEntity, schemaId: string, fieldKey: string) => {
    const definition = readDateField?.(entity, fieldKey);
    if (!definition || definition.schemaId !== schemaId) return null;
    const parsed = parseLimsTemporalField(definition.type, entity.fields[fieldKey]);
    return {
      definition,
      parsed,
      sort:
        parsed.kind !== 'exact'
          ? null
          : parsed.value.kind === 'day'
            ? parsed.value.date
            : parsed.value.instant,
    };
  };
  for (const filter of filters) {
    if (
      !filter ||
      typeof filter.schemaId !== 'string' ||
      typeof filter.fieldKey !== 'string' ||
      !['on', 'before', 'after', 'missing', 'unresolved'].includes(filter.mode) ||
      (!['missing', 'unresolved'].includes(filter.mode) && typeof filter.value !== 'string')
    )
      throw new Error('Invalid scientific date filter.');
  }
  const compiledFilters = filters.map((filter) => ({
    ...filter,
    bound:
      filter.value === undefined
        ? null
        : numericDate(
            filter.value,
            /^\d{4}-\d{2}-\d{2}$/u.test(filter.value) ? 'date' : 'datetime'
          ),
  }));
  if (
    input.dateSort &&
    (!['asc', 'desc'].includes(input.dateSort.direction) ||
      typeof input.dateSort.schemaId !== 'string' ||
      typeof input.dateSort.fieldKey !== 'string')
  )
    throw new Error('Invalid scientific date sort.');
  if ((filters.length || input.dateSort) && !readDateField)
    throw new Error('Scientific date definitions are unavailable.');

  return (candidates) => {
    const filtered = candidates.filter((entity) => {
      if (!input.includeArchived && entity.tombstone) return false;
      if (
        projectFilter &&
        (entity.workspaceId === null || !projectFilter.has(entity.workspaceId))
      ) {
        return false;
      }
      if (idFilter && !idFilter.has(entity.id)) return false;
      if (input.kind && entity.kind !== input.kind) return false;
      if (kinds && !kinds.has(entity.kind)) return false;

      if (speciesTaxids) {
        const taxon = entitySpeciesTaxon(entity);
        if (!taxon || !speciesTaxids.has(taxon.speciesTaxid)) return false;
      }
      if (input.registrationStatus && entity.registrationStatus !== input.registrationStatus) {
        return false;
      }
      if (statuses && !statuses.has(entity.registrationStatus)) return false;
      if (input.domainStatus !== undefined && entity.domainStatus !== input.domainStatus) {
        return false;
      }
      if (input.representationKind) {
        const sequence = entity.fields.sequence as DnaSequenceRef | undefined;
        if (registryRepresentationForEntity(entity, sequence).kind !== input.representationKind) {
          return false;
        }
      }
      if (search) {
        const matchesText = buildEntitySearchableText(entity).toLowerCase().includes(search);
        const queryId = normalizeRegistryIdToken(search);
        const entityId = entity.registryId ? normalizeRegistryIdToken(entity.registryId) : null;
        const matchesRegistryId = queryId != null && entityId != null && queryId === entityId;
        if (!matchesText && !matchesRegistryId) return false;
      }
      if (nameLike && !entity.name.toLowerCase().includes(nameLike)) return false;
      if (sequenceLike && !entitySequenceSearchText(entity).toLowerCase().includes(sequenceLike)) {
        return false;
      }
      if (registryIdLike && !(entity.registryId ?? '').toLowerCase().includes(registryIdLike)) {
        return false;
      }
      for (const filter of compiledFilters) {
        const field = fieldValue(entity, filter.schemaId, filter.fieldKey);
        if (!field) return false;
        if (filter.mode === 'missing' || filter.mode === 'unresolved') {
          if (field.parsed.kind !== filter.mode) return false;
        } else {
          const bound = filter.bound!;
          if (
            field.sort === null ||
            typeof field.sort !== typeof bound ||
            (filter.mode === 'on'
              ? field.sort !== bound
              : filter.mode === 'before'
                ? field.sort >= bound
                : field.sort <= bound)
          )
            return false;
        }
      }

      if (input.updatedOn !== undefined) {
        const start = startOfDayMs(input.updatedOn);
        if (entity.updatedAt < start || entity.updatedAt >= endOfDayMs(input.updatedOn))
          return false;
      }
      if (input.updatedAfter !== undefined && entity.updatedAt < endOfDayMs(input.updatedAfter)) {
        return false;
      }
      if (
        input.updatedBefore !== undefined &&
        entity.updatedAt >= startOfDayMs(input.updatedBefore)
      ) {
        return false;
      }
      return true;
    });
    filtered.sort((a, b) => {
      if (input.dateSort) {
        const { schemaId, fieldKey, direction } = input.dateSort;
        const left = fieldValue(a, schemaId, fieldKey)?.sort ?? null;
        const right = fieldValue(b, schemaId, fieldKey)?.sort ?? null;
        if (left === null && right !== null) return 1;
        if (right === null && left !== null) return -1;
        if (left !== null && right !== null && typeof left !== typeof right)
          return typeof left === 'string' ? -1 : 1;
        if (left !== null && right !== null && left !== right)
          return (left < right ? -1 : 1) * (direction === 'asc' ? 1 : -1);
        return a.id.localeCompare(b.id);
      }
      return compareRegistrySummaries(a, b, sort);
    });

    return {
      entities: filtered.slice(offset, offset + limit),
      totalCount: filtered.length,
      limit,
      offset,
    };
  };
}

function normalizeRegistryIdToken(value: string): string | null {
  const match = /^([a-z]+)0*(\d+)$/.exec(value.trim().toLowerCase());
  return match ? `${match[1]}${match[2]}` : null;
}

export function entitySpeciesTaxon(entity: LimsEntity): SpeciesTaxon | null {
  const taxid = typeof entity.fields.speciesTaxid === 'string' ? entity.fields.speciesTaxid : null;
  const name = typeof entity.fields.species === 'string' ? entity.fields.species : null;
  return rollUpToSpeciesTaxon(taxid, name);
}

export function buildEntitySearchableText(entity: LimsEntity): string {
  const parts = [
    entity.id,
    entity.registryId ?? '',
    entity.kind,
    entity.name,
    entity.registrationStatus,
  ];
  for (const value of Object.values(entity.fields)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      parts.push(String(value));
    } else if (Array.isArray(value)) {
      parts.push(value.filter((item) => typeof item === 'string').join(' '));
    } else if (value && typeof value === 'object') {
      const sequence = value as Partial<DnaSequenceRef>;
      if (sequence.mode === 'file') {
        parts.push(String(sequence.sourceFormat ?? ''));
        parts.push(String(sequence.topology ?? ''));
      } else if (sequence.mode === 'inline') {
        parts.push(String(sequence.topology ?? ''));
      } else if (sequence.mode === 'unresolved') {
        parts.push('unresolved sequence');
      }
    }
  }
  return parts.filter(Boolean).join(' ');
}

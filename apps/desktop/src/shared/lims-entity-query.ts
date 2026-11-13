import type { LimsEntity, LimsQueryEntitiesInput } from './lims';
import { LIMS_ENTITY_QUERY_HARD_MAX } from './lims-registry';

interface EntityQueryCondition {
  sql: string;
  params: Array<string | number>;
  matches(entity: LimsEntity): boolean;
}

export interface LimsEntityQueryPlan {
  where: string[];
  params: Array<string | number>;
  fetchLimit: number;
  finishRows(entities: LimsEntity[]): LimsEntity[];
  selectProjectedRows(entities: readonly LimsEntity[]): LimsEntity[];
}

export function createLimsEntityQuery(input: LimsQueryEntitiesInput = {}): LimsEntityQueryPlan {
  const conditions: EntityQueryCondition[] = [];
  if (!input.includeArchived) {
    conditions.push({ sql: 'tombstone = 0', params: [], matches: (entity) => !entity.tombstone });
  }
  if (input.id) {
    conditions.push({
      sql: 'id = ?',
      params: [input.id],
      matches: (entity) => entity.id === input.id,
    });
  }
  if (input.kind) {
    conditions.push({
      sql: 'kind = ?',
      params: [input.kind],
      matches: (entity) => entity.kind === input.kind,
    });
  }
  if (input.workspaceId !== undefined) {
    conditions.push({
      sql: 'workspace_id = ?',
      params: [input.workspaceId],
      matches: (entity) => entity.workspaceId === input.workspaceId,
    });
  }
  if (input.sequenceDocumentId) {
    conditions.push({
      sql: "json_extract(fields, '$.sequence.mode') = 'file'",
      params: [],
      matches: (entity) => sequenceField(entity, 'mode') === 'file',
    });
    conditions.push({
      sql: "json_extract(fields, '$.sequence.documentId') = ?",
      params: [input.sequenceDocumentId],
      matches: (entity) => sequenceField(entity, 'documentId') === input.sequenceDocumentId,
    });
  }
  if (input.registrationStatus) {
    conditions.push({
      sql: 'registration_status = ?',
      params: [input.registrationStatus],
      matches: (entity) => entity.registrationStatus === input.registrationStatus,
    });
  }
  const nameLike = input.nameLike?.trim();
  if (nameLike) {
    const pattern = `%${nameLike}%`;
    const matches = sqliteLikeMatcher(pattern);
    conditions.push({
      sql: 'name LIKE ?',
      params: [pattern],
      matches: (entity) => matches(entity.name),
    });
  }

  const limit = Math.min(Math.max(input.limit ?? 100, 1), LIMS_ENTITY_QUERY_HARD_MAX);
  const hasFieldEquals = Boolean(input.fieldEquals && Object.keys(input.fieldEquals).length > 0);
  const fetchLimit = hasFieldEquals ? LIMS_ENTITY_QUERY_HARD_MAX : limit;
  const finishRows = (entities: LimsEntity[]): LimsEntity[] => {
    if (!hasFieldEquals) return entities;
    return entities
      .filter((entity) =>
        Object.entries(input.fieldEquals ?? {}).every(
          ([key, value]) => entity.fields[key] === value
        )
      )
      .slice(0, limit);
  };
  return {
    where: conditions.map((condition) => condition.sql),
    params: conditions.flatMap((condition) => condition.params),
    fetchLimit,
    finishRows,
    selectProjectedRows: (entities) =>
      finishRows(
        entities
          .filter((entity) => conditions.every((condition) => condition.matches(entity)))
          .sort((left, right) => right.updatedAt - left.updatedAt)
          .slice(0, fetchLimit)
      ),
  };
}

function sequenceField(entity: LimsEntity, field: 'mode' | 'documentId'): unknown {
  const sequence = entity.fields.sequence;
  if (!sequence || typeof sequence !== 'object' || Array.isArray(sequence)) return undefined;
  return (sequence as { mode?: unknown; documentId?: unknown })[field];
}

function sqliteLikeText(value: string): string[] {
  return Array.from(
    value.split('\0', 1)[0].replace(/[A-Z]/g, (character) => character.toLowerCase())
  );
}

function sqliteLikeMatcher(pattern: string): (value: string) => boolean {
  const tokens = sqliteLikeText(pattern);
  return (value) => {
    const characters = sqliteLikeText(value);
    let tokenIndex = 0;
    let characterIndex = 0;
    let wildcardIndex = -1;
    let wildcardCharacterIndex = 0;
    while (characterIndex < characters.length) {
      if (tokens[tokenIndex] === '%') {
        wildcardIndex = tokenIndex;
        wildcardCharacterIndex = characterIndex;
        tokenIndex += 1;
      } else if (tokens[tokenIndex] === '_' || tokens[tokenIndex] === characters[characterIndex]) {
        tokenIndex += 1;
        characterIndex += 1;
      } else if (wildcardIndex >= 0) {
        wildcardCharacterIndex += 1;
        characterIndex = wildcardCharacterIndex;
        tokenIndex = wildcardIndex + 1;
      } else {
        return false;
      }
    }
    while (tokens[tokenIndex] === '%') tokenIndex += 1;
    return tokenIndex === tokens.length;
  };
}

import { expect, it } from 'vitest';
import { workTimeFromInput } from '@waypoint/scientific-objects';
import {
  assertLimsTemporalEdits,
  parseLimsTemporalField,
} from '@waypoint/scientific-artifacts/shared/lims-temporal';
import type { LimsEntity } from './lims';
import { createRegistryQuery } from './registry-query';

const field = { key: 'review', label: 'Review date', type: 'date' as const };
function entity(id: string, value: unknown, schemaId = 'schema-one'): LimsEntity {
  return {
    id,
    kind: 'review',
    schemaId,
    schemaRevisionId: 'revision-one',
    name: id,
    registryId: null,
    fields: { review: value },
    registrationStatus: 'registered',
    domainStatus: null,
    workspaceId: 1,
    actor: null,
    eventSeq: 1,
    tombstone: false,
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
  };
}
const read = (row: LimsEntity, key: string) =>
  key === field.key && row.schemaId ? { schemaId: row.schemaId, type: field.type } : null;

it('filters typed dates and sorts the complete result before paging, leaving legacy values intact', () => {
  const rows = [
    entity('late', '2026-11-30'),
    entity('early', '2026-11-18'),
    entity('legacy', 'next Thursday'),
    entity('missing', null),
    entity('other', '2026-11-18', 'schema-two'),
  ];
  const result = createRegistryQuery(
    {
      dateFilters: [
        { schemaId: 'schema-one', fieldKey: 'review', mode: 'after', value: '2026-11-17' },
      ],
      dateSort: { schemaId: 'schema-one', fieldKey: 'review', direction: 'asc' },
      limit: 1,
    },
    read
  )(rows);
  expect(result.totalCount).toBe(2);
  expect(result.entities.map((row) => row.id)).toEqual(['early']);
  expect(
    createRegistryQuery(
      { dateFilters: [{ schemaId: 'schema-one', fieldKey: 'review', mode: 'unresolved' }] },
      read
    )(rows).entities.map((row) => row.id)
  ).toEqual(['legacy']);
  expect(rows[2]!.fields.review).toBe('next Thursday');
});

it('refuses invalid new dates, preserves unchanged legacy text and validates the chosen clock occurrence', () => {
  expect(() => assertLimsTemporalEdits({ review: '2026-02-30' }, [field])).toThrow();
  expect(() =>
    assertLimsTemporalEdits({ review: 'next Thursday' }, [field], { review: 'next Thursday' })
  ).not.toThrow();
  expect(parseLimsTemporalField('date', 'next Thursday')).toMatchObject({ kind: 'unresolved' });
  const value = workTimeFromInput({
    kind: 'timed',
    local: '2026-11-01T01:30',
    zone: 'America/Los_Angeles',
    fold: 'later',
  });
  const datetime = { ...field, type: 'datetime' as const };
  expect(() => assertLimsTemporalEdits({ review: value }, [datetime])).not.toThrow();
  expect(() => assertLimsTemporalEdits({ review: { ...value, instant: 1 } }, [datetime])).toThrow();
});

it('compares explicit instants independently of their displayed offsets', () => {
  const value = workTimeFromInput({
    kind: 'timed',
    local: '2026-11-01T01:30',
    zone: 'America/Los_Angeles',
    fold: 'later',
  });
  const result = createRegistryQuery(
    {
      dateFilters: [
        {
          schemaId: 'schema-one',
          fieldKey: 'review',
          mode: 'on',
          value: '2026-11-01T04:00:00-05:30',
        },
      ],
    },
    (row) => ({ schemaId: row.schemaId!, type: 'datetime' })
  )([entity('fold', value)]);
  expect(result.entities.map((row) => row.id)).toEqual(['fold']);
});

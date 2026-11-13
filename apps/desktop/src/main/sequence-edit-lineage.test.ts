import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  SEQUENCE_EDIT_TRANSITION_EVENT_TYPE,
  SEQUENCE_EDIT_TRANSITION_SCHEMA,
  type SequenceEditTransitionEventV1,
} from '../shared/sequence-edit-lineage';
import { createTestDb } from './__tests__/test-db';
import {
  appendZeroCoordinateSequenceEditAdvance,
  resolveSequenceEditLineage,
} from './sequence-edit-lineage';

let db: Database.Database;

function hash(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

function event(
  overrides: Partial<SequenceEditTransitionEventV1> = {}
): SequenceEditTransitionEventV1 {
  return {
    schema: SEQUENCE_EDIT_TRANSITION_SCHEMA,
    parentEventId: null,
    draftLineageId: 'draft-lineage',
    beforeFileSha256: hash('a'),
    afterFileSha256: hash('b'),
    beforeTargetDocumentRevision: 'document-a',
    afterTargetDocumentRevision: 'document-b',
    beforeInputRevision: 'revision-a',
    afterInputRevision: 'revision-b',
    beforeTopology: 'linear',
    afterTopology: 'linear',
    transition: {
      beforeLength: 10,
      afterLength: 11,
      operations: [{ kind: 'insert', at: 2, length: 1 }],
    },
    ...overrides,
  };
}

function insert(id: string, value: SequenceEditTransitionEventV1, createdAt: number): void {
  db.prepare(
    `INSERT INTO catalog_entity_events
     (id,entity_id,event_type,actor,payload,created_at)
     VALUES (?,?,?,?,?,?)`
  ).run(
    id,
    'document-1',
    SEQUENCE_EDIT_TRANSITION_EVENT_TYPE,
    'user',
    JSON.stringify(value),
    createdAt
  );
}

beforeEach(() => {
  db = createTestDb();
  db.exec(`
    CREATE TABLE catalog_entity_events (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      actor TEXT NOT NULL,
      summary TEXT,
      payload TEXT,
      created_at INTEGER NOT NULL
    )
  `);
});

describe('saved sequence edit-lineage resolution', () => {
  it('returns the complete forward chain ending at the exact current file', () => {
    insert('event-a', event(), 1);
    insert(
      'event-b',
      event({
        parentEventId: 'event-a',
        beforeFileSha256: hash('b'),
        afterFileSha256: hash('c'),
        beforeTargetDocumentRevision: 'document-b',
        afterTargetDocumentRevision: 'document-c',
        beforeInputRevision: 'revision-b',
        afterInputRevision: 'revision-c',
        transition: {
          beforeLength: 11,
          afterLength: 10,
          operations: [{ kind: 'delete', start: 4, end: 5 }],
        },
      }),
      2
    );

    const resolved = resolveSequenceEditLineage({
      db,
      entityId: 'document-1',
      currentFileSha256: hash('c'),
      analyzedInputRevision: 'revision-a',
      currentInputRevision: 'revision-c',
    });
    expect(resolved.exact).toBe(false);
    expect(resolved.transitions.map(({ id }) => id)).toEqual(['event-a', 'event-b']);
  });

  it('allows exact-current inspection without historical inference', () => {
    expect(
      resolveSequenceEditLineage({
        db,
        entityId: 'document-1',
        currentFileSha256: hash('a'),
        analyzedInputRevision: 'revision-a',
        currentInputRevision: 'revision-a',
      })
    ).toEqual({ exact: true, transitions: [] });
  });

  it('advances the exact file head across an annotation-only write', () => {
    insert('event-a', event(), 1);
    const advance = appendZeroCoordinateSequenceEditAdvance({
      db,
      entityId: 'document-1',
      actionId: 'annotation-action',
      beforeFileSha256: hash('b'),
      afterFileSha256: hash('c'),
      beforeTargetDocumentRevision: 'document-b',
      afterTargetDocumentRevision: 'document-c',
      inputRevision: 'revision-b',
      topology: 'linear',
      sequenceLength: 11,
      eventId: 'annotation-event',
      createdAt: 2,
    });

    expect(advance.event).toMatchObject({
      parentEventId: 'event-a',
      beforeInputRevision: 'revision-b',
      afterInputRevision: 'revision-b',
      transition: { beforeLength: 11, afterLength: 11, operations: [] },
    });
    expect(
      resolveSequenceEditLineage({
        db,
        entityId: 'document-1',
        currentFileSha256: hash('c'),
        analyzedInputRevision: 'revision-a',
        currentInputRevision: 'revision-b',
      }).transitions.map(({ id }) => id)
    ).toEqual(['event-a', 'annotation-event']);
  });

  it('refuses an incomplete parent chain', () => {
    insert('event-b', event({ parentEventId: 'missing', afterFileSha256: hash('c') }), 2);
    expect(() =>
      resolveSequenceEditLineage({
        db,
        entityId: 'document-1',
        currentFileSha256: hash('c'),
        analyzedInputRevision: 'revision-a',
        currentInputRevision: 'revision-b',
      })
    ).toThrow(/incomplete/);
  });

  it('refuses the same analyzed revision in separated edit epochs', () => {
    insert('event-a', event(), 1);
    insert(
      'event-b',
      event({
        parentEventId: 'event-a',
        beforeFileSha256: hash('b'),
        afterFileSha256: hash('c'),
        beforeTargetDocumentRevision: 'document-b',
        afterTargetDocumentRevision: 'document-c',
        beforeInputRevision: 'revision-b',
        afterInputRevision: 'revision-a',
        transition: {
          beforeLength: 11,
          afterLength: 10,
          operations: [{ kind: 'delete', start: 2, end: 3 }],
        },
      }),
      2
    );
    insert(
      'event-c',
      event({
        parentEventId: 'event-b',
        beforeFileSha256: hash('c'),
        afterFileSha256: hash('d'),
        beforeTargetDocumentRevision: 'document-c',
        afterTargetDocumentRevision: 'document-d',
        beforeInputRevision: 'revision-a',
        afterInputRevision: 'revision-d',
      }),
      3
    );

    expect(() =>
      resolveSequenceEditLineage({
        db,
        entityId: 'document-1',
        currentFileSha256: hash('d'),
        analyzedInputRevision: 'revision-a',
        currentInputRevision: 'revision-d',
      })
    ).toThrow(/ambiguous.*epochs/);
  });

  it('refuses a child whose before authority does not match its parent', () => {
    insert('event-a', event(), 1);
    insert(
      'event-b',
      event({
        parentEventId: 'event-a',
        beforeFileSha256: hash('f'),
        afterFileSha256: hash('c'),
        beforeTargetDocumentRevision: 'document-b',
        beforeInputRevision: 'revision-b',
      }),
      2
    );
    expect(() =>
      resolveSequenceEditLineage({
        db,
        entityId: 'document-1',
        currentFileSha256: hash('c'),
        analyzedInputRevision: 'revision-a',
        currentInputRevision: 'revision-b',
      })
    ).toThrow(/disconnected/);
  });
});

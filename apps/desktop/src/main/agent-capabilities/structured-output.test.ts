import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { createTestDb } from '../__tests__/test-db';
import { persistStructuredOutput, readStructuredOutput } from './structured-output';

const databases: Database.Database[] = [];

function database(): Database.Database {
  const db = createTestDb();
  databases.push(db);
  db.exec(`
    CREATE TABLE agent_structured_outputs (
      turn_id TEXT PRIMARY KEY,
      schema_json TEXT NOT NULL,
      raw_result TEXT NOT NULL,
      validation_status TEXT NOT NULL,
      parsed_json TEXT,
      validation_error TEXT,
      artifact_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  return db;
}

afterEach(() => databases.splice(0).forEach((db) => db.close()));

describe('structured agent output', () => {
  it('persists the exact raw result separately from its validated JSON artifact', () => {
    const db = database();
    const rawResult = '{"organism":"E. coli","count":3}';
    const output = persistStructuredOutput(db, {
      turnId: 'turn-valid',
      schema: {
        type: 'object',
        required: ['organism', 'count'],
        additionalProperties: false,
        properties: {
          organism: { type: 'string' },
          count: { type: 'integer' },
        },
      },
      rawResult,
      createdAt: 10,
    });

    expect(output).toMatchObject({
      turnId: 'turn-valid',
      status: 'valid',
      rawResult,
      parsed: { organism: 'E. coli', count: 3 },
    });
    expect(output.artifactId).toMatch(/^structured-sha256-[a-f0-9]{64}$/);
    expect(readStructuredOutput(db, 'turn-valid')).toEqual(output);
  });

  it('retains invalid raw output but never labels it as a valid artifact', () => {
    const db = database();
    const output = persistStructuredOutput(db, {
      turnId: 'turn-invalid',
      schema: {
        type: 'object',
        required: ['answer'],
        properties: { answer: { type: 'number' } },
      },
      rawResult: '```json\n{"answer": 42}\n```',
      createdAt: 11,
    });

    expect(output.status).toBe('invalid');
    expect(output.parsed).toBeNull();
    expect(output.validationError).toMatch(/valid JSON/i);
    expect(readStructuredOutput(db, 'turn-invalid')?.rawResult).toBe(
      '```json\n{"answer": 42}\n```'
    );
  });

  it('rejects an invalid schema rather than silently weakening it', () => {
    const db = database();
    expect(() =>
      persistStructuredOutput(db, {
        turnId: 'turn-bad-schema',
        schema: { type: 'not-a-json-schema-type' },
        rawResult: '{}',
        createdAt: 12,
      })
    ).toThrow(/schema/i);
  });
});

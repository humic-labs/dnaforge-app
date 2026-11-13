import { createHash } from 'node:crypto';

import Ajv, { type AnySchema } from 'ajv';
import type Database from 'better-sqlite3';

import type { AgentStructuredOutputReceipt } from '../../shared/agent-structured-output';

interface PersistStructuredOutputInput {
  turnId: string;
  schema: Record<string, unknown>;
  rawResult: string;
  createdAt: number;
}

interface StructuredOutputRow {
  turn_id: string;
  schema_json: string;
  raw_result: string;
  validation_status: 'valid' | 'invalid';
  parsed_json: string | null;
  validation_error: string | null;
  artifact_id: string;
  created_at: number;
}

const ajv = new Ajv({ allErrors: true, strict: true });

function rowToReceipt(row: StructuredOutputRow): AgentStructuredOutputReceipt {
  return {
    turnId: row.turn_id,
    schema: JSON.parse(row.schema_json) as Record<string, unknown>,
    rawResult: row.raw_result,
    status: row.validation_status,
    parsed: row.parsed_json === null ? null : (JSON.parse(row.parsed_json) as unknown),
    validationError: row.validation_error,
    artifactId: row.artifact_id,
    createdAt: row.created_at,
  };
}

export function persistStructuredOutput(
  db: Database.Database,
  input: PersistStructuredOutputInput
): AgentStructuredOutputReceipt {
  const schemaJson = JSON.stringify(input.schema);
  let validate: ReturnType<Ajv['compile']>;
  try {
    validate = ajv.compile(input.schema as AnySchema);
  } catch (error) {
    throw new Error(
      `Invalid structured output schema: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  let parsed: unknown | null = null;
  let validationError: string | null = null;
  try {
    parsed = JSON.parse(input.rawResult) as unknown;
  } catch {
    validationError = 'The provider result is not valid JSON.';
  }
  if (validationError === null && !validate(parsed)) {
    validationError = ajv.errorsText(validate.errors, { separator: '; ' });
    parsed = null;
  }
  const status = validationError === null ? 'valid' : 'invalid';
  const artifactId = `structured-sha256-${createHash('sha256')
    .update(schemaJson)
    .update('\0')
    .update(input.rawResult)
    .digest('hex')}`;
  db.prepare(
    `INSERT OR REPLACE INTO agent_structured_outputs (
       turn_id, schema_json, raw_result, validation_status, parsed_json,
       validation_error, artifact_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.turnId,
    schemaJson,
    input.rawResult,
    status,
    parsed === null ? null : JSON.stringify(parsed),
    validationError,
    artifactId,
    input.createdAt
  );
  return {
    turnId: input.turnId,
    schema: input.schema,
    rawResult: input.rawResult,
    status,
    parsed,
    validationError,
    artifactId,
    createdAt: input.createdAt,
  };
}

export function readStructuredOutput(
  db: Database.Database,
  turnId: string
): AgentStructuredOutputReceipt | null {
  const row = db.prepare('SELECT * FROM agent_structured_outputs WHERE turn_id = ?').get(turnId) as
    | StructuredOutputRow
    | undefined;
  return row ? rowToReceipt(row) : null;
}

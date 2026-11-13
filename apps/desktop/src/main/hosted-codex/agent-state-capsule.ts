import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

export const AGENT_STATE_CAPSULE_SCHEMA_VERSION = 1;

const HEX64 = /^[0-9a-f]{64}$/u;

export interface AgentStateCapsuleBody {
  readonly schemaVersion: number;
  readonly runId: string;
  readonly sequence: number;
  readonly predecessorDigest: string | null;
  readonly bindings: Readonly<Record<string, string>>;
  readonly watermarks: Readonly<Record<string, number>>;
  readonly references: readonly string[];
  readonly openToolExecutions: readonly string[];
  readonly generations: Readonly<Record<string, string>>;
  readonly budget: Readonly<Record<string, number>>;
  readonly compaction: { readonly inputDigest: string; readonly outputDigest: string } | null;
}

export interface StoredAgentStateCapsule extends AgentStateCapsuleBody {
  readonly capsuleDigest: string;
}

export class AgentStateCapsuleError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'AgentStateCapsuleError';
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`).join(',')}}`;
}

export function agentStateCapsuleDigest(body: AgentStateCapsuleBody): string {
  return createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex');
}

function assertBody(body: AgentStateCapsuleBody): void {
  if (body.schemaVersion !== AGENT_STATE_CAPSULE_SCHEMA_VERSION) {
    throw new AgentStateCapsuleError(
      'unsupported_schema_version',
      `capsule schema version ${body.schemaVersion} is not ${AGENT_STATE_CAPSULE_SCHEMA_VERSION}`
    );
  }
  if (typeof body.runId !== 'string' || body.runId.length === 0) {
    throw new AgentStateCapsuleError('invalid_run', 'capsule runId is required');
  }
  if (!Number.isSafeInteger(body.sequence) || body.sequence < 1) {
    throw new AgentStateCapsuleError('invalid_sequence', 'capsule sequence must start at one');
  }
  if (body.predecessorDigest !== null && !HEX64.test(body.predecessorDigest)) {
    throw new AgentStateCapsuleError(
      'invalid_predecessor',
      'capsule predecessorDigest must be a sha256 digest or null'
    );
  }
  if (body.sequence === 1 && body.predecessorDigest !== null) {
    throw new AgentStateCapsuleError(
      'invalid_predecessor',
      'the first capsule of a run has no predecessor'
    );
  }
  if (body.sequence > 1 && body.predecessorDigest === null) {
    throw new AgentStateCapsuleError(
      'invalid_predecessor',
      'a continuing capsule must name its predecessor'
    );
  }
}

export function createAgentStateCapsuleTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_state_capsules (
      capsule_digest TEXT NOT NULL PRIMARY KEY
        CHECK(length(capsule_digest) = 64 AND capsule_digest NOT GLOB '*[^0-9a-f]*'),
      run_id TEXT NOT NULL CHECK(length(run_id) > 0),
      sequence INTEGER NOT NULL CHECK(sequence >= 1),
      predecessor_digest TEXT
        CHECK(predecessor_digest IS NULL
          OR (length(predecessor_digest) = 64 AND predecessor_digest NOT GLOB '*[^0-9a-f]*')),
      state TEXT NOT NULL CHECK(state IN ('candidate', 'active', 'superseded')),
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL CHECK(created_at BETWEEN 0 AND 8640000000000000),
      UNIQUE (run_id, sequence)
    )
  `);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS agent_state_capsules_one_active
      ON agent_state_capsules (run_id) WHERE state = 'active'
  `);
}

export class AgentStateCapsuleStore {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number = () => Date.now()
  ) {}

  writeCandidate(body: AgentStateCapsuleBody): string {
    assertBody(body);
    const digest = agentStateCapsuleDigest(body);
    this.db
      .prepare(
        `INSERT INTO agent_state_capsules
           (capsule_digest, run_id, sequence, predecessor_digest, state, payload, created_at)
         VALUES (?, ?, ?, ?, 'candidate', ?, ?)`
      )
      .run(
        digest,
        body.runId,
        body.sequence,
        body.predecessorDigest,
        canonicalJson(body),
        this.now()
      );
    return digest;
  }

  activate(runId: string, capsuleDigest: string): void {
    const run = this.db.transaction(() => {
      const candidate = this.db
        .prepare(
          `SELECT sequence, predecessor_digest AS predecessorDigest, payload, state
             FROM agent_state_capsules WHERE capsule_digest = ? AND run_id = ?`
        )
        .get(capsuleDigest, runId) as
        | { sequence: number; predecessorDigest: string | null; payload: string; state: string }
        | undefined;
      if (!candidate) {
        throw new AgentStateCapsuleError('unknown_capsule', 'no such capsule for this run');
      }
      if (candidate.state !== 'candidate') {
        throw new AgentStateCapsuleError(
          'not_a_candidate',
          `capsule is already ${candidate.state}`
        );
      }
      if (createHash('sha256').update(candidate.payload, 'utf8').digest('hex') !== capsuleDigest) {
        throw new AgentStateCapsuleError(
          'digest_mismatch',
          'stored capsule payload does not match its digest'
        );
      }

      const active = this.db
        .prepare(
          `SELECT capsule_digest AS capsuleDigest, sequence
             FROM agent_state_capsules WHERE run_id = ? AND state = 'active'`
        )
        .get(runId) as { capsuleDigest: string; sequence: number } | undefined;

      if (!active) {
        if (candidate.sequence !== 1 || candidate.predecessorDigest !== null) {
          throw new AgentStateCapsuleError(
            'broken_chain',
            'the first active capsule of a run must be sequence one with no predecessor'
          );
        }
      } else {
        if (candidate.predecessorDigest !== active.capsuleDigest) {
          throw new AgentStateCapsuleError(
            'broken_chain',
            'capsule does not continue the active capsule'
          );
        }
        if (candidate.sequence !== active.sequence + 1) {
          throw new AgentStateCapsuleError(
            'broken_chain',
            'capsule sequence must advance by exactly one'
          );
        }
        this.db
          .prepare(`UPDATE agent_state_capsules SET state = 'superseded' WHERE capsule_digest = ?`)
          .run(active.capsuleDigest);
      }

      this.db
        .prepare(`UPDATE agent_state_capsules SET state = 'active' WHERE capsule_digest = ?`)
        .run(capsuleDigest);
    });
    run();
  }

  readActive(runId: string): StoredAgentStateCapsule | null {
    const row = this.db
      .prepare(
        `SELECT capsule_digest AS capsuleDigest, payload
           FROM agent_state_capsules WHERE run_id = ? AND state = 'active'`
      )
      .get(runId) as { capsuleDigest: string; payload: string } | undefined;
    if (!row) return null;
    if (createHash('sha256').update(row.payload, 'utf8').digest('hex') !== row.capsuleDigest) {
      throw new AgentStateCapsuleError(
        'corrupt_active_capsule',
        'active capsule payload does not match its digest'
      );
    }
    let body: AgentStateCapsuleBody;
    try {
      body = JSON.parse(row.payload) as AgentStateCapsuleBody;
    } catch {
      throw new AgentStateCapsuleError('corrupt_active_capsule', 'active capsule is not JSON');
    }
    if (body.schemaVersion !== AGENT_STATE_CAPSULE_SCHEMA_VERSION) {
      throw new AgentStateCapsuleError(
        'unsupported_schema_version',
        `active capsule schema version ${body.schemaVersion} is not readable by this build`
      );
    }
    return { ...body, capsuleDigest: row.capsuleDigest };
  }
}

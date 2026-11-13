import type { EntityRef } from '../descriptor/common.ts';
import type {
  ActionStore,
  AuditEntry,
  AuditSink,
  ProvenanceRecord,
  ProvenanceSink,
} from './types.ts';

function entityKey(entity: EntityRef): string {
  return `${entity.kind}::${entity.id}`;
}

export class InMemoryStore implements ActionStore {
  private revisions = new Map<string, number>();
  private snapshots = new Map<string, unknown>();

  constructor(seed?: Record<string, { revision: number; value: unknown }>) {
    if (!seed) return;
    for (const [key, entry] of Object.entries(seed)) {
      this.revisions.set(key, entry.revision);
      this.snapshots.set(key, entry.value);
    }
  }

  getRevision(entity: EntityRef): number {
    return this.revisions.get(entityKey(entity)) ?? 0;
  }

  bumpRevision(entity: EntityRef): number {
    const key = entityKey(entity);
    const next = (this.revisions.get(key) ?? 0) + 1;
    this.revisions.set(key, next);
    return next;
  }

  seedRevision(entity: EntityRef, revision: number): void {
    if (revision < 0 || !Number.isInteger(revision)) {
      throw new Error(`seedRevision requires a non-negative integer, got ${revision}.`);
    }
    this.revisions.set(entityKey(entity), revision);
  }

  snapshot(entity: EntityRef): unknown {
    return this.snapshots.get(entityKey(entity));
  }

  writeSnapshot(entity: EntityRef, value: unknown): number {
    const key = entityKey(entity);
    this.snapshots.set(key, value);
    return this.bumpRevision(entity);
  }
}

export class InMemoryAuditSink implements AuditSink {
  private log: AuditEntry[] = [];

  append(entry: AuditEntry): void {
    this.log.push(entry);
  }

  entries(): readonly AuditEntry[] {
    return this.log;
  }
}

export class InMemoryProvenanceSink implements ProvenanceSink {
  private records = new Map<string, ProvenanceRecord>();

  attach(record: ProvenanceRecord): void {
    this.records.set(entityKey(record.derivedEntity), record);
  }

  recordFor(entity: EntityRef): ProvenanceRecord | undefined {
    return this.records.get(entityKey(entity));
  }
}

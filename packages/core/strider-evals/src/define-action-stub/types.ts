import type {
  ActionClass,
  ActionEffect,
  ActionErrorCode,
  ActionRuntime,
  EntityRef,
} from '../descriptor/common.ts';

export interface ActionDescriptor<Input, Output> {
  name: string;
  runtime: ActionRuntime;
  effects: readonly ActionEffect[];
  actionClass?: ActionClass;
  parseInput: (raw: unknown) => Input;
  reads: (input: Input) => readonly EntityRef[];
  writes: (input: Input) => readonly EntityRef[];
  handler: (input: Input, ctx: ActionContext) => Promise<Output> | Output;
}

export interface ActionContext {
  sessionId: string;
  store: ActionStore;
  audit: AuditSink;
  provenance: ProvenanceSink;
}

export interface ActionStore {
  getRevision(entity: EntityRef): number;
  bumpRevision(entity: EntityRef): number;
  snapshot(entity: EntityRef): unknown;
  writeSnapshot(entity: EntityRef, value: unknown): number;
  seedRevision?(entity: EntityRef, revision: number): void;
}

export interface ActionErrorPayload {
  code: ActionErrorCode;
  message: string;
  retriable: boolean;
  details?: Record<string, unknown>;
}

export type ActionResult<Output> =
  | { ok: true; result: Output }
  | { ok: false; error: ActionErrorPayload };

export interface AuditEntry {
  actionName: string;
  status: 'ok' | 'error' | 'cancelled';
  sessionId: string;
  scope: readonly string[];
  affectedEntities: readonly EntityRef[];
  beforeState: Record<string, unknown>;
  afterState: Record<string, unknown>;
  error?: ActionErrorPayload;
}

export interface AuditSink {
  append(entry: AuditEntry): void;
  entries(): readonly AuditEntry[];
}

export type { ProvenanceSource } from '../descriptor/provenance.ts';

export interface ProvenanceRecord {
  derivedEntity: EntityRef;
  derivationKind: 'cloning' | 'pcr' | 'assembly' | 'mutation' | 'import' | 'translation';
  sources: readonly import('../descriptor/provenance.ts').ProvenanceSource[];
  actionName: string;
  attachedAt: number;
}

export interface ProvenanceSink {
  attach(record: ProvenanceRecord): void;
  recordFor(entity: EntityRef): ProvenanceRecord | undefined;
}

export interface DispatchOptions {
  sessionId: string;
  store: ActionStore;
  audit: AuditSink;
  provenance: ProvenanceSink;
  expectedRevisions?: Record<string, number>;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export type ActionHandle<Input, Output> = (
  raw: unknown,
  options: DispatchOptions
) => Promise<ActionResult<Output>>;

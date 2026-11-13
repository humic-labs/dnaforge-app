import { canonicalize } from './canonical-json';
import { makeRevisionGraph, type OperationReceiptRecord, type RevisionGraphData } from './graph';
import { hashCanonicalRecord } from './hash';
import type { CanonicalJson, OperationId, OperationReceiptId } from './identity';
import type {
  Conflict,
  ImmutableRecordWrite,
  MutationEffects,
  MutationError,
  NonEmpty,
  RecoveryCandidateView,
  RecoveryError,
  RefAdvance,
  ReplayNoOpReason,
  ReplayView,
  RevisionGraph,
  WorkspaceVersionView,
} from './types';
import { deepFreeze } from './immutable';
import { definePublicationPlan } from './publication';
import { isCanonicalRecordWithinByteLimit } from './record-budgets';

export interface CanonicalRequest {
  readonly body: Readonly<object>;
  readonly canonicalJson: CanonicalJson;
}

export interface DefinedReceipt {
  readonly record: OperationReceiptRecord;
  readonly write: ImmutableRecordWrite;
}

export type ReceiptReplayInput =
  | {
      readonly outcome: 'changed';
      readonly version: WorkspaceVersionView;
      readonly effects: MutationEffects;
      readonly refAdvance: RefAdvance;
      readonly recordWrites: readonly ImmutableRecordWrite[];
    }
  | {
      readonly outcome: 'no-op';
      readonly head: import('./identity').WorkspaceVersionId | null;
      readonly reason: ReplayNoOpReason;
      readonly recordWrites: readonly ImmutableRecordWrite[];
    }
  | {
      readonly outcome: 'conflict';
      readonly conflicts: NonEmpty<Conflict>;
      readonly recordWrites: readonly ImmutableRecordWrite[];
    }
  | {
      readonly outcome: 'rejected';
      readonly error: MutationError | RecoveryError;
      readonly recordWrites: readonly ImmutableRecordWrite[];
    }
  | {
      readonly outcome: 'recovery-candidate';
      readonly candidate: RecoveryCandidateView;
      readonly recordWrites: readonly ImmutableRecordWrite[];
    };

export function defineCanonicalRequest(body: Readonly<object>): CanonicalRequest {
  return { body, canonicalJson: mustCanonicalize(body) };
}

export function defineReceipt(
  operationId: OperationId,
  request: CanonicalRequest,
  replayInput: ReceiptReplayInput
): DefinedReceipt {
  const immutableInput = deepFreeze(replayInput);
  const canonicalJson = mustCanonicalize({
    formatVersion: 2,
    operationId,
    request: request.body,
    result: canonicalReplay(immutableInput),
  });
  if (!isCanonicalRecordWithinByteLimit('operation-receipt', canonicalJson)) {
    throw new Error('Internal operation receipt exceeded its canonical byte budget.');
  }
  const id: OperationReceiptId = hashCanonicalRecord('operation-receipt', canonicalJson);
  const write: ImmutableRecordWrite = {
    kind: 'operation-receipt',
    id,
    canonicalJson,
  };
  const immutableWrite = Object.freeze(write);
  const replay = hydrateReceiptReplay(operationId, immutableInput, immutableWrite);
  return deepFreeze({
    write: immutableWrite,
    record: Object.freeze({
      operationId,
      requestCanonicalJson: request.canonicalJson,
      replay,
      write: immutableWrite,
    }),
  });
}

function canonicalReplay(replay: ReceiptReplayInput): Readonly<object> {
  switch (replay.outcome) {
    case 'changed':
      return {
        outcome: replay.outcome,
        version: replay.version,
        effects: replay.effects,
        refAdvance: replay.refAdvance,
        recordWrites: replay.recordWrites,
      };
    case 'no-op':
      return {
        outcome: replay.outcome,
        head: replay.head,
        reason: replay.reason,
        recordWrites: replay.recordWrites,
      };
    case 'conflict':
      return {
        outcome: replay.outcome,
        conflicts: replay.conflicts,
        recordWrites: replay.recordWrites,
      };
    case 'rejected':
      return { outcome: replay.outcome, error: replay.error, recordWrites: replay.recordWrites };
    case 'recovery-candidate':
      return {
        outcome: replay.outcome,
        candidate: replay.candidate,
        recordWrites: replay.recordWrites,
      };
  }
}

export function hydrateReceiptReplay(
  operationId: OperationId,
  input: ReceiptReplayInput,
  receiptWrite: ImmutableRecordWrite
): ReplayView {
  const firstWrite = input.recordWrites[0];
  const recordWrites: NonEmpty<ImmutableRecordWrite> = firstWrite
    ? deepFreeze([firstWrite, ...input.recordWrites.slice(1), receiptWrite])
    : deepFreeze([receiptWrite]);
  switch (input.outcome) {
    case 'changed':
      return deepFreeze({
        operationId,
        outcome: input.outcome,
        version: input.version,
        effects: input.effects,
        publication: definePublicationPlan(recordWrites, input.refAdvance),
      });
    case 'no-op':
      return deepFreeze({
        operationId,
        outcome: input.outcome,
        head: input.head,
        reason: input.reason,
        recordWrites,
      });
    case 'conflict':
      return deepFreeze({
        operationId,
        outcome: input.outcome,
        conflicts: input.conflicts,
        recordWrites,
      });
    case 'rejected':
      return deepFreeze({
        operationId,
        outcome: input.outcome,
        error: input.error,
        recordWrites,
      });
    case 'recovery-candidate':
      return deepFreeze({
        operationId,
        outcome: input.outcome,
        candidate: input.candidate,
        recordWrites,
      });
  }
}

export function graphWithReceipt(
  data: RevisionGraphData,
  receipt: OperationReceiptRecord
): RevisionGraph {
  const operationReceipts = data.operationReceipts.set(receipt.operationId, receipt).index;
  return makeRevisionGraph({ ...data, operationReceipts });
}

function mustCanonicalize(value: unknown): CanonicalJson {
  const result = canonicalize(value);
  if (!result.ok) throw new Error(`Internal canonical record failed: ${result.error.kind}`);
  return result.value;
}

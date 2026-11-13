import {
  parseOperationId,
  parseResourceId,
  parseWorkspaceId,
  type OperationId,
  type ResourceId,
  type Result,
  type WorkspaceId,
} from './identity';

export const MUTATION_MATRIX_CASE_IDS = Object.freeze([
  'create-valid',
  'edit-valid',
  'edit-no-op',
  'revert-explicit',
  'rename',
  'rename-case-only',
  'move-root',
  'edit-and-rename',
  'merge-disjoint-edits',
  'derived-copy',
  'derived-save-as',
  'derived-fork',
  'derived-template',
  'derived-split',
  'derived-conversion',
  'embedded-id-tamper',
  'member-add',
  'member-remove',
  'member-edit',
  'member-rename',
  'delete-logical',
  'restore-tombstone',
  'reuse-deleted-path',
  'remove-membership',
  'unconfirmed-disappearance',
  'conflict-rename-rename',
  'conflict-edit-edit',
  'conflict-delete-edit',
  'conflict-move-delete',
  'same-bytes-two-ids',
  'hardlink',
  'symlink',
  'git-checkout',
  'git-reset',
  'git-commit',
  'git-merge',
  'git-revert',
  'browser-edit',
  'server-agent-edit',
  'ownership-transfer',
  'recovery-invalid',
  'backup-restore',
  'retry-exact',
  'operation-id-misuse',
] as const);

export type MutationMatrixCaseId = (typeof MUTATION_MATRIX_CASE_IDS)[number];
export type MatrixExecution = 'core' | 'adapter-classification' | 'external-authority' | 'codec';
export type MatrixIdentityEffect = 'new' | 'stable';
export type MatrixAcceptedRefEffect = 'advanced' | 'unchanged' | 'replayed' | 'external-only';
export type MatrixOutcome =
  | 'changed'
  | 'no-op'
  | 'conflict'
  | 'recovery-candidate'
  | 'adapter-only'
  | 'external-authority-only'
  | 'imported'
  | 'replay'
  | 'rejected';

export interface MutationMatrixExpected {
  readonly outcome: MatrixOutcome;
  readonly resourceId: MatrixIdentityEffect;
  readonly revisionId: MatrixIdentityEffect;
  readonly workspaceVersionId: MatrixIdentityEffect;
  readonly acceptedRef: MatrixAcceptedRefEffect;
  readonly classification: string;
}

export interface MutationMatrixCase {
  readonly id: MutationMatrixCaseId;
  readonly baseGraph: string;
  readonly operationId: OperationId;
  readonly operationLabel: string;
  readonly intent: string;
  readonly execution: MatrixExecution;
  readonly expected: MutationMatrixExpected;
}

export interface MutationMatrixFixture {
  readonly formatVersion: 1;
  readonly fixedInputs: {
    readonly workspaceId: WorkspaceId;
    readonly primaryResourceId: ResourceId;
    readonly secondaryResourceId: ResourceId;
    readonly epochMs: number;
    readonly sharedBlobHash: string;
  };
  readonly cases: readonly MutationMatrixCase[];
}

export type MutationMatrixFixtureError =
  | { readonly kind: 'invalid-matrix-fixture' }
  | { readonly kind: 'unknown-case'; readonly id: string }
  | { readonly kind: 'duplicate-case'; readonly id: MutationMatrixCaseId }
  | { readonly kind: 'missing-case'; readonly id: MutationMatrixCaseId };

export interface StateMachineSeedFixture {
  readonly formatVersion: 1;
  readonly seeds: readonly [number, ...number[]];
  readonly maxCommands: number;
  readonly numRunsPerSeed: number;
}

const caseIds: ReadonlySet<string> = new Set(MUTATION_MATRIX_CASE_IDS);
const executions: ReadonlySet<string> = new Set([
  'core',
  'adapter-classification',
  'external-authority',
  'codec',
]);
const identityEffects: ReadonlySet<string> = new Set(['new', 'stable']);
const acceptedRefEffects: ReadonlySet<string> = new Set([
  'advanced',
  'unchanged',
  'replayed',
  'external-only',
]);
const outcomes: ReadonlySet<string> = new Set([
  'changed',
  'no-op',
  'conflict',
  'recovery-candidate',
  'adapter-only',
  'external-authority-only',
  'imported',
  'replay',
  'rejected',
]);

export function parseMutationMatrixFixture(
  input: unknown
): Result<MutationMatrixFixture, MutationMatrixFixtureError> {
  if (
    !isPlainRecord(input) ||
    input.formatVersion !== 1 ||
    !isPlainRecord(input.fixedInputs) ||
    !Array.isArray(input.cases)
  ) {
    return invalidFixture();
  }
  if (
    typeof input.fixedInputs.workspaceId !== 'string' ||
    typeof input.fixedInputs.primaryResourceId !== 'string' ||
    typeof input.fixedInputs.secondaryResourceId !== 'string' ||
    typeof input.fixedInputs.epochMs !== 'number' ||
    !Number.isSafeInteger(input.fixedInputs.epochMs) ||
    input.fixedInputs.epochMs < 0 ||
    typeof input.fixedInputs.sharedBlobHash !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/u.test(input.fixedInputs.sharedBlobHash)
  ) {
    return invalidFixture();
  }
  const workspaceId = parseWorkspaceId(input.fixedInputs.workspaceId);
  const primaryResourceId = parseResourceId(input.fixedInputs.primaryResourceId);
  const secondaryResourceId = parseResourceId(input.fixedInputs.secondaryResourceId);
  if (!workspaceId.ok || !primaryResourceId.ok || !secondaryResourceId.ok) {
    return invalidFixture();
  }

  const cases: MutationMatrixCase[] = [];
  const seen = new Set<MutationMatrixCaseId>();
  for (const candidate of input.cases) {
    const decoded = decodeCase(candidate);
    if (!decoded.ok) return decoded;
    if (seen.has(decoded.value.id)) {
      return { ok: false, error: { kind: 'duplicate-case', id: decoded.value.id } };
    }
    seen.add(decoded.value.id);
    cases.push(decoded.value);
  }
  for (const id of MUTATION_MATRIX_CASE_IDS) {
    if (!seen.has(id)) return { ok: false, error: { kind: 'missing-case', id } };
  }
  return {
    ok: true,
    value: Object.freeze({
      formatVersion: 1,
      fixedInputs: Object.freeze({
        workspaceId: workspaceId.value,
        primaryResourceId: primaryResourceId.value,
        secondaryResourceId: secondaryResourceId.value,
        epochMs: input.fixedInputs.epochMs,
        sharedBlobHash: input.fixedInputs.sharedBlobHash,
      }),
      cases: Object.freeze(cases),
    }),
  };
}

export function parseStateMachineSeedFixture(input: unknown): StateMachineSeedFixture | null {
  if (
    !isPlainRecord(input) ||
    input.formatVersion !== 1 ||
    !Array.isArray(input.seeds) ||
    input.seeds.length === 0 ||
    typeof input.maxCommands !== 'number' ||
    !Number.isSafeInteger(input.maxCommands) ||
    input.maxCommands <= 0 ||
    typeof input.numRunsPerSeed !== 'number' ||
    !Number.isSafeInteger(input.numRunsPerSeed) ||
    input.numRunsPerSeed <= 0
  ) {
    return null;
  }
  const seeds: number[] = [];
  for (const seed of input.seeds) {
    if (typeof seed !== 'number' || !Number.isSafeInteger(seed)) return null;
    seeds.push(seed);
  }
  const first = seeds[0];
  if (first === undefined) return null;
  const nonEmptySeeds: readonly [number, ...number[]] = Object.freeze([first, ...seeds.slice(1)]);
  return Object.freeze({
    formatVersion: 1,
    seeds: nonEmptySeeds,
    maxCommands: input.maxCommands,
    numRunsPerSeed: input.numRunsPerSeed,
  });
}

function decodeCase(input: unknown): Result<MutationMatrixCase, MutationMatrixFixtureError> {
  if (!isPlainRecord(input) || typeof input.id !== 'string') return invalidFixture();
  if (!caseIds.has(input.id)) {
    return { ok: false, error: { kind: 'unknown-case', id: input.id } };
  }
  if (!isMutationMatrixCaseId(input.id)) return invalidFixture();
  if (
    typeof input.operationId !== 'string' ||
    typeof input.baseGraph !== 'string' ||
    input.baseGraph.length === 0 ||
    typeof input.operationLabel !== 'string' ||
    input.operationLabel.length === 0 ||
    typeof input.intent !== 'string' ||
    input.intent.length === 0 ||
    !isMatrixExecution(input.execution) ||
    !isPlainRecord(input.expected) ||
    !isMatrixOutcome(input.expected.outcome) ||
    !isMatrixIdentityEffect(input.expected.resourceId) ||
    !isMatrixIdentityEffect(input.expected.revisionId) ||
    !isMatrixIdentityEffect(input.expected.workspaceVersionId) ||
    !isMatrixAcceptedRefEffect(input.expected.acceptedRef) ||
    typeof input.expected.classification !== 'string' ||
    input.expected.classification.length === 0
  ) {
    return invalidFixture();
  }
  const operationId = parseOperationId(input.operationId);
  if (!operationId.ok) return invalidFixture();
  return {
    ok: true,
    value: Object.freeze({
      id: input.id,
      baseGraph: input.baseGraph,
      operationId: operationId.value,
      operationLabel: input.operationLabel,
      intent: input.intent,
      execution: input.execution,
      expected: Object.freeze({
        outcome: input.expected.outcome,
        resourceId: input.expected.resourceId,
        revisionId: input.expected.revisionId,
        workspaceVersionId: input.expected.workspaceVersionId,
        acceptedRef: input.expected.acceptedRef,
        classification: input.expected.classification,
      }),
    }),
  };
}

function isMutationMatrixCaseId(value: string): value is MutationMatrixCaseId {
  return caseIds.has(value);
}

function isMatrixExecution(value: unknown): value is MatrixExecution {
  return typeof value === 'string' && executions.has(value);
}

function isMatrixIdentityEffect(value: unknown): value is MatrixIdentityEffect {
  return typeof value === 'string' && identityEffects.has(value);
}

function isMatrixAcceptedRefEffect(value: unknown): value is MatrixAcceptedRefEffect {
  return typeof value === 'string' && acceptedRefEffects.has(value);
}

function isMatrixOutcome(value: unknown): value is MatrixOutcome {
  return typeof value === 'string' && outcomes.has(value);
}

function invalidFixture(): Result<never, MutationMatrixFixtureError> {
  return { ok: false, error: { kind: 'invalid-matrix-fixture' } };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

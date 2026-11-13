import {
  startAlignmentCoveragePreparationOperationOperationsAlignmentCoveragePreparationPost,
  type AlignmentCoverageInput,
  type OperationSnapshot,
} from '@waypoint/api-client';

import { managedOperations } from '../../services/managed-operations';

const OPERATION_KIND = 'alignment-coverage-preparation';
const ACTIVE_STATES: ReadonlySet<string> = new Set(['queued', 'running']);

interface CoverageStart {
  readonly started: Promise<OperationSnapshot>;
  admitted: OperationSnapshot | null;
}

const startsByInput = new Map<string, CoverageStart>();

export async function startAlignmentCoverageOperation(
  input: AlignmentCoverageInput
): Promise<OperationSnapshot> {
  pruneSettledStarts();
  const key = coverageInputKey(input);
  const earlier = startsByInput.get(key);
  if (earlier) {
    const reusable = await earlier.started.then(currentReusableSnapshot, () => null);
    if (reusable) return reusable;
    if (startsByInput.get(key) !== earlier) return startAlignmentCoverageOperation(input);
  }
  const entry: CoverageStart = { started: submitAlignmentCoverageOperation(input), admitted: null };
  startsByInput.set(key, entry);
  try {
    entry.admitted = await entry.started;
    return entry.admitted;
  } catch (error) {
    if (startsByInput.get(key) === entry) startsByInput.delete(key);
    throw error;
  }
}

function pruneSettledStarts(): void {
  for (const [key, entry] of startsByInput) {
    if (entry.admitted && !currentReusableSnapshot(entry.admitted)) startsByInput.delete(key);
  }
}

function currentReusableSnapshot(snapshot: OperationSnapshot): OperationSnapshot | null {
  const record = managedOperations
    .getSnapshot()
    .records.find(
      (candidate) =>
        candidate.snapshot.id === snapshot.id &&
        candidate.snapshot.subject.scope_id === snapshot.subject.scope_id
    );
  if (!record) return null;
  const { state, result_status: resultStatus } = record.snapshot;
  if (ACTIVE_STATES.has(state)) return record.snapshot;
  return state === 'succeeded' && resultStatus === 'available' ? record.snapshot : null;
}

function coverageInputKey(input: AlignmentCoverageInput): string {
  return stableJson({ ...input, referencePath: input.referencePath ?? null });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([name, entry]) => `${JSON.stringify(name)}:${stableJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function submitAlignmentCoverageOperation(
  input: AlignmentCoverageInput
): Promise<OperationSnapshot> {
  return managedOperations.startRegisteredOperation(async ({ scopeId, submissionKey }) => {
    const response =
      await startAlignmentCoveragePreparationOperationOperationsAlignmentCoveragePreparationPost({
        submission_key: submissionKey,
        subject: { scope_id: scopeId },
        input,
      });
    if (response.status !== 202) {
      throw new Error(response.data.detail.message);
    }
    if (response.data.kind !== OPERATION_KIND || response.data.subject.scope_id !== scopeId) {
      throw new Error('The operation owner returned an invalid alignment-coverage job.');
    }
    return response.data;
  });
}

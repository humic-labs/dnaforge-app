import { describe, expect, it } from 'vitest';

import {
  applyWorkspaceMutation,
  commitPublication,
  createRevisionGraph,
  defineBlob,
  defineResourceState,
  parseOperationId,
  parseRefName,
  parseResourceId,
  parseWorkspaceId,
  parseWorkspacePath,
  type AtomicPublicationAdapter,
  type PublicationCommitResult,
  type PublicationPlan,
  type Result,
  type WorkspaceVersionId,
} from './index';

const MAIN_REF = must(parseRefName('main'));

describe('atomic publication capability', () => {
  it('commits immutable metadata and the accepted ref as one adapter operation', async () => {
    const changed = changedResult();
    const adapter = new TransactionalMemoryAdapter(null);
    await expect(commitPublication(adapter, changed.publication)).resolves.toEqual({
      kind: 'committed',
    });
    expect(adapter.ref).toBe(changed.version.id);
    expect(adapter.records.size).toBe(changed.publication.recordWrites.length);
    expect(
      changed.publication.recordWrites.every((write) =>
        adapter.records.has(`${write.kind}:${write.id}`)
      )
    ).toBe(true);
  });

  it('rolls back every metadata write when the ref compare-and-set fails', async () => {
    const changed = changedResult();
    const actual = changed.version.id;
    const adapter = new TransactionalMemoryAdapter(actual);
    await expect(commitPublication(adapter, changed.publication)).resolves.toEqual({
      kind: 'ref-mismatch',
      actual,
    });
    expect(adapter.ref).toBe(actual);
    expect(adapter.records.size).toBe(0);
  });

  it('refuses a structurally similar plan that lacks package provenance', async () => {
    const plan = changedResult().publication;
    const forged = { recordWrites: plan.recordWrites, refAdvance: plan.refAdvance };
    const adapter = new TransactionalMemoryAdapter(null);
    await expect(Reflect.apply(commitPublication, undefined, [adapter, forged])).rejects.toThrow(
      TypeError
    );
    expect(adapter.records.size).toBe(0);
  });
});

class TransactionalMemoryAdapter implements AtomicPublicationAdapter {
  records = new Map<string, string>();
  ref: WorkspaceVersionId | null;

  constructor(ref: WorkspaceVersionId | null) {
    this.ref = ref;
  }

  async commitAtomically(plan: PublicationPlan): Promise<PublicationCommitResult> {
    if (this.ref !== plan.refAdvance.expected) {
      return Object.freeze({ kind: 'ref-mismatch', actual: this.ref });
    }
    const records = new Map(this.records);
    for (const write of plan.recordWrites) {
      const key = `${write.kind}:${write.id}`;
      const prior = records.get(key);
      if (prior !== undefined && prior !== write.canonicalJson) {
        throw new Error(`Immutable metadata mismatch for ${key}.`);
      }
      records.set(key, write.canonicalJson);
    }
    this.records = records;
    this.ref = plan.refAdvance.next;
    return Object.freeze({ kind: 'committed' });
  }
}

function changedResult() {
  const graph = createRevisionGraph({
    workspaceId: must(parseWorkspaceId('publication-workspace')),
    acceptedRef: MAIN_REF,
  });
  const state = must(
    defineResourceState({
      layout: 'file',
      resourceKind: 'text.note',
      mediaType: 'text/plain',
      blob: defineBlob(new TextEncoder().encode('atomic')),
    })
  );
  const result = applyWorkspaceMutation({
    graph,
    refName: MAIN_REF,
    expectedHead: null,
    operationId: must(parseOperationId('publication-create')),
    mutation: {
      kind: 'create-resource',
      resourceId: must(parseResourceId('publication-resource')),
      path: must(parseWorkspacePath('publication.txt')),
      state,
      origin: { kind: 'created' },
    },
  });
  if (result.kind !== 'changed') throw new Error('Expected a changed publication fixture.');
  return result;
}

function must<Value, ErrorValue>(result: Result<Value, ErrorValue>): Value {
  if (!result.ok) throw new Error(`Expected success, received ${JSON.stringify(result.error)}`);
  return result.value;
}

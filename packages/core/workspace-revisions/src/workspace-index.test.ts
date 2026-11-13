import { describe, expect, it } from 'vitest';

import {
  defineBlob,
  defineResourceState,
  parseMemberId,
  parseResourceId,
  parseResourcePath,
  parseWorkspacePath,
} from './index';
import type { ResourceRevisionId } from './identity';
import { brandValidated } from './identity';
import { getResourceStateRecord } from './resource-state';
import {
  emptyWorkspaceIndexes,
  inspectWorkspaceResourceInIndexes,
  listWorkspaceResourcesInIndexes,
  updateWorkspaceResourceIndexes,
  workspaceMaterializedPathRoot,
  workspaceResourceRoot,
} from './workspace-index';

const REVISION = brandValidated<`rr_${string}`, 'ResourceRevisionId'>(
  `rr_${'1'.repeat(64)}`
) as ResourceRevisionId;
const NEXT_REVISION = brandValidated<`rr_${string}`, 'ResourceRevisionId'>(
  `rr_${'2'.repeat(64)}`
) as ResourceRevisionId;

describe('workspace Merkle indexes', () => {
  it('updates one resource and derives stable canonical roots', () => {
    const resourceId = must(parseResourceId('resource-a'));
    const path = must(parseWorkspacePath('designs/a.gb'));
    const state = fileState();
    const slot = Object.freeze({
      resourceId,
      revisionId: REVISION,
      path,
      lastPath: path,
      tombstone: false,
    });
    const updated = updateWorkspaceResourceIndexes({
      indexes: emptyWorkspaceIndexes(),
      resourceId,
      nextSlot: slot,
      previousState: null,
      nextState: state,
    });

    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(inspectWorkspaceResourceInIndexes(updated.value.indexes, resourceId)).toEqual(slot);
    expect(listWorkspaceResourcesInIndexes(updated.value.indexes)).toEqual([slot]);
    expect(workspaceResourceRoot(updated.value.indexes)).toMatch(/^wrn_[0-9a-f]{64}$/u);
    expect(workspaceMaterializedPathRoot(updated.value.indexes)).toMatch(/^wpn_[0-9a-f]{64}$/u);
    expect(updated.value.writes.length).toBeGreaterThan(0);
  });

  it('detects exact, file-ancestor, and file-descendant collisions incrementally', () => {
    const first = addFile(emptyWorkspaceIndexes(), 'resource-a', 'shared/result.txt');

    expect(addFileResult(first, 'resource-b', 'SHARED/result.txt')).toMatchObject({
      ok: false,
      error: { kind: 'path-conflict' },
    });
    expect(addFileResult(first, 'resource-b', 'shared/result.txt/child')).toMatchObject({
      ok: false,
      error: { kind: 'path-conflict' },
    });

    const childFirst = addFile(emptyWorkspaceIndexes(), 'resource-a', 'shared/child.txt');
    expect(addFileResult(childFirst, 'resource-b', 'shared')).toMatchObject({
      ok: false,
      error: { kind: 'path-conflict' },
    });
  });

  it('returns a typed joined-path overflow instead of throwing', () => {
    const root = must(
      parseWorkspacePath(
        `${'a'.repeat(200)}/${'b'.repeat(200)}/${'c'.repeat(200)}/${'d'.repeat(200)}`
      )
    );
    const relativePath = must(parseResourcePath('e'.repeat(250)));
    const memberId = must(parseMemberId('member-a'));
    const stateResult = defineResourceState({
      layout: 'directory',
      resourceKind: 'sequence-package',
      format: 'forge',
      members: [
        {
          memberId,
          relativePath,
          mediaType: 'application/octet-stream',
          blob: defineBlob(new Uint8Array([1])),
        },
      ],
    });
    expect(stateResult.ok).toBe(true);
    if (!stateResult.ok) return;
    const state = getResourceStateRecord(stateResult.value);
    expect(state).toBeDefined();
    if (!state) return;
    const resourceId = must(parseResourceId('resource-a'));
    const result = updateWorkspaceResourceIndexes({
      indexes: emptyWorkspaceIndexes(),
      resourceId,
      nextSlot: {
        resourceId,
        revisionId: REVISION,
        path: root,
        lastPath: root,
        tombstone: false,
      },
      previousState: null,
      nextState: state,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'invalid-materialized-path', error: { kind: 'path-too-long' } },
    });
  });

  it('edits one resource in a 10,000-resource workspace with bounded structural work', () => {
    const state = fileState();
    let indexes = emptyWorkspaceIndexes();
    for (let index = 0; index < 10_000; index += 1) {
      const resourceId = must(parseResourceId(scaleResourceId(index)));
      const path = must(parseWorkspacePath(`resources/${scaleResourceId(index)}.txt`));
      const seeded = updateWorkspaceResourceIndexes({
        indexes,
        resourceId,
        nextSlot: {
          resourceId,
          revisionId: REVISION,
          path,
          lastPath: path,
          tombstone: false,
        },
        previousState: null,
        nextState: state,
      });
      if (!seeded.ok) throw new Error(`Scale fixture failed: ${seeded.error.kind}`);
      indexes = seeded.value.indexes;
    }

    const resourceId = must(parseResourceId(scaleResourceId(5_000)));
    const path = must(parseWorkspacePath(`resources/${scaleResourceId(5_000)}.txt`));
    const edited = updateWorkspaceResourceIndexes({
      indexes,
      resourceId,
      nextSlot: {
        resourceId,
        revisionId: NEXT_REVISION,
        path,
        lastPath: path,
        tombstone: false,
      },
      previousState: state,
      nextState: state,
    });
    if (!edited.ok) throw new Error(`Scale edit failed: ${edited.error.kind}`);

    expect(edited.value.indexes.resources.size).toBe(10_000);
    expect(inspectWorkspaceResourceInIndexes(edited.value.indexes, resourceId)?.revisionId).toBe(
      NEXT_REVISION
    );
    expect(edited.value.metrics.nodeReads).toBeLessThanOrEqual(128);
    expect(edited.value.metrics.nodeWrites).toBeLessThanOrEqual(64);
    expect(edited.value.metrics.canonicalWriteBytes).toBeLessThanOrEqual(128 * 1_024);
  }, 60_000);
});

function scaleResourceId(index: number): string {
  return `resource-${index.toString().padStart(5, '0')}`;
}

function addFile(
  indexes: ReturnType<typeof emptyWorkspaceIndexes>,
  id: string,
  rawPath: string
): ReturnType<typeof emptyWorkspaceIndexes> {
  const result = addFileResult(indexes, id, rawPath);
  if (!result.ok) throw new Error(`Test setup failed: ${result.error.kind}`);
  return result.value.indexes;
}

function addFileResult(
  indexes: ReturnType<typeof emptyWorkspaceIndexes>,
  id: string,
  rawPath: string
): ReturnType<typeof updateWorkspaceResourceIndexes> {
  const resourceId = must(parseResourceId(id));
  const path = must(parseWorkspacePath(rawPath));
  return updateWorkspaceResourceIndexes({
    indexes,
    resourceId,
    nextSlot: {
      resourceId,
      revisionId: REVISION,
      path,
      lastPath: path,
      tombstone: false,
    },
    previousState: null,
    nextState: fileState(),
  });
}

function fileState() {
  const result = defineResourceState({
    layout: 'file',
    resourceKind: 'sequence',
    mediaType: 'application/genbank',
    blob: defineBlob(new Uint8Array([1, 2, 3])),
  });
  if (!result.ok) throw new Error(`Test state failed: ${result.error.kind}`);
  const state = getResourceStateRecord(result.value);
  if (!state) throw new Error('Test ResourceState has no internal record.');
  return state;
}

function must<Value, ErrorValue>(
  result: { ok: true; value: Value } | { ok: false; error: ErrorValue }
): Value {
  if (!result.ok) throw new Error('Test input failed validation.');
  return result.value;
}

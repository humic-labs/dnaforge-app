import type { RevisionGraphData } from './graph';
import type { ResourceStateHash } from './identity';
import type { WorkspaceMutation } from './types';
import type { ApplyMutationInput } from './mutation-types';
import { defineCanonicalRequest as defineRequest, type CanonicalRequest } from './receipt';
import { getResourceStateRecord } from './resource-state';

export function mutationState(mutation: WorkspaceMutation): import('./types').ResourceState | null {
  switch (mutation.kind) {
    case 'create-resource':
    case 'edit-resource':
    case 'edit-and-move-resource':
    case 'restore-and-edit-resource':
      return mutation.state;
    case 'move-resource':
    case 'revert-resource':
    case 'remove-membership':
    case 'delete-resource':
    case 'restore-resource':
      return null;
  }
}

export function defineMutationRequest(
  input: ApplyMutationInput,
  data: RevisionGraphData
): CanonicalRequest {
  const body = Object.freeze({
    formatVersion: 1,
    workspaceId: data.workspaceId,
    refName: input.refName,
    expectedHead: input.expectedHead,
    mutation: canonicalMutation(input.mutation),
  });
  return defineRequest(body);
}

export function canonicalMutation(mutation: WorkspaceMutation): Readonly<object> {
  switch (mutation.kind) {
    case 'create-resource':
      return {
        kind: mutation.kind,
        resourceId: mutation.resourceId,
        path: mutation.path,
        stateHash: requireStateHash(mutation.state),
        origin: canonicalOrigin(mutation.origin),
      };
    case 'edit-resource':
      return {
        kind: mutation.kind,
        resourceId: mutation.resourceId,
        expectedRevision: mutation.expectedRevision,
        stateHash: requireStateHash(mutation.state),
      };
    case 'revert-resource':
      return {
        kind: mutation.kind,
        resourceId: mutation.resourceId,
        expectedRevision: mutation.expectedRevision,
        restoreFromRevision: mutation.restoreFromRevision,
      };
    case 'move-resource':
      return {
        kind: mutation.kind,
        resourceId: mutation.resourceId,
        expectedPath: mutation.expectedPath,
        destination: mutation.destination,
      };
    case 'edit-and-move-resource':
      return {
        kind: mutation.kind,
        resourceId: mutation.resourceId,
        expectedRevision: mutation.expectedRevision,
        expectedPath: mutation.expectedPath,
        stateHash: requireStateHash(mutation.state),
        destination: mutation.destination,
      };
    case 'remove-membership':
    case 'delete-resource':
      return {
        kind: mutation.kind,
        resourceId: mutation.resourceId,
        expectedRevision: mutation.expectedRevision,
        expectedPath: mutation.expectedPath,
      };
    case 'restore-resource':
      return {
        kind: mutation.kind,
        resourceId: mutation.resourceId,
        expectedTombstoneRevision: mutation.expectedTombstoneRevision,
        restoreFromRevision: mutation.restoreFromRevision,
        destination: mutation.destination,
      };
    case 'restore-and-edit-resource':
      return {
        kind: mutation.kind,
        resourceId: mutation.resourceId,
        expectedTombstoneRevision: mutation.expectedTombstoneRevision,
        restoreFromRevision: mutation.restoreFromRevision,
        destination: mutation.destination,
        stateHash: requireStateHash(mutation.state),
      };
  }
}

function canonicalOrigin(origin: import('./types').ResourceOrigin): Readonly<object> {
  if (origin.kind === 'created') return { kind: origin.kind };
  return {
    kind: origin.kind,
    relation: origin.relation,
    sources: [...origin.sources].sort(deterministicCompare),
  };
}

function deterministicCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireStateHash(state: import('./types').ResourceState): ResourceStateHash {
  const record = getResourceStateRecord(state);
  if (!record) throw new TypeError('ResourceState was not created by this package.');
  return record.hash;
}

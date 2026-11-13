import { requireGraphData } from './graph';
import { deepFreeze } from './immutable';
import type { ApplyMutationResult } from './types';
import {
  applyCreate,
  applyDelete,
  applyEdit,
  applyEditAndMove,
  applyMove,
  applyRemoveMembership,
  applyRestore,
  applyRevert,
} from './mutation-handlers';
import { conflictMutation, rejectMutation } from './mutation-outcome';
import { defineMutationRequest, mutationState } from './mutation-request';
import type { ApplyMutationInput } from './mutation-types';
import { MAX_DERIVED_ORIGIN_SOURCES } from './records';
import { getResourceStateRecord } from './resource-state';
import { isValidCanonicalText } from './unicode';

export type { ApplyMutationInput } from './mutation-types';

export function applyWorkspaceMutation(input: ApplyMutationInput): ApplyMutationResult {
  return deepFreeze(reduceWorkspaceMutation(input));
}

function reduceWorkspaceMutation(input: ApplyMutationInput): ApplyMutationResult {
  const data = requireGraphData(input.graph);
  if (!isValidCanonicalText(input.refName)) {
    return {
      kind: 'rejected',
      graph: input.graph,
      error: { kind: 'invalid-mutation', reason: 'invalid ref name' },
      recordWrites: [],
    };
  }
  const state = mutationState(input.mutation);
  if (state && !getResourceStateRecord(state)) {
    return {
      kind: 'rejected',
      graph: input.graph,
      error: { kind: 'invalid-mutation', reason: 'unrecognized resource state' },
      recordWrites: [],
    };
  }
  if (
    input.mutation.kind === 'create-resource' &&
    input.mutation.origin.kind === 'derived' &&
    input.mutation.origin.sources.length > MAX_DERIVED_ORIGIN_SOURCES
  ) {
    return {
      kind: 'rejected',
      graph: input.graph,
      error: {
        kind: 'invalid-mutation',
        reason: `derived origin exceeds ${MAX_DERIVED_ORIGIN_SOURCES} sources`,
      },
      recordWrites: [],
    };
  }
  const request = defineMutationRequest(input, data);
  const priorReceipt = data.operationReceipts.get(input.operationId);
  if (priorReceipt) {
    if (priorReceipt.requestCanonicalJson === request.canonicalJson) {
      return { kind: 'replay', graph: input.graph, original: priorReceipt.replay };
    }
    return {
      kind: 'rejected',
      graph: input.graph,
      error: { kind: 'operation-id-reused', operationId: input.operationId },
      recordWrites: [],
    };
  }

  if (!data.refs.has(input.refName)) {
    return rejectMutation(input, data, request, `unknown ref: ${input.refName}`);
  }
  const acceptedHead = data.refs.get(input.refName) ?? null;
  if (acceptedHead !== input.expectedHead) {
    return conflictMutation(input, data, request, {
      kind: 'ref-head-mismatch',
      expected: input.expectedHead,
      actual: acceptedHead,
    });
  }

  switch (input.mutation.kind) {
    case 'create-resource':
      return applyCreate({ ...input, mutation: input.mutation }, data, request, acceptedHead);
    case 'edit-resource':
      return applyEdit({ ...input, mutation: input.mutation }, data, request, acceptedHead);
    case 'move-resource':
      return applyMove({ ...input, mutation: input.mutation }, data, request, acceptedHead);
    case 'revert-resource':
      return applyRevert({ ...input, mutation: input.mutation }, data, request, acceptedHead);
    case 'edit-and-move-resource':
      return applyEditAndMove({ ...input, mutation: input.mutation }, data, request, acceptedHead);
    case 'remove-membership':
      return applyRemoveMembership(
        { ...input, mutation: input.mutation },
        data,
        request,
        acceptedHead
      );
    case 'delete-resource':
      return applyDelete({ ...input, mutation: input.mutation }, data, request, acceptedHead);
    case 'restore-resource':
    case 'restore-and-edit-resource':
      return applyRestore({ ...input, mutation: input.mutation }, data, request, acceptedHead);
  }
}

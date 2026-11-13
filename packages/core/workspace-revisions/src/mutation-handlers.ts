import type { ResourceRevisionRecord, RevisionGraphData } from './graph';
import type { ResourceRevisionId, WorkspacePath, WorkspaceVersionId } from './identity';
import type {
  ApplyMutationResult,
  MutationEffects,
  WorkspaceMutation,
  WorkspaceResourceSlotView,
} from './types';
import {
  acceptVersion,
  activeSlotAt,
  dataWithObjects,
  dataWithRevisionAndOptionalState,
  noOpMutation,
  rejectMutation,
  slotAt,
} from './mutation-outcome';
import type { ApplyMutationInput } from './mutation-types';
import { defineResourceRevision } from './records';
import type { CanonicalRequest } from './receipt';
import { getResourceStateRecord } from './resource-state';

export function applyCreate(
  input: ApplyMutationInput & {
    readonly mutation: Extract<WorkspaceMutation, { readonly kind: 'create-resource' }>;
  },
  data: RevisionGraphData,
  request: CanonicalRequest,
  acceptedHead: WorkspaceVersionId | null
): ApplyMutationResult {
  const state = getResourceStateRecord(input.mutation.state);
  if (!state) return rejectMutation(input, data, request, 'unrecognized resource state');
  if (
    input.mutation.origin.kind === 'derived' &&
    new Set(input.mutation.origin.sources).size !== input.mutation.origin.sources.length
  ) {
    return rejectMutation(input, data, request, 'derived origin contains duplicate sources');
  }
  const existingSlot = slotAt(data, acceptedHead, input.mutation.resourceId);
  if (
    existingSlot ||
    [...data.resourceRevisions.values()].some(
      (revision) => revision.view.resourceId === input.mutation.resourceId
    )
  ) {
    return rejectMutation(input, data, request, 'resource already exists in this workspace');
  }

  const revision = defineResourceRevision({
    resourceId: input.mutation.resourceId,
    stateHash: state.hash,
    parentIds: [],
    origin: input.mutation.origin,
    tombstone: false,
  });
  const nextSlot: WorkspaceResourceSlotView = Object.freeze({
    resourceId: input.mutation.resourceId,
    revisionId: revision.view.id,
    path: input.mutation.path,
    lastPath: input.mutation.path,
    tombstone: false,
  });
  const candidateData = dataWithObjects(data, state, revision);

  const effects: MutationEffects = {
    resourceState: data.resourceStates.has(state.hash) ? 'reused' : 'created',
    resourceRevision: 'created',
    workspaceVersion: 'created',
  };
  return acceptVersion(
    input,
    candidateData,
    request,
    acceptedHead,
    input.mutation.resourceId,
    nextSlot,
    effects,
    {
      state: data.resourceStates.has(state.hash) ? null : state,
      revision,
    }
  );
}

export function applyEdit(
  input: ApplyMutationInput & {
    readonly mutation: Extract<WorkspaceMutation, { readonly kind: 'edit-resource' }>;
  },
  data: RevisionGraphData,
  request: CanonicalRequest,
  acceptedHead: WorkspaceVersionId | null
): ApplyMutationResult {
  const state = getResourceStateRecord(input.mutation.state);
  if (!state) return rejectMutation(input, data, request, 'unrecognized resource state');
  const slot = slotAt(data, acceptedHead, input.mutation.resourceId);
  if (!slot || slot.tombstone) {
    return rejectMutation(input, data, request, 'resource is not an active workspace member');
  }
  if (slot.revisionId !== input.mutation.expectedRevision) {
    return rejectMutation(
      input,
      data,
      request,
      'resource revision does not match expectedRevision'
    );
  }
  const priorRevision = data.resourceRevisions.get(slot.revisionId);
  if (!priorRevision) throw new Error('Workspace version references a missing resource revision.');
  if (priorRevision.view.stateHash === state.hash) {
    return noOpMutation(input, data, request, acceptedHead, 'state-unchanged');
  }

  const revision = defineResourceRevision({
    resourceId: input.mutation.resourceId,
    stateHash: state.hash,
    parentIds: [slot.revisionId],
    origin: null,
    tombstone: false,
  });
  const nextSlot = Object.freeze({ ...slot, revisionId: revision.view.id });
  const candidateData = dataWithObjects(data, state, revision);

  return acceptVersion(
    input,
    candidateData,
    request,
    acceptedHead,
    input.mutation.resourceId,
    nextSlot,
    {
      resourceState: data.resourceStates.has(state.hash) ? 'reused' : 'created',
      resourceRevision: 'created',
      workspaceVersion: 'created',
    },
    { state: data.resourceStates.has(state.hash) ? null : state, revision }
  );
}

export function applyMove(
  input: ApplyMutationInput & {
    readonly mutation: Extract<WorkspaceMutation, { readonly kind: 'move-resource' }>;
  },
  data: RevisionGraphData,
  request: CanonicalRequest,
  acceptedHead: WorkspaceVersionId | null
): ApplyMutationResult {
  const slot = slotAt(data, acceptedHead, input.mutation.resourceId);
  if (!slot || slot.tombstone || slot.path === null) {
    return rejectMutation(input, data, request, 'resource is not an active workspace member');
  }
  if (slot.path !== input.mutation.expectedPath) {
    return rejectMutation(input, data, request, 'resource path does not match expectedPath');
  }
  if (slot.path === input.mutation.destination) {
    return noOpMutation(input, data, request, acceptedHead, 'already-at-destination');
  }

  const nextSlot = Object.freeze({
    ...slot,
    path: input.mutation.destination,
    lastPath: input.mutation.destination,
  });

  return acceptVersion(
    input,
    data,
    request,
    acceptedHead,
    input.mutation.resourceId,
    nextSlot,
    {
      resourceState: 'reused',
      resourceRevision: 'reused',
      workspaceVersion: 'created',
    },
    { state: null, revision: null }
  );
}

export function applyEditAndMove(
  input: ApplyMutationInput & {
    readonly mutation: Extract<WorkspaceMutation, { readonly kind: 'edit-and-move-resource' }>;
  },
  data: RevisionGraphData,
  request: CanonicalRequest,
  acceptedHead: WorkspaceVersionId | null
): ApplyMutationResult {
  const state = getResourceStateRecord(input.mutation.state);
  if (!state) return rejectMutation(input, data, request, 'unrecognized resource state');
  const slot = activeSlotAt(data, acceptedHead, input.mutation.resourceId);
  if (!slot) {
    return rejectMutation(input, data, request, 'resource is not an active workspace member');
  }
  if (slot.revisionId !== input.mutation.expectedRevision) {
    return rejectMutation(
      input,
      data,
      request,
      'resource revision does not match expectedRevision'
    );
  }
  if (slot.path !== input.mutation.expectedPath) {
    return rejectMutation(input, data, request, 'resource path does not match expectedPath');
  }
  const priorRevision = data.resourceRevisions.get(slot.revisionId);
  if (!priorRevision || priorRevision.view.stateHash === null) {
    throw new Error('Active workspace slot references an invalid resource revision.');
  }
  const stateChanged = priorRevision.view.stateHash !== state.hash;
  const pathChanged = slot.path !== input.mutation.destination;
  if (!stateChanged && !pathChanged) {
    return noOpMutation(input, data, request, acceptedHead, 'state-unchanged');
  }

  const revision = stateChanged
    ? defineResourceRevision({
        resourceId: input.mutation.resourceId,
        stateHash: state.hash,
        parentIds: [slot.revisionId],
        origin: null,
        tombstone: false,
      })
    : null;
  const nextSlot = Object.freeze({
    ...slot,
    revisionId: revision?.view.id ?? slot.revisionId,
    path: input.mutation.destination,
    lastPath: input.mutation.destination,
  });
  const candidateData = revision
    ? dataWithRevisionAndOptionalState(
        data,
        revision,
        data.resourceStates.has(state.hash) ? null : state
      )
    : data;
  return acceptVersion(
    input,
    candidateData,
    request,
    acceptedHead,
    input.mutation.resourceId,
    nextSlot,
    {
      resourceState: stateChanged
        ? data.resourceStates.has(state.hash)
          ? 'reused'
          : 'created'
        : 'reused',
      resourceRevision: revision ? 'created' : 'reused',
      workspaceVersion: 'created',
    },
    {
      state: revision && !data.resourceStates.has(state.hash) ? state : null,
      revision,
    }
  );
}

export function applyRemoveMembership(
  input: ApplyMutationInput & {
    readonly mutation: Extract<WorkspaceMutation, { readonly kind: 'remove-membership' }>;
  },
  data: RevisionGraphData,
  request: CanonicalRequest,
  acceptedHead: WorkspaceVersionId | null
): ApplyMutationResult {
  const slot = activeSlotAt(data, acceptedHead, input.mutation.resourceId);
  if (!slot) {
    const known = [...data.resourceRevisions.values()].some(
      (revision) => revision.view.resourceId === input.mutation.resourceId
    );
    return known
      ? noOpMutation(input, data, request, acceptedHead, 'membership-already-absent')
      : rejectMutation(input, data, request, 'resource is unknown');
  }
  const precondition = validateActivePreconditions({
    slot,
    expectedRevision: input.mutation.expectedRevision,
    expectedPath: input.mutation.expectedPath,
  });
  if (precondition) return rejectMutation(input, data, request, precondition);
  return acceptVersion(
    input,
    data,
    request,
    acceptedHead,
    input.mutation.resourceId,
    null,
    {
      resourceState: 'none',
      resourceRevision: 'reused',
      workspaceVersion: 'created',
    },
    { state: null, revision: null }
  );
}

export function applyDelete(
  input: ApplyMutationInput & {
    readonly mutation: Extract<WorkspaceMutation, { readonly kind: 'delete-resource' }>;
  },
  data: RevisionGraphData,
  request: CanonicalRequest,
  acceptedHead: WorkspaceVersionId | null
): ApplyMutationResult {
  const slot = activeSlotAt(data, acceptedHead, input.mutation.resourceId);
  if (!slot) {
    return rejectMutation(input, data, request, 'resource is not an active workspace member');
  }
  const precondition = validateActivePreconditions({
    slot,
    expectedRevision: input.mutation.expectedRevision,
    expectedPath: input.mutation.expectedPath,
  });
  if (precondition) return rejectMutation(input, data, request, precondition);
  const revision = defineResourceRevision({
    resourceId: input.mutation.resourceId,
    stateHash: null,
    parentIds: [slot.revisionId],
    origin: null,
    tombstone: true,
  });
  const nextSlot = Object.freeze({
    ...slot,
    revisionId: revision.view.id,
    path: null,
    lastPath: slot.path,
    tombstone: true,
  });
  const candidateData = dataWithRevisionAndOptionalState(data, revision, null);
  return acceptVersion(
    input,
    candidateData,
    request,
    acceptedHead,
    input.mutation.resourceId,
    nextSlot,
    {
      resourceState: 'none',
      resourceRevision: 'created',
      workspaceVersion: 'created',
    },
    { state: null, revision }
  );
}

export function applyRestore(
  input: ApplyMutationInput & {
    readonly mutation: Extract<
      WorkspaceMutation,
      { readonly kind: 'restore-resource' | 'restore-and-edit-resource' }
    >;
  },
  data: RevisionGraphData,
  request: CanonicalRequest,
  acceptedHead: WorkspaceVersionId | null
): ApplyMutationResult {
  const slot = slotAt(data, acceptedHead, input.mutation.resourceId);
  if (!slot || !slot.tombstone || slot.path !== null) {
    return rejectMutation(input, data, request, 'resource is not tombstoned');
  }
  if (slot.revisionId !== input.mutation.expectedTombstoneRevision) {
    return rejectMutation(
      input,
      data,
      request,
      'tombstone revision does not match expectedTombstoneRevision'
    );
  }
  const source = liveRevisionForResource(
    data,
    input.mutation.restoreFromRevision,
    input.mutation.resourceId
  );
  if (!source) {
    return rejectMutation(input, data, request, 'restore source is not a live revision');
  }
  const state =
    input.mutation.kind === 'restore-and-edit-resource'
      ? getResourceStateRecord(input.mutation.state)
      : null;
  if (input.mutation.kind === 'restore-and-edit-resource' && !state)
    return rejectMutation(input, data, request, 'unrecognized resource state');
  const revision = defineResourceRevision({
    resourceId: input.mutation.resourceId,
    stateHash: state?.hash ?? source.view.stateHash,
    parentIds: [slot.revisionId],
    origin: null,
    tombstone: false,
  });
  const nextSlot = Object.freeze({
    ...slot,
    revisionId: revision.view.id,
    path: input.mutation.destination,
    lastPath: input.mutation.destination,
    tombstone: false,
  });
  const newState = state && !data.resourceStates.has(state.hash) ? state : null;
  const candidateData = dataWithRevisionAndOptionalState(data, revision, newState);
  return acceptVersion(
    input,
    candidateData,
    request,
    acceptedHead,
    input.mutation.resourceId,
    nextSlot,
    {
      resourceState: newState ? 'created' : 'reused',
      resourceRevision: 'created',
      workspaceVersion: 'created',
    },
    { state: newState, revision }
  );
}

export function applyRevert(
  input: ApplyMutationInput & {
    readonly mutation: Extract<WorkspaceMutation, { readonly kind: 'revert-resource' }>;
  },
  data: RevisionGraphData,
  request: CanonicalRequest,
  acceptedHead: WorkspaceVersionId | null
): ApplyMutationResult {
  const slot = activeSlotAt(data, acceptedHead, input.mutation.resourceId);
  if (!slot) {
    return rejectMutation(input, data, request, 'resource is not an active workspace member');
  }
  if (slot.revisionId !== input.mutation.expectedRevision) {
    return rejectMutation(
      input,
      data,
      request,
      'resource revision does not match expectedRevision'
    );
  }
  const source = liveRevisionForResource(
    data,
    input.mutation.restoreFromRevision,
    input.mutation.resourceId
  );
  if (!source) {
    return rejectMutation(input, data, request, 'revert source is not a live revision');
  }
  const revision = defineResourceRevision({
    resourceId: input.mutation.resourceId,
    stateHash: source.view.stateHash,
    parentIds: [slot.revisionId],
    origin: null,
    tombstone: false,
  });
  const nextSlot = Object.freeze({ ...slot, revisionId: revision.view.id });
  const candidateData = dataWithRevisionAndOptionalState(data, revision, null);
  return acceptVersion(
    input,
    candidateData,
    request,
    acceptedHead,
    input.mutation.resourceId,
    nextSlot,
    {
      resourceState: 'reused',
      resourceRevision: 'created',
      workspaceVersion: 'created',
    },
    { state: null, revision }
  );
}

function validateActivePreconditions(input: {
  readonly slot: WorkspaceResourceSlotView;
  readonly expectedRevision: ResourceRevisionId;
  readonly expectedPath: WorkspacePath;
}): string | null {
  if (input.slot.revisionId !== input.expectedRevision) {
    return 'resource revision does not match expectedRevision';
  }
  if (input.slot.path !== input.expectedPath) {
    return 'resource path does not match expectedPath';
  }
  return null;
}

function liveRevisionForResource(
  data: RevisionGraphData,
  revisionId: ResourceRevisionId,
  resourceId: import('./identity').ResourceId
): ResourceRevisionRecord | null {
  const revision = data.resourceRevisions.get(revisionId);
  return revision &&
    revision.view.resourceId === resourceId &&
    !revision.view.tombstone &&
    revision.view.stateHash !== null
    ? revision
    : null;
}

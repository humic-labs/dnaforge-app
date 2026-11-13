import { requireGraphData } from './graph';
import { defineResourceRevision } from './records';
import { getResourceStateRecord } from './resource-state';
import type { ResourceRevisionId } from './identity';
import type { RevisionGraph, WorkspaceMutation } from './types';

export function previewMutationRevision(
  graph: RevisionGraph,
  mutation: Extract<
    WorkspaceMutation,
    {
      readonly kind:
        | 'create-resource'
        | 'edit-resource'
        | 'edit-and-move-resource'
        | 'restore-resource'
        | 'restore-and-edit-resource';
    }
  >
): ResourceRevisionId {
  const data = requireGraphData(graph);
  if (mutation.kind === 'restore-resource' || mutation.kind === 'restore-and-edit-resource') {
    const parent = data.resourceRevisions.get(mutation.expectedTombstoneRevision)?.view;
    const source = data.resourceRevisions.get(mutation.restoreFromRevision)?.view;
    if (
      !parent?.tombstone ||
      parent.resourceId !== mutation.resourceId ||
      !source?.stateHash ||
      source.tombstone ||
      source.resourceId !== mutation.resourceId
    )
      throw new TypeError('Restore preview requires exact owned tombstone and live history.');
    const state =
      mutation.kind === 'restore-and-edit-resource' ? getResourceStateRecord(mutation.state) : null;
    if (mutation.kind === 'restore-and-edit-resource' && !state)
      throw new TypeError('Restore preview requires a recognized resource state.');
    return defineResourceRevision({
      resourceId: mutation.resourceId,
      stateHash: state?.hash ?? source.stateHash,
      parentIds: [parent.id],
      origin: null,
      tombstone: false,
    }).view.id;
  }
  const state = getResourceStateRecord(mutation.state);
  if (!state) throw new TypeError('Revision preview requires a recognized resource state.');
  if (mutation.kind === 'create-resource')
    return defineResourceRevision({
      resourceId: mutation.resourceId,
      stateHash: state.hash,
      parentIds: [],
      origin: mutation.origin,
      tombstone: false,
    }).view.id;
  const parent = data.resourceRevisions.get(mutation.expectedRevision)?.view;
  if (!parent || parent.resourceId !== mutation.resourceId || parent.tombstone)
    throw new TypeError('Revision preview requires an exact live parent owned by the resource.');
  if (parent.stateHash === state.hash) return parent.id;
  return defineResourceRevision({
    resourceId: mutation.resourceId,
    stateHash: state.hash,
    parentIds: [parent.id],
    origin: null,
    tombstone: false,
  }).view.id;
}

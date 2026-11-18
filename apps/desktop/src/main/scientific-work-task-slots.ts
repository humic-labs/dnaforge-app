import {
  defineBlob,
  inspectResourceRevision,
  inspectResourceState,
  listWorkspaceResources,
  type RevisionGraph,
  type WorkspaceVersionId,
} from '@waypoint/workspace-revisions';
import type { ScientificFileEntry } from '@waypoint/scientific-objects';
import type { ScientificWorkspaceSubmission } from '@waypoint/domain-services';

export function scientificWorkTaskSlots(graph: RevisionGraph, head: WorkspaceVersionId | null) {
  if (!head) return [];
  const slots = listWorkspaceResources(graph, head);
  if (!slots.ok) throw new Error('Project work history is unavailable.');
  return slots.value.flatMap((slot) => {
    if (slot.tombstone || !slot.path) return [];
    const revision = inspectResourceRevision(graph, slot.revisionId);
    if (!revision.ok || !revision.value.stateHash)
      throw new Error('Project revision is unavailable.');
    const state = inspectResourceState(graph, revision.value.stateHash);
    if (!state.ok) throw new Error('Project resource state is unavailable.');
    if (state.value.resourceKind !== 'dnaforge.scientific.work-task') return [];
    if (state.value.layout !== 'file') throw new Error('Project task file is unavailable.');
    return [{ resourceId: slot.resourceId, path: slot.path, hash: state.value.blob.hash }];
  });
}

type Entry = { representation?: { format: string; text: string }; document?: unknown };

function isTaskEntry(entry: Entry) {
  return (
    entry.representation?.format === 'work-task-v1' ||
    (entry.document as { kind?: unknown } | undefined)?.kind === 'work-task'
  );
}

export function assertScientificTaskCommandAuthority(
  graph: RevisionGraph,
  head: WorkspaceVersionId | null,
  source: ScientificWorkspaceSubmission['source'],
  entries: readonly ScientificFileEntry[]
) {
  if (source.kind === 'restore-workspace' || source.kind === 'sequence-metadata') return;
  const tasks = scientificWorkTaskSlots(graph, head);
  const deny = () => {
    throw new Error('Use project work commands to change a task.');
  };
  if (source.kind === 'native-artifact') {
    if (isTaskEntry(source.entry) || tasks.some((t) => t.resourceId === source.entry.resourceId))
      deny();
    return;
  }
  const prior = new Map(tasks.map((t) => [t.resourceId, t]));
  for (const entry of entries) {
    const accepted = prior.get(entry.resourceId);
    if (!accepted && !isTaskEntry(entry)) continue;
    if (
      !accepted ||
      entry.representation?.format !== 'work-task-v1' ||
      (source.kind !== 'relocate' && accepted.path !== entry.path) ||
      accepted.hash !== defineBlob(new TextEncoder().encode(entry.representation.text)).hash
    )
      deny();
    prior.delete(entry.resourceId);
  }
  if (prior.size) deny();
}

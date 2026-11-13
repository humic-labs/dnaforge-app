import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { parseResourceId } from '@waypoint/workspace-revisions';
import { parsePrimerArtifact } from '../shared/primers/primer-artifact';
import { ScientificObjectStore, hasAcceptedScientificWorkspace } from './scientific-object-store';

export function readAcceptedPrimerProjectionSourceInDb(
  db: Database.Database,
  workspaceId: number,
  primerId: string
) {
  if (!hasAcceptedScientificWorkspace(db, workspaceId)) return null;
  const store = new ScientificObjectStore(db, workspaceId);
  const catalog = store.catalog();
  const slot = catalog.entries.find((entry) => entry.resourceId === primerId);
  if (!slot) return null;
  if (slot.tombstone || !slot.path)
    throw new Error('The accepted primer no longer has a current file identity.');
  const { head, reader } = store.read();
  if (head !== catalog.head) throw new Error('The accepted primer revision changed.');
  const snapshot = reader.current(slot.resourceId);
  if (snapshot?.representation?.format !== 'primer-v2')
    throw new Error('The accepted primer has no canonical native representation.');
  const text = snapshot.representation.text;
  const artifact = parsePrimerArtifact(text);
  if (artifact.id !== primerId || artifact.file.workspaceRelativePath !== slot.path)
    throw new Error('The accepted primer identity disagrees with its saved native bytes.');
  if (
    createHash('sha256').update(artifact.sequence.bases).digest('hex') !==
    artifact.sequence.contentHash
  )
    throw new Error('The accepted primer sequence hash disagrees with its saved bases.');
  const resolvedBindings = artifact.bindings.flatMap((binding) => {
    const id = parseResourceId(binding.id);
    if (!id.ok) throw new Error('Accepted primer binding identity is invalid.');
    const relation = reader.current(id.value);
    if (relation?.document.kind !== 'primer-binding')
      throw new Error('Accepted primer binding is unavailable.');
    const target = reader.current(relation.document.target.resourceId);
    const pinned = reader.revision(relation.document.target);
    if (!target || target.bindingInputHash !== pinned?.bindingInputHash) return [];
    const sequence = db
      .prepare(
        'SELECT s.id FROM sequences s JOIN indexed_files f ON f.id=s.file_id WHERE s.document_id=? AND f.workspace_id=?'
      )
      .get(target.resourceId, workspaceId) as { id: number } | undefined;
    return sequence ? [{ binding, sequenceId: sequence.id }] : [];
  });
  return {
    artifact,
    resolvedBindings,
    relativePath: slot.path,
    contentHash: `sha256:${createHash('sha256').update(text).digest('hex')}`,
  };
}

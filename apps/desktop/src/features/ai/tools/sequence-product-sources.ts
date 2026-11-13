import { decodeSequenceDocument, type AnnotatedSequence } from '@waypoint/sequence-utils';
import { defineBlob } from '@waypoint/workspace-revisions';
import { platform } from '../../../platform';
import { readScientificNamespace } from '../../../services/read-scientific-namespace';
import { primerDnaSource, type SequenceProductCreation } from '../../../shared/sequence-product';

type SourceRevision = Extract<SequenceProductCreation['parts'][number], { kind: 'source' }>['revision'];


export async function readAcceptedDnaSources(workspaceRoot: string, ids: readonly string[], signal?: AbortSignal) {
  const namespace = await readScientificNamespace(workspaceRoot);
  if (!namespace) throw new Error('Sequence products require an enrolled scientific project.');
  const sources = new Map<string, AnnotatedSequence>();
  const pins = new Map<string, SourceRevision>();
  const kinds = new Map<string, string>();
  for (const id of new Set(ids)) {
    signal?.throwIfAborted();
    const entry = namespace.entries.find(candidate => candidate.resourceId === id && !candidate.tombstone);
    if (!entry) throw Object.assign(new Error(`Source ${id} is not accepted in this project. Import the original sequence with import_sequence and use its returned documentId, or choose an accepted DNA sequence or primer from list_scientific_objects.`), { code: 'SEQUENCE_SOURCE_NOT_ACCEPTED' });
    const snapshot = await platform().scientificObjects.read({ workspaceRoot, request: { workspace: namespace.workspace, resourceId: id, revisionId: entry.revisionId } });
    if (!snapshot?.representation || snapshot.revisionId !== entry.revisionId) throw new Error(`The exact accepted source revision is unavailable: ${id}`);
    const { document, representation } = snapshot;
    let source: AnnotatedSequence;
    if (document.kind === 'sequence' && representation.format === 'genbank-v1') source = decodeSequenceDocument(representation.text).sequence;
    else if (document.kind === 'primer' && document.molecule === 'DNA' && representation.format === 'primer-v2') source = primerDnaSource(id, document.name, document.bases);
    else throw new Error(`Source ${id} is not an accepted DNA sequence or DNA primer.`);
    sources.set(id, source);
    kinds.set(id, document.kind);
    pins.set(id, { resourceRevisionId: entry.revisionId, workspaceVersionId: namespace.head, contentSha256: defineBlob(new TextEncoder().encode(representation.text)).hash.slice('sha256:'.length) });
  }
  return { sources, pins, kinds };
}

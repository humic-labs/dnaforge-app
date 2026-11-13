import { decodeSequenceDocument, type AnnotatedSequence } from '@waypoint/sequence-utils';
import { createScientificReader } from '@waypoint/scientific-objects';
import {
  defineBlob,
  parseResourceId,
  parseWorkspaceVersionId,
  type RevisionGraph,
} from '@waypoint/workspace-revisions';
import {
  composeSequenceProduct,
  primerDnaSource,
  sequenceProductCreationSchema,
} from '../shared/sequence-product';
import type { ScientificObjectStore } from './scientific-object-store';
import { scientificNativeCodecs } from './scientific-native-codecs';
import { parseNativeJson } from './scientific-native-json';

export function validateScientificSequenceProductCreation(input: {
  store: Pick<ScientificObjectStore, 'readBlob'>;
  graph: RevisionGraph;
  productText: string;
  sequencePackageText: string;
}): void {
  const metadata = parseNativeJson(input.sequencePackageText);
  if (!Object.hasOwn(metadata, 'creationDerivation')) return;
  const creation = sequenceProductCreationSchema.parse(metadata.creationDerivation);
  const sources = new Map<string, AnnotatedSequence>();
  const observed = new Map<string, string>();
  for (const part of creation.parts) {
    if (part.kind !== 'source') continue;
    const pin = JSON.stringify(part.revision);
    if (observed.has(part.documentId)) {
      if (observed.get(part.documentId) !== pin)
        throw new Error('A sequence source has conflicting creation revision pins.');
      continue;
    }
    const head = parseWorkspaceVersionId(part.revision.workspaceVersionId),
      id = parseResourceId(part.documentId);
    if (!head.ok || !id.ok) throw new Error('Sequence creation source identity is invalid.');
    const source = createScientificReader({
      graph: input.graph,
      head: head.value,
      readBlob: (blob) => input.store.readBlob(blob),
      codecs: scientificNativeCodecs,
    }).current(id.value);
    if (
      source?.revisionId !== part.revision.resourceRevisionId ||
      !source.representation ||
      defineBlob(new TextEncoder().encode(source.representation.text)).hash.slice(
        'sha256:'.length
      ) !== part.revision.contentSha256
    )
      throw new Error(
        `Sequence creation requires its exact accepted source revision: ${part.documentId}`
      );
    if (source.document.kind === 'sequence' && source.representation.format === 'genbank-v1') {
      sources.set(part.documentId, decodeSequenceDocument(source.representation.text).sequence);
    } else if (
      source.document.kind === 'primer' &&
      source.document.molecule === 'DNA' &&
      source.representation.format === 'primer-v2'
    ) {
      sources.set(
        part.documentId,
        primerDnaSource(part.documentId, source.document.name, source.document.bases)
      );
    } else
      throw new Error('Sequence products require an accepted DNA sequence or DNA primer source.');
    observed.set(part.documentId, pin);
  }
  const supplied = decodeSequenceDocument(input.productText).sequence;
  const reproduced = composeSequenceProduct(
    supplied.name,
    creation.circular,
    creation.parts,
    sources
  );
  if (
    supplied.sequence.toUpperCase() !== reproduced.sequence ||
    (supplied.circular === true) !== reproduced.circular
  )
    throw new Error('Sequence product DNA or topology does not match its exact creation recipe.');
}

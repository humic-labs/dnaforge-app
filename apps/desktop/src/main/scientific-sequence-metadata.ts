import type Database from 'better-sqlite3';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { canonicalWorkspacePath } from './primer-artifact-files';
import { isDeepStrictEqual } from 'node:util';
import type { ScientificWorkspaceSubmission } from '@waypoint/domain-services';
import { createScientificReader, type ScientificFileEntry } from '@waypoint/scientific-objects';
import { parseGenBankFull, updateGenBankGeneticCodeComment } from '@waypoint/sequence-utils';
import {
  defineBlob,
  defineResourceState,
  listWorkspaceResources,
  parseResourceId,
  parseWorkspacePath,
  type RevisionGraph,
  type WorkspaceVersionId,
  type WorkspacePath,
  type BlobHash,
} from '@waypoint/workspace-revisions';
import {
  parseSequencePackageDocument,
  serializeSequencePackageDocument,
} from '../db/sequence-package';
import { updateGenBankLocusMetadata } from '../shared/genbank-locus-metadata';
import { annotationTargetDocumentRevision } from '../shared/annotation-target-document-revision';
import { annotationInputRevision } from '../shared/annotation-input-revision';
import {
  SEQUENCE_EDIT_TRANSITION_SCHEMA,
  type SequenceEditTransitionEventV1,
} from '../shared/sequence-edit-lineage';
import { appendSequenceEditTransition, findCurrentSequenceEditHead } from './sequence-edit-lineage';
import type { ScientificObjectStore } from './scientific-object-store';
import { scientificNativeCodecs } from './scientific-native-codecs';
import { parseNativeJson } from './scientific-native-json';
import {
  readAcceptedSequencePackage,
  acceptedSequencePackageRevisionPublication,
} from './scientific-sequence-package';

export async function prepareScientificSequenceMetadata(input: {
  db: Database.Database;
  store: ScientificObjectStore;
  graph: RevisionGraph;
  head: WorkspaceVersionId | null;
  operationId: string;
  source: Extract<ScientificWorkspaceSubmission['source'], { kind: 'sequence-metadata' }>;
}) {
  if (!input.head) throw new Error('Sequence metadata requires an accepted project.');
  const id = parseResourceId(input.source.resourceId);
  if (!id.ok) throw new Error('Sequence metadata identity is invalid.');
  const reader = createScientificReader({
    graph: input.graph,
    head: input.head,
    readBlob: (blob) => input.store.readBlob(blob),
    codecs: scientificNativeCodecs,
  });
  const current = reader.current(id.value);
  const slots = listWorkspaceResources(input.graph, input.head);
  if (!slots.ok) throw new Error('The accepted sequence namespace is unavailable.');
  const slot = slots.value.find((entry) => entry.resourceId === id.value && !entry.tombstone);
  if (
    !slot?.path ||
    current?.revisionId !== input.source.expectedRevisionId ||
    current.representation?.format !== 'genbank-v1' ||
    current.document.kind !== 'sequence'
  )
    throw new Error('Sequence metadata does not match its captured accepted revision.');
  const previousPackage = readAcceptedSequencePackage({
    store: input.store,
    graph: input.graph,
    head: input.head,
    sequenceId: id.value,
    productPath: slot.path,
    productText: current.representation.text,
  });
  if (!previousPackage || previousPackage.revisionId !== input.source.expectedPackageRevisionId)
    throw new Error('Sequence package metadata changed. Reopen it before saving.');
  const supplied = parseNativeJson(input.source.metadataText);
  const next = parseSequencePackageDocument(input.source.metadataText);
  const prior = parseSequencePackageDocument(previousPackage.text);
  const previous = parseNativeJson(serializeSequencePackageDocument(prior));
  const permitted = {
    ...previous,
    name: supplied.name,
    updatedAt: supplied.updatedAt,
    entity: { ...(previous.entity as object), fields: next.entity.fields },
    product: {
      ...(previous.product as object),
      ...(Object.hasOwn(next.product, 'topology') ? { topology: next.product.topology } : {}),
    },
  };
  if (next.id !== id.value || !isDeepStrictEqual(supplied, permitted))
    throw new Error('Metadata Save may change the name, fields, topology and update time only.');
  let workingFileHashes: ReadonlyMap<WorkspacePath, BlobHash | null> | undefined;
  if (input.source.expectedWorkingMetadataSha256 !== undefined) {
    if (!/^[0-9a-f]{64}$/u.test(input.source.expectedWorkingMetadataSha256))
      throw new Error('Submitted working metadata digest is invalid.');
    const root = input.store.workspaceRoot();
    const path = await canonicalWorkspacePath({
      workspaceRoot: root,
      path: resolve(root, previousPackage.path),
      artifactNoun: 'sequence metadata',
    });
    const bytes = await readFile(path.candidate);
    const blob = defineBlob(bytes);
    if (blob.hash !== `sha256:${input.source.expectedWorkingMetadataSha256}`)
      throw new Error('Submitted working metadata changed before acceptance.');
    const working = parseNativeJson(
      serializeSequencePackageDocument(
        parseSequencePackageDocument(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      )
    );
    if (!isDeepStrictEqual(working, previous) && !isDeepStrictEqual(working, supplied))
      throw new Error('Submitted working metadata includes other unsubmitted changes.');

    const rawWorking = parseNativeJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const rawPrevious = parseNativeJson(previousPackage.text);
    const rawIntended = {
      ...rawPrevious,
      name: supplied.name,
      updatedAt: supplied.updatedAt,
      entity: { ...(rawPrevious.entity as object), fields: next.entity.fields },
      product: {
        ...(rawPrevious.product as object),
        ...(Object.hasOwn(rawWorking.product as object, 'topology')
          ? { topology: next.product.topology }
          : {}),
      },
    };
    if (!isDeepStrictEqual(rawWorking, rawPrevious) && !isDeepStrictEqual(rawWorking, rawIntended))
      throw new Error('Submitted working metadata contains raw changes outside this Save.');
    workingFileHashes = new Map([[previousPackage.path, blob.hash]]);
  }
  let productText = current.representation.text;
  const locus = typeof next.entity.fields.locus === 'string' ? next.entity.fields.locus.trim() : '';
  if (locus && locus !== prior.entity.fields.locus && locus !== parseGenBankFull(productText).name)
    productText = updateGenBankLocusMetadata(productText, { name: locus });
  if (next.product.topology !== prior.product.topology && next.product.topology)
    productText = updateGenBankLocusMetadata(productText, { topology: next.product.topology });
  if (input.source.geneticCode !== undefined)
    productText = updateGenBankGeneticCodeComment(productText, input.source.geneticCode);
  const publication = await acceptedSequencePackageRevisionPublication({
    package: previousPackage,
    currentProductText: current.representation.text,
    productText,
    next: {
      ...next,
      product: {
        ...next.product,
        genBankChecksum: defineBlob(new TextEncoder().encode(productText)).hash,
      },
    },
    kind: 'metadata-update',
    operationId: input.operationId,
    createdAt: next.updatedAt,
    graph: input.graph,
    head: input.head,
  });
  const mutations = [...publication.mutations];
  const blobs = [...publication.blobs];
  const productChanged = productText !== current.representation.text;
  const entries: ScientificFileEntry[] = productChanged
    ? slots.value.flatMap((entry) => {
        if (!entry.path || entry.tombstone) return [];
        const snapshot = reader.current(entry.resourceId);
        if (!snapshot) return [];
        return [
          {
            resourceId: entry.resourceId,
            path: entry.path,
            ...(entry.resourceId === id.value
              ? { representation: { format: 'genbank-v1', text: productText } }
              : snapshot.representation
                ? { representation: snapshot.representation }
                : { document: snapshot.document }),
          },
        ];
      })
    : [];
  let event: SequenceEditTransitionEventV1 | undefined;
  const eventId = `sequence-metadata-${defineBlob(new TextEncoder().encode(input.operationId)).hash.slice('sha256:'.length)}`;
  if (productText !== current.representation.text) {
    const before = parseGenBankFull(current.representation.text),
      after = parseGenBankFull(productText);
    before.id = after.id = id.value;
    const beforeHash = defineBlob(new TextEncoder().encode(current.representation.text)).hash;
    event = {
      schema: SEQUENCE_EDIT_TRANSITION_SCHEMA,
      parentEventId: findCurrentSequenceEditHead(input.db, id.value, beforeHash)?.id ?? null,
      draftLineageId: eventId,
      beforeFileSha256: beforeHash,
      afterFileSha256: defineBlob(new TextEncoder().encode(productText)).hash,
      beforeTargetDocumentRevision: await annotationTargetDocumentRevision(before),
      afterTargetDocumentRevision: await annotationTargetDocumentRevision(after),
      beforeInputRevision: await annotationInputRevision({
        sequence: before.sequence,
        linear: !before.circular,
      }),
      afterInputRevision: await annotationInputRevision({
        sequence: after.sequence,
        linear: !after.circular,
      }),
      beforeTopology: before.circular ? 'circular' : 'linear',
      afterTopology: after.circular ? 'circular' : 'linear',
      transition: { beforeLength: before.length, afterLength: after.length, operations: [] },
    };
    const history = new TextEncoder().encode(
      `${JSON.stringify({
        formatVersion: 1,
        documentId: id.value,
        baselineWorkspaceVersionId: input.head,
        beforeRevisionId: current.revisionId,
        eventId,
        event,
      })}\n`
    );
    const historyId = parseResourceId(eventId),
      historyPath = parseWorkspacePath(`.dnaforge/history/sequence-edits/${eventId}.json`);
    const historyState = defineResourceState({
      layout: 'file',
      resourceKind: 'dnaforge.sequence-edit-transition.v1',
      mediaType: 'application/json',
      blob: defineBlob(history),
    });
    if (!historyId.ok || !historyPath.ok || !historyState.ok)
      throw new Error('Sequence metadata history is invalid.');

    const publication = [
      ...mutations,
      {
        kind: 'create-resource' as const,
        resourceId: historyId.value,
        path: historyPath.value,
        state: historyState.value,
        origin: { kind: 'created' as const },
      },
    ];
    blobs.push(history);
    return {
      entries,
      mutations: publication,
      blobs,
      workingFileHashes,
      productChanged,
      onAcceptedInsideTx: () => {
        appendSequenceEditTransition({ db: input.db, entityId: id.value, eventId, event: event! });
      },
    };
  }
  return {
    entries,
    mutations,
    blobs,
    workingFileHashes,
    productChanged,
    onAcceptedInsideTx: () => undefined,
  };
}

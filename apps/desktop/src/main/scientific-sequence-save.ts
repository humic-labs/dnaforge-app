import type Database from 'better-sqlite3';
import { relative } from 'node:path';
import {
  deriveSequenceEditTransition,
  ensureManagedGenBankAnnotationIds,
  listManagedGenBankAnnotations,
  serializeSequenceForInPlaceSave,
} from '@waypoint/sequence-utils';
import {
  compileScientificWorkspace,
  createScientificReader,
  type ScientificFileEntry,
  scientificIdentityPath,
} from '@waypoint/scientific-objects';
import {
  defineBlob,
  defineResourceState,
  inspectResourceRevision,
  inspectResourceState,
  listWorkspaceResources,
  parseOperationId,
  parseResourceId,
  parseResourceRevisionId,
  parseWorkspacePath,
  parseWorkspaceVersionId,
  previewMutationRevision,
  type Result,
  type WorkspaceMutation,
  type WorkspacePath,
  type BlobHash,
} from '@waypoint/workspace-revisions';
import {
  SEQUENCE_EDIT_TRANSITION_SCHEMA,
  type SequenceDocumentSaveInput,
  type SequenceDocumentSaveResult,
  type SequenceEditTransitionEventV1,
  type AcceptedSequenceSave,
} from '../shared/sequence-edit-lineage';
import { parseSequenceFileAsDocument } from '../shared/parse-sequence-file';
import { annotationInputRevision } from '../shared/annotation-input-revision';
import { annotationTargetDocumentRevision } from '../shared/annotation-target-document-revision';
import type { NativeAnnotationDocument } from './managed-annotation-document-command';
import { ScientificObjectStore } from './scientific-object-store';
import { scientificNativeCodecs } from './scientific-native-codecs';
import { submitScientificWorkspace } from './scientific-workspace-service';
import {
  appendSequenceEditTransition,
  MAX_SEQUENCE_EDIT_OPERATIONS,
  parseSequenceEditTransition,
} from './sequence-edit-lineage';
import { scientificWorkspaceIdForRoot } from './scientific-workspace-identity';
import { findCurrentSequenceEditHead } from './sequence-edit-lineage';
import { nativeRecord, parseNativeJson } from './scientific-native-json';
import {
  readAcceptedSequencePackage,
  acceptedSequencePackageSavePublication,
} from './scientific-sequence-package';

const must = <T, E>(result: Result<T, E>): T => {
  if (!result.ok)
    throw new TypeError(`Invalid accepted sequence save: ${JSON.stringify(result.error)}`);
  return result.value;
};

export async function saveEnrolledSequenceDocument(input: {
  readonly db: Database.Database;
  readonly document: NativeAnnotationDocument;
  readonly request: SequenceDocumentSaveInput;
  readonly renderer?: { readonly ownerId: number; readonly mutationToken?: string };
  readonly mutationLease?: () => void;
  readonly beforeAccept?: () => void;

  readonly nativeContent?: string;

  readonly packagePublication?: Awaited<
    ReturnType<typeof acceptedSequencePackageSavePublication>
  > & {
    readonly workingFileHashes: ReadonlyMap<WorkspacePath, BlobHash | null>;
  };
}): Promise<SequenceDocumentSaveResult | null> {
  if (input.db.inTransaction)
    throw new Error('Accepted sequence Save cannot enter an open transaction.');
  const request = structuredClone(input.request);
  const workspaceId = scientificWorkspaceIdForRoot(input.db, input.document.workspaceRoot);
  if (workspaceId === null) {
    if (request.accepted) throw new Error('The accepted sequence workspace is unavailable.');
    return null;
  }
  const store = new ScientificObjectStore(input.db, workspaceId);
  const { graph, head: currentHead, reader: currentReader } = store.read();
  const resourceId = must(parseResourceId(request.documentId));
  if (!currentReader.current(resourceId) && !request.accepted) {
    if (
      currentHead &&
      must(listWorkspaceResources(graph, currentHead)).some(
        (slot) => slot.resourceId === resourceId
      )
    )
      throw new Error(
        'The accepted sequence has been deleted. Restore it explicitly before saving.'
      );
    return null;
  }
  const authority = request.accepted;
  if (!authority)
    throw new Error('Reopen the enrolled sequence to capture its accepted revision before saving.');
  const head = must(parseWorkspaceVersionId(authority.expectedHead));
  const expectedRevisionId = must(parseResourceRevisionId(authority.expectedRevisionId));
  const operationId = must(parseOperationId(authority.operationId));
  if (
    authority.createdAt !== undefined &&
    (!Number.isFinite(Date.parse(authority.createdAt)) ||
      new Date(authority.createdAt).toISOString() !== authority.createdAt)
  )
    throw new Error('The accepted sequence Save time is invalid.');
  if (
    authority.parentEventId !== null &&
    (typeof authority.parentEventId !== 'string' || !authority.parentEventId)
  )
    throw new Error('The accepted sequence edit-history parent is invalid.');
  const reader = createScientificReader({
    graph,
    head,
    readBlob: (blob) => store.readBlob(blob),
    codecs: scientificNativeCodecs,
  });
  const baselineHead = authority.baseline
    ? must(parseWorkspaceVersionId(authority.baseline.head))
    : head;
  const baselineRevisionId = authority.baseline
    ? must(parseResourceRevisionId(authority.baseline.revisionId))
    : expectedRevisionId;
  const baseline = createScientificReader({
    graph,
    head: baselineHead,
    readBlob: (blob) => store.readBlob(blob),
    codecs: scientificNativeCodecs,
  }).current(resourceId);
  const replaced = reader.current(resourceId);
  if (
    baseline?.revisionId !== baselineRevisionId ||
    baseline.document.kind !== 'sequence' ||
    baseline.representation?.format !== 'genbank-v1' ||
    replaced?.revisionId !== expectedRevisionId ||
    replaced.representation?.format !== 'genbank-v1'
  )
    throw new Error('The sequence Save requires its exact accepted native baseline.');
  const slots = must(listWorkspaceResources(graph, head));
  const slot = slots.find((slot) => slot.resourceId === resourceId && !slot.tombstone);
  if (
    !slot?.path ||
    slot.path !==
      relative(input.document.workspaceRoot, input.document.sourcePath).replace(/\\/gu, '/')
  )
    throw new Error('The accepted sequence path does not match its current document binding.');
  const before = parseSequenceFileAsDocument(
    baseline.representation.text,
    input.document.sourcePath
  ).sequence;
  const packageMetadata = readAcceptedSequencePackage({
    store,
    graph,
    head,
    sequenceId: resourceId,
    productPath: slot.path,
    productText: replaced.representation.text,
  });
  before.id = request.documentId;
  if (
    request.capture.draftBaseline.sequence !== before.sequence ||
    request.capture.draftBaseline.length !== before.length ||
    request.capture.draftBaseline.circular !== !!before.circular
  )
    throw new Error('The editor baseline does not match its pinned accepted sequence.');
  const transition = deriveSequenceEditTransition({
    baselineSequence: request.capture.draftBaseline.sequence,
    draftSequence: request.capture.draftSequence,
    cleanSequence: request.capture.sequence.sequence,
    insertedRanges: request.capture.insertedRanges,
    deletedRanges: request.capture.deletedRanges,
    substitutedRanges: request.capture.substitutedRanges,
  });
  if (
    transition.operations.length > MAX_SEQUENCE_EDIT_OPERATIONS ||
    transition.beforeLength !== before.length ||
    transition.afterLength !== request.capture.sequence.length
  )
    throw new Error(
      'The accepted sequence edit transition exceeds its bounds or captured lengths.'
    );
  let content =
    input.nativeContent ??
    serializeSequenceForInPlaceSave(request.capture.sequence, input.document.sourcePath);
  if (packageMetadata && input.nativeContent === undefined) {
    let ordinal = 0;
    content = ensureManagedGenBankAnnotationIds(
      content,
      () => {
        const hash = defineBlob(
          new TextEncoder().encode(`${operationId}:annotation:${ordinal++}`)
        ).hash.slice('sha256:'.length);
        const variant = ((Number.parseInt(hash[16], 16) & 3) | 8).toString(16);
        return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
      },
      replaced.representation.text
    );
  }
  const after = parseSequenceFileAsDocument(content, input.document.sourcePath).sequence;
  after.id = request.documentId;
  const managedAnnotationIds = packageMetadata
    ? listManagedGenBankAnnotations(content).map((annotation) => annotation.id)
    : undefined;
  if (
    managedAnnotationIds &&
    (managedAnnotationIds.length !== after.annotations.length ||
      managedAnnotationIds.length !== request.capture.sequence.annotations.length ||
      managedAnnotationIds.some(
        (id, index) => after.annotations[index].qualifiers?.dnaforge_ann_id?.[0] !== id
      ))
  )
    throw new Error('Managed annotation IDs do not match the saved editor features.');
  if (
    after.sequence !== request.capture.sequence.sequence ||
    !!after.circular !== !!request.capture.sequence.circular ||
    after.length !== request.capture.sequence.length
  )
    throw new Error('The serialized accepted sequence does not match the captured document.');
  const beforeBlob = defineBlob(new TextEncoder().encode(baseline.representation.text));
  const afterBlob = defineBlob(new TextEncoder().encode(content));
  if (expectedRevisionId !== baselineRevisionId) {
    const sibling = slots.find(
      (slot) => !slot.tombstone && slot.resourceId === authority.replacementEventId
    );
    if (!sibling)
      throw new Error('The captured replacement is not an accepted sibling of this draft.');
    const siblingRevision = must(inspectResourceRevision(graph, sibling.revisionId));
    if (!siblingRevision.stateHash) throw new Error('Accepted sibling history is unavailable.');
    const state = must(inspectResourceState(graph, siblingRevision.stateHash));
    if (state.layout !== 'file' || state.resourceKind !== 'dnaforge.sequence-edit-transition.v1')
      throw new Error('Accepted sibling history has the wrong resource kind.');
    const historyBytes = store.readBlob(state.blob);
    if (!historyBytes) throw new Error('Accepted sibling history bytes are unavailable.');
    const history = parseNativeJson(
      new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(historyBytes))
    );
    const siblingEvent = parseSequenceEditTransition(JSON.stringify(nativeRecord(history.event)));
    const projection = input.db
      .prepare('SELECT payload FROM catalog_entity_events WHERE id = ? AND entity_id = ?')
      .get(authority.replacementEventId, resourceId) as { payload: string } | undefined;
    if (
      history.documentId !== resourceId ||
      history.beforeRevisionId !== baselineRevisionId ||
      history.afterRevisionId !== expectedRevisionId ||
      history.eventId !== authority.replacementEventId ||
      siblingEvent.draftLineageId !== request.capture.draftLineageId ||
      siblingEvent.parentEventId !== authority.parentEventId ||
      siblingEvent.beforeFileSha256 !== beforeBlob.hash ||
      siblingEvent.afterFileSha256 !==
        defineBlob(new TextEncoder().encode(replaced.representation.text)).hash ||
      projection?.payload !== JSON.stringify(history.event)
    )
      throw new Error('The captured replacement does not match its accepted draft sibling.');
  }
  if (authority.parentEventId !== null) {
    const parent = input.db
      .prepare('SELECT payload FROM catalog_entity_events WHERE id = ? AND entity_id = ?')
      .get(authority.parentEventId, request.documentId) as { payload: string } | undefined;
    if (!parent || parseSequenceEditTransition(parent.payload).afterFileSha256 !== beforeBlob.hash)
      throw new Error('The captured edit-history parent does not match its accepted baseline.');
  }
  const event: SequenceEditTransitionEventV1 = {
    schema: SEQUENCE_EDIT_TRANSITION_SCHEMA,
    parentEventId: authority.parentEventId,
    draftLineageId: request.capture.draftLineageId,
    beforeFileSha256: beforeBlob.hash,
    afterFileSha256: afterBlob.hash,
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
    transition,
  };
  const entries: ScientificFileEntry[] = slots.flatMap((slot) => {
    if (!slot.path || slot.tombstone) return [];
    const snapshot = reader.current(slot.resourceId);
    if (!snapshot) return [];
    return [
      {
        resourceId: slot.resourceId,
        path: slot.path,
        ...(slot.resourceId === resourceId
          ? { representation: { format: 'genbank-v1', text: content } }
          : snapshot.representation
            ? { representation: snapshot.representation }
            : { document: snapshot.document }),
      },
    ];
  });
  const plan = compileScientificWorkspace({ graph, head, entries, codecs: scientificNativeCodecs });
  const mutation = plan.mutations.find((mutation) => mutation.resourceId === resourceId);
  if (
    !mutation ||
    (mutation.kind !== 'edit-resource' && mutation.kind !== 'edit-and-move-resource')
  )
    throw new Error('Accepted sequence Save could not prepare its resource edit.');
  const revisionId = previewMutationRevision(graph, mutation);
  const eventId = `sequence-edit-${defineBlob(new TextEncoder().encode(operationId)).hash.slice('sha256:'.length)}`;

  const historyBytes = new TextEncoder().encode(
    JSON.stringify({
      formatVersion: 1,
      documentId: resourceId,
      baselineWorkspaceVersionId: baselineHead,
      replacedWorkspaceVersionId: head,
      beforeRevisionId: baselineRevisionId,
      replacedRevisionId: expectedRevisionId,
      afterRevisionId: revisionId,
      eventId,
      event,
    }) + '\n'
  );
  const history: WorkspaceMutation = {
    kind: 'create-resource',
    resourceId: must(parseResourceId(eventId)),
    path: must(parseWorkspacePath(`.dnaforge/history/sequence-edits/${eventId}.json`)),
    state: must(
      defineResourceState({
        layout: 'file',
        resourceKind: 'dnaforge.sequence-edit-transition.v1',
        mediaType: 'application/json',
        blob: defineBlob(historyBytes),
      })
    ),
    origin: { kind: 'created' },
  };
  const packagePublication =
    input.packagePublication ??
    (packageMetadata
      ? await acceptedSequencePackageSavePublication({
          package: packageMetadata,
          productText: content,
          bases: after.sequence,
          circular: !!after.circular,
          currentProductText: replaced.representation.text,
          graph,
          head,
          operationId,
          createdAt: authority.createdAt,
        })
      : { mutations: [], blobs: [], snapshotPaths: [] });
  const result = await submitScientificWorkspace({
    db: input.db,
    workspaceId,
    request: { operationId, expectedHead: head, source: { kind: 'documents', entries } },
    ...(input.renderer ? { renderer: input.renderer } : {}),
    ...(input.mutationLease ? { mutationLease: input.mutationLease } : {}),
    publication: {
      mutations: [history, ...packagePublication.mutations],
      blobs: [historyBytes, ...packagePublication.blobs],
      workingFileHashes: input.packagePublication?.workingFileHashes,
      onAcceptedInsideTx: () => {
        input.beforeAccept?.();
        appendSequenceEditTransition({ db: input.db, entityId: resourceId, eventId, event });
      },
    },
  });
  const acceptance = result.acceptance;
  const workspaceVersionId =
    acceptance.kind === 'changed'
      ? acceptance.version.id
      : acceptance.kind === 'replay' && acceptance.original.outcome === 'changed'
        ? acceptance.original.version.id
        : null;
  if (workspaceVersionId === null)
    throw new Error(`Sequence Save was not accepted: ${acceptance.kind}`);
  const accepted: AcceptedSequenceSave = {
    kind: 'accepted-object',
    operationId,
    workspaceVersionId,
    resourceRevisionId: revisionId,
    resourceId,
    contentSha256: afterBlob.hash.slice('sha256:'.length),
    sequenceEditParentEventId: eventId,
  };
  const superseded = store.read().reader.current(resourceId)?.revisionId !== revisionId;
  const publicationPaths = [
    slot.path,
    scientificIdentityPath,
    history.path,
    ...(packageMetadata ? [packageMetadata.path] : []),
    ...packagePublication.snapshotPaths,
  ];
  if (result.delivery?.kind !== 'complete' || superseded)
    return {
      status: 'accepted-pending',
      accepted,
      eventId,
      lineage: 'recorded',
      publicationPaths,
      managedAnnotationIds,
      ...(superseded ? { superseded: true } : {}),
      reason: superseded
        ? 'This Save was accepted, but another sequence revision is now current. Reload the current document.'
        : `This Save was accepted; file delivery remains pending: ${result.delivery?.kind === 'blocked' ? result.delivery.error : 'unavailable'}`,
    };
  return {
    status: 'saved',
    fileSha256: afterBlob.hash,
    accepted,
    eventId,
    lineage: 'recorded',
    publicationPaths,
    managedAnnotationIds,
  };
}

function enrolledNativeSequenceContext(db: Database.Database, document: NativeAnnotationDocument) {
  if (db.inTransaction)
    throw new Error('Native sequence publication cannot borrow an open database transaction.');
  if (
    !db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scientific_revision_refs'")
      .get()
  )
    return null;
  const workspaceId = scientificWorkspaceIdForRoot(db, document.workspaceRoot);
  if (workspaceId === null) return null;
  const store = new ScientificObjectStore(db, workspaceId);
  const { graph, head, reader } = store.read();
  const resourceId = must(parseResourceId(document.documentId));
  const current = reader.current(resourceId);
  if (!current) {
    if (store.catalog().entries.some((entry) => entry.resourceId === resourceId))
      throw new Error('Restore the accepted sequence before applying annotations.');
    return null;
  }
  if (
    !head ||
    current.document.kind !== 'sequence' ||
    current.representation?.format !== 'genbank-v1'
  )
    throw new Error('Native annotation publication requires an accepted GenBank sequence.');
  const slot = must(listWorkspaceResources(graph, head)).find(
    (entry) => entry.resourceId === resourceId && !entry.tombstone
  );
  if (
    !slot?.path ||
    slot.path !== relative(document.workspaceRoot, document.sourcePath).replace(/\\/gu, '/')
  )
    throw new Error('The native sequence path changed before annotation publication.');
  return {
    store,
    graph,
    head,
    resourceId,
    productPath: slot.path,
    productText: current.representation.text,
    revisionId: current.revisionId,
  };
}

export function prepareEnrolledNativeSequenceContent(input: {
  db: Database.Database;
  document: NativeAnnotationDocument;
  content: string;
  operationId: string;
}): string {
  const current = enrolledNativeSequenceContext(input.db, input.document);
  if (!current) return input.content;
  const metadata = readAcceptedSequencePackage({ ...current, sequenceId: current.resourceId });
  if (!metadata) return input.content;
  let ordinal = 0;
  return ensureManagedGenBankAnnotationIds(
    input.content,
    () => {
      const hash = defineBlob(
        new TextEncoder().encode(`${input.operationId}:annotation:${ordinal++}`)
      ).hash.slice('sha256:'.length);
      const variant = ((Number.parseInt(hash[16], 16) & 3) | 8).toString(16);
      return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    },
    current.productText
  );
}

export async function saveEnrolledNativeSequenceEdit(input: {
  db: Database.Database;
  document: NativeAnnotationDocument;
  content: string;
  expectedContentHash: string;
  operationId: string;
  createdAt: string;
  mutationLease: () => void;
  beforeAccept?: () => void;
}): Promise<SequenceDocumentSaveResult | null> {
  const current = enrolledNativeSequenceContext(input.db, input.document);
  if (!current) return null;
  const beforeHash = defineBlob(new TextEncoder().encode(current.productText)).hash;
  if (beforeHash.slice('sha256:'.length) !== input.expectedContentHash)
    throw new Error('The native annotation draft does not match its accepted baseline.');
  const before = parseSequenceFileAsDocument(
    current.productText,
    input.document.sourcePath
  ).sequence;
  const after = parseSequenceFileAsDocument(input.content, input.document.sourcePath).sequence;
  before.id = after.id = input.document.documentId;
  if (before.sequence !== after.sequence || !!before.circular !== !!after.circular)
    throw new Error('Retained annotation Apply cannot change DNA or topology.');
  return saveEnrolledSequenceDocument({
    db: input.db,
    document: input.document,
    nativeContent: input.content,
    mutationLease: input.mutationLease,
    beforeAccept: input.beforeAccept,
    request: {
      documentId: input.document.documentId,
      sourcePath: input.document.sourcePath,
      capture: {
        sequence: after,
        draftBaseline: {
          sequence: before.sequence,
          length: before.length,
          circular: !!before.circular,
        },
        draftSequence: after.sequence,
        insertedRanges: [],
        deletedRanges: [],
        substitutedRanges: [],
        draftLineageId: input.operationId,
      },
      accepted: {
        operationId: input.operationId,
        createdAt: input.createdAt,
        expectedHead: current.head,
        expectedRevisionId: current.revisionId,
        parentEventId:
          findCurrentSequenceEditHead(input.db, current.resourceId, beforeHash)?.id ?? null,
      },
    },
  });
}

import {
  defineBlob,
  inspectResourceRevision,
  inspectResourceState,
  inspectWorkspaceVersion,
  parseWorkspaceVersionId,
  type BlobRef,
  type RevisionGraph,
  type WorkspaceVersionId,
} from '@waypoint/workspace-revisions';
import {
  exportCanonicalClosure,
  importCanonicalRecords,
  type CanonicalGraphBundle,
} from '@waypoint/workspace-revisions/codec';
import { createScientificReaderFamily } from './graph';
import type { ScientificFileCodec } from './files';
import { validateScientificChange } from './references';
import { parseUniqueJson } from './unique-json';
import type { ScientificReader } from './types';

export const SCIENTIFIC_HISTORY_FORMAT = 'dnaforge.scientific-history' as const;
export const SCIENTIFIC_HISTORY_FORMAT_VERSION = 1 as const;

export interface ScientificHistoryV1 {
  readonly format: typeof SCIENTIFIC_HISTORY_FORMAT;
  readonly formatVersion: typeof SCIENTIFIC_HISTORY_FORMAT_VERSION;
  readonly graph: CanonicalGraphBundle;
  readonly blobs: readonly BlobRef[];
  readonly requiredCodecs: readonly string[];
}

export interface ValidatedScientificHistory {
  readonly envelope: ScientificHistoryV1;
  readonly graph: RevisionGraph;
  readonly head: WorkspaceVersionId | null;
}

export interface ScientificHistoryReader {
  readonly readBlob: (blob: BlobRef) => Uint8Array | null;
  readonly codecs?: readonly ScientificFileCodec[];

  readonly validateVersion?: (input: {
    readonly graph: RevisionGraph;
    readonly head: WorkspaceVersionId;
    readonly workspaceId: string;
    readonly acceptedHead: WorkspaceVersionId | null;
    readonly reader: ScientificReader;
  }) => void;
}

export class ScientificHistoryInvalidError extends Error {
  readonly code = 'SCIENTIFIC_HISTORY_INVALID';
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ScientificHistoryInvalidError';
  }
}

export function assertScientificHistoryPredecessorRetained(input: {
  readonly previous: ScientificHistoryV1;
  readonly incoming: ScientificHistoryV1;
}): void {
  const { previous, incoming } = input;
  if (previous.graph.workspaceId !== incoming.graph.workspaceId)
    throw new ScientificHistoryInvalidError(
      'Scientific history predecessor belongs to another logical workspace.'
    );
  const records = new Map(incoming.graph.records.map((record) => [record.id, record]));
  for (const record of previous.graph.records) {
    const retained = records.get(record.id);
    if (
      !retained ||
      retained.kind !== record.kind ||
      retained.canonicalJson !== record.canonicalJson
    )
      throw new ScientificHistoryInvalidError(
        `Scientific history predecessor record was omitted or changed: ${record.id}`
      );
  }
  const blobs = new Map(incoming.blobs.map((blob) => [blob.hash, blob.byteLength]));
  for (const blob of previous.blobs)
    if (blobs.get(blob.hash) !== blob.byteLength)
      throw new ScientificHistoryInvalidError(
        `Scientific history predecessor blob was omitted or changed: ${blob.hash}`
      );
}

export function exportScientificHistory(
  graph: RevisionGraph,
  input: ScientificHistoryReader
): ScientificHistoryV1 {
  const bundle = exportCanonicalClosure(graph);
  const closure = historyDependencies(graph, bundle);
  const envelope: ScientificHistoryV1 = Object.freeze({
    format: SCIENTIFIC_HISTORY_FORMAT,
    formatVersion: SCIENTIFIC_HISTORY_FORMAT_VERSION,
    graph: bundle,
    blobs: closure.blobs,
    requiredCodecs: closure.requiredCodecs,
  });
  validateScientificHistory(envelope, input);
  return envelope;
}

export function validateScientificHistory(
  value: unknown,
  input: ScientificHistoryReader
): ValidatedScientificHistory {
  try {
    if (
      !exactObject(value, ['format', 'formatVersion', 'graph', 'blobs', 'requiredCodecs']) ||
      value.format !== SCIENTIFIC_HISTORY_FORMAT ||
      value.formatVersion !== SCIENTIFIC_HISTORY_FORMAT_VERSION
    )
      throw new Error('Unsupported scientific history envelope.');
    if (!exactObject(value.graph, ['formatVersion', 'workspaceId', 'records', 'refs']))
      throw new Error('Scientific history graph has unsupported fields.');
    if (!Array.isArray(value.graph.records) || !Array.isArray(value.graph.refs))
      throw new Error('Scientific history graph is malformed.');
    for (const record of value.graph.records)
      if (!exactObject(record, ['kind', 'id', 'canonicalJson']))
        throw new Error('Scientific history record has unsupported fields.');
    for (const ref of value.graph.refs)
      if (!exactObject(ref, ['name', 'head']))
        throw new Error('Scientific history ref has unsupported fields.');
    const imported = importCanonicalRecords(value.graph);
    if (!imported.ok) throw new Error(`Invalid scientific graph: ${imported.error.kind}`);
    const graph = imported.value;
    const bundle = exportCanonicalClosure(graph);
    const accepted = bundle.refs.find((ref) => ref.name === 'accepted');
    if (!accepted) throw new Error('Scientific history is missing its accepted ref.');
    const parsed = accepted.head === null ? null : parseWorkspaceVersionId(accepted.head);
    if (parsed && !parsed.ok) throw new Error('Scientific history accepted head is invalid.');
    const acceptedHead = parsed?.ok ? parsed.value : null;

    if (JSON.stringify(value.graph) !== JSON.stringify(bundle))
      throw new Error('Scientific history graph is not in canonical export order.');
    const closure = historyDependencies(graph, bundle);
    if (
      !Array.isArray(value.blobs) ||
      value.blobs.some((blob) => !exactObject(blob, ['hash', 'byteLength'])) ||
      JSON.stringify(value.blobs) !== JSON.stringify(closure.blobs)
    )
      throw new Error('Scientific history blob inventory differs from its complete closure.');
    if (
      !Array.isArray(value.requiredCodecs) ||
      JSON.stringify(value.requiredCodecs) !== JSON.stringify(closure.requiredCodecs)
    )
      throw new Error('Scientific history codec inventory differs from its complete closure.');
    for (const format of closure.requiredCodecs)
      if ((input.codecs ?? []).filter((codec) => codec.format === format).length !== 1)
        throw new Error(`Scientific history decoder unavailable: ${format}`);
    for (const blob of closure.blobs) {
      const bytes = input.readBlob(blob);
      if (!bytes || bytes.byteLength !== blob.byteLength || defineBlob(bytes).hash !== blob.hash)
        throw new Error(`Scientific history blob unavailable or corrupt: ${blob.hash}`);
    }

    const readers = createScientificReaderFamily({ ...input, graph });
    const detached = readers.at(null);
    for (const record of bundle.records) {
      if (record.kind !== 'resource-revision') continue;
      const revision = inspectResourceRevision(
        graph,
        record.id as Parameters<typeof inspectResourceRevision>[1]
      );
      if (!revision.ok) throw new Error('Scientific history revision is missing.');
      if (!revision.value.tombstone && revision.value.stateHash)
        detached.revision({
          resourceId: revision.value.resourceId,
          revisionId: revision.value.id,
        });
    }
    const readerAt = readers.at;
    for (const record of bundle.records) {
      if (record.kind !== 'workspace-version') continue;
      const id = parseWorkspaceVersionId(record.id);
      if (!id.ok) throw new Error('Scientific history workspace version is invalid.');
      const version = inspectWorkspaceVersion(graph, id.value);
      if (!version.ok) throw new Error('Scientific history workspace version is missing.');
      const after = readerAt(id.value);
      const current = after.listCurrent();
      for (const parent of version.value.parentIds.length ? version.value.parentIds : [null]) {
        const before = readerAt(parent);
        const changed = new Set(
          [...before.listCurrent(), ...current].map((entry) => entry.resourceId)
        );
        const issues = validateScientificChange({
          before,
          after,
          changedResourceIds: [...changed],
        });
        if (issues.length)
          throw new Error(`Scientific history references are invalid: ${issues[0]?.code}`);
      }
      for (const snapshot of current) {
        const codec = input.codecs?.find(
          (entry) => entry.format === snapshot.representation?.format
        );
        const issues = codec?.validateReferences?.({ snapshot, reader: after });
        if (issues?.length)
          throw new Error(`Scientific history native references are invalid: ${issues[0]?.code}`);
      }
      input.validateVersion?.({
        graph,
        head: id.value,
        workspaceId: bundle.workspaceId,
        acceptedHead,
        reader: after,
      });
    }
    return Object.freeze({
      envelope: Object.freeze({
        format: SCIENTIFIC_HISTORY_FORMAT,
        formatVersion: SCIENTIFIC_HISTORY_FORMAT_VERSION,
        graph: bundle,
        blobs: closure.blobs,
        requiredCodecs: closure.requiredCodecs,
      }),
      graph,
      head: acceptedHead,
    });
  } catch (cause) {
    if (cause instanceof ScientificHistoryInvalidError) throw cause;
    throw new ScientificHistoryInvalidError(
      cause instanceof Error ? cause.message : 'Invalid scientific history.',
      { cause }
    );
  }
}

export function serializeScientificHistory(envelope: ScientificHistoryV1): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(envelope));
}

export function decodeScientificHistory(
  bytes: Uint8Array,
  expected: BlobRef,
  input: ScientificHistoryReader
): ValidatedScientificHistory {
  if (bytes.byteLength !== expected.byteLength || defineBlob(bytes).hash !== expected.hash)
    throw new ScientificHistoryInvalidError(
      'Scientific history envelope digest or length differs.'
    );
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const result = validateScientificHistory(parseUniqueJson(text, { maxDepth: 16 }), input);
  if (text !== JSON.stringify(result.envelope))
    throw new ScientificHistoryInvalidError('Scientific history envelope is not canonical.');
  return result;
}

function historyDependencies(graph: RevisionGraph, bundle: CanonicalGraphBundle) {
  const blobs = new Map<string, BlobRef>();
  const codecs = new Set<string>();
  for (const record of bundle.records) {
    if (record.kind !== 'resource-state') continue;
    const state = inspectResourceState(
      graph,
      record.id as Parameters<typeof inspectResourceState>[1]
    );
    if (!state.ok) throw new Error('Scientific history resource state is missing.');
    const refs =
      state.value.layout === 'file'
        ? [state.value.blob]
        : state.value.members.map((member) => member.blob);
    for (const blob of refs) {
      const previous = blobs.get(blob.hash);
      if (previous && previous.byteLength !== blob.byteLength)
        throw new Error('Scientific history has inconsistent blob lengths.');
      blobs.set(blob.hash, Object.freeze({ hash: blob.hash, byteLength: blob.byteLength }));
    }
    const format = state.value.materialMetadata?.representation;
    if (state.value.resourceKind.startsWith('dnaforge.scientific.') && format !== undefined) {
      if (typeof format !== 'string')
        throw new Error('Scientific history representation is invalid.');
      codecs.add(format);
    }
  }
  return {
    blobs: Object.freeze(
      [...blobs.values()].sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0))
    ),
    requiredCodecs: Object.freeze([...codecs].sort()),
  };
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return (
    Object.getOwnPropertySymbols(value).length === 0 &&
    Object.keys(descriptors).length === keys.length &&
    keys.every((key) => descriptors[key]?.enumerable && 'value' in descriptors[key])
  );
}

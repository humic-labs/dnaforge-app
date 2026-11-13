import {
  applyWorkspaceBatch,
  defineBlob,
  inspectResourceRevision,
  inspectResourceState,
  inspectWorkspaceResource,
  listWorkspaceResources,
  type ApplyBatchInput,
  type ApplyMutationResult,
  type BlobRef,
  type ResourceId,
  type RevisionGraph,
  type WorkspaceVersionId,
} from '@waypoint/workspace-revisions';
import { defineScientificDocument } from './documents';
import { defineScientificFile, type ScientificFileCodec } from './files';
import { parseUniqueJson } from './unique-json';
import { canonicalPayload } from './json';
import { validateScientificChange } from './references';
import type { RevisionPin, ScientificReader, ScientificSnapshot } from './types';

export interface ScientificGraphInput {
  readonly graph: RevisionGraph;
  readonly head: WorkspaceVersionId | null;
  readonly readBlob: (blob: BlobRef) => Uint8Array | null;
  readonly codecs?: readonly ScientificFileCodec[];
}

export class ScientificDocumentInvalidError extends Error {
  constructor(
    readonly resourceId: ResourceId,
    options?: ErrorOptions
  ) {
    super(`Invalid scientific document: ${resourceId}`, options);
    this.name = 'ScientificDocumentInvalidError';
  }
}

export function createScientificReader(input: ScientificGraphInput): ScientificReader {
  return createScientificReaderFamily(input).at(input.head);
}

export function createScientificReaderFamily(input: Omit<ScientificGraphInput, 'head'>): {
  readonly at: (head: WorkspaceVersionId | null) => ScientificReader;
} {
  const cache = new Map<string, ScientificSnapshot | null>();
  const readers = new Map<WorkspaceVersionId | null, ScientificReader>();
  const revision = (pin: RevisionPin): ScientificSnapshot | null => {
    const cacheKey = `${pin.resourceId}:${pin.revisionId}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey) ?? null;
    const found = inspectResourceRevision(input.graph, pin.revisionId);
    if (
      !found.ok ||
      found.value.resourceId !== pin.resourceId ||
      found.value.tombstone ||
      !found.value.stateHash
    )
      return null;
    const state = inspectResourceState(input.graph, found.value.stateHash);
    if (!state.ok) throw new Error('Accepted scientific resource state is missing.');
    if (!state.value.resourceKind.startsWith('dnaforge.scientific.')) {
      cache.set(cacheKey, null);
      return null;
    }
    if (state.value.layout !== 'file') throw new ScientificDocumentInvalidError(pin.resourceId);
    const bytes = input.readBlob(state.value.blob);
    if (!bytes) throw new Error(`Scientific blob unavailable: ${state.value.blob.hash}`);
    const actual = defineBlob(bytes);
    if (actual.hash !== state.value.blob.hash || actual.byteLength !== state.value.blob.byteLength)
      throw new Error(`Scientific blob integrity failure: ${state.value.blob.hash}`);
    let defined;
    let text = '';
    const format = state.value.materialMetadata?.representation;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (format === undefined) {
        if (state.value.mediaType !== 'application/json')
          throw new TypeError('Invalid scientific JSON media type.');
        defined = defineScientificDocument(parseUniqueJson(text, { maxDepth: 64 }));
      } else {
        if (typeof format !== 'string')
          throw new TypeError('Invalid scientific representation format.');
        defined = defineScientificFile({ representation: { format, text } }, input.codecs);
        if (defined.nativeResourceId !== undefined && defined.nativeResourceId !== pin.resourceId)
          throw new TypeError('Native scientific file identity does not match its revision owner.');
        const codec = input.codecs?.find((entry) => entry.format === format);
        if (state.value.mediaType !== codec?.mediaType)
          throw new TypeError('Invalid scientific representation media type.');
      }
    } catch (cause) {
      throw new ScientificDocumentInvalidError(pin.resourceId, { cause });
    }
    if (
      state.value.resourceKind !== `dnaforge.scientific.${defined.document.kind}` ||
      state.value.materialMetadata?.scientificHash !== defined.scientificHash ||
      state.value.materialMetadata?.bindingInputHash !== defined.bindingInputHash
    )
      throw new ScientificDocumentInvalidError(pin.resourceId);
    const result = Object.freeze({
      resourceId: pin.resourceId,
      revisionId: pin.revisionId,
      document: defined.document,
      scientificHash: defined.scientificHash,
      bindingInputHash: defined.bindingInputHash,
      ...(typeof format === 'string' ? { representation: Object.freeze({ format, text }) } : {}),
    });
    cache.set(cacheKey, result);
    return result;
  };
  return Object.freeze({
    at: (head: WorkspaceVersionId | null) => {
      const existing = readers.get(head);
      if (existing) return existing;
      const current = (resourceId: ResourceId): ScientificSnapshot | null => {
        if (head === null) return null;
        const found = inspectWorkspaceResource(input.graph, head, resourceId);
        return found.ok && !found.value.tombstone ? revision(found.value) : null;
      };
      let currentSnapshots: readonly ScientificSnapshot[] | undefined;
      const reader: ScientificReader = Object.freeze({
        current,
        revision,
        hasRevision: (pin: RevisionPin) => {
          const found = inspectResourceRevision(input.graph, pin.revisionId);
          return (
            found.ok &&
            found.value.resourceId === pin.resourceId &&
            !found.value.tombstone &&
            found.value.stateHash !== null
          );
        },
        listCurrent: () => {
          if (head === null) return [];
          if (currentSnapshots) return currentSnapshots;
          const slots = listWorkspaceResources(input.graph, head);
          if (!slots.ok) throw new Error('Scientific workspace version unavailable.');
          currentSnapshots = Object.freeze(
            slots.value
              .map((slot) => (slot.tombstone ? null : revision(slot)))
              .filter((value): value is ScientificSnapshot => value !== null)
          );
          return currentSnapshots;
        },
      });
      readers.set(head, reader);
      return reader;
    },
  });
}

export interface ApplyScientificBatchInput extends Omit<ApplyBatchInput, 'validation'> {
  readonly readBlob: ScientificGraphInput['readBlob'];
  readonly codecs?: readonly ScientificFileCodec[];
}

export function applyScientificBatch(input: ApplyScientificBatchInput): ApplyMutationResult {
  return applyWorkspaceBatch({
    ...input,
    validation: {
      version: 'scientific-objects-v1',
      validate: ({ graph, head }) => {
        try {
          const before = createScientificReader({
            graph: input.graph,
            head: input.expectedHead,
            readBlob: input.readBlob,
            ...(input.codecs ? { codecs: input.codecs } : {}),
          });
          const after = createScientificReader({
            graph,
            head,
            readBlob: input.readBlob,
            ...(input.codecs ? { codecs: input.codecs } : {}),
          });
          const issues = [
            ...validateScientificChange({
              before,
              after,
              changedResourceIds: input.mutations.map((mutation) => mutation.resourceId),
            }),
          ];
          for (const snapshot of after.listCurrent()) {
            const codec = input.codecs?.find(
              (entry) => entry.format === snapshot.representation?.format
            );
            if (codec?.validateReferences)
              issues.push(...codec.validateReferences({ snapshot, reader: after }));
          }
          return issues.length ? canonicalPayload(issues.slice(0, 20)) : null;
        } catch (error) {
          if (error instanceof ScientificDocumentInvalidError) return error.message;
          throw error;
        }
      },
    },
  });
}

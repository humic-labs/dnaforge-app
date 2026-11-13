import {
  previewMutationRevision,
  parseResourceId,
  parseResourceRevisionId,
  parseWorkspacePath,
  type CanonicalMap,
  type ResourceId,
  type Result,
  type RevisionGraph,
  type WorkspacePath,
  type WorkspaceVersionId,
} from '@waypoint/workspace-revisions';
import { createScientificReader, type ScientificGraphInput } from './graph';
import { defineScientificDocument } from './documents';
import { defineScientificFile, type ScientificFileCodec } from './files';
import { canonicalPayload, freezeJson } from './json';
import { parseUniqueJson } from './unique-json';
import { compileScientificWorkspace, type ScientificFileEntry } from './workspace';
import type { RevisionPin } from './types';

export type ScientificAssemblyInput =
  | { readonly kind: 'submitted'; readonly resourceId: ResourceId }
  | { readonly kind: 'accepted'; readonly pin: RevisionPin };
export interface ScientificAssemblyDraft {
  readonly resourceId: ResourceId;
  readonly path: WorkspacePath;
  readonly constructId: ResourceId;
  readonly parent: RevisionPin | null;
  readonly sources: readonly ScientificAssemblyInput[];
  readonly primers: readonly ScientificAssemblyInput[];
  readonly product: ScientificAssemblyInput;
  readonly recipe: CanonicalMap;
}

const must = <T, E>(value: Result<T, E>): T => {
  if (!value.ok) throw new TypeError(`Invalid scientific assembly: ${JSON.stringify(value.error)}`);
  return value.value;
};

export function defineScientificAssemblyDraft(value: unknown): ScientificAssemblyDraft {
  const row = record(parseUniqueJson(canonicalPayload(value), { maxDepth: 64 }));
  exactKeys(row, [
    'resourceId',
    'path',
    'constructId',
    'parent',
    'sources',
    'primers',
    'product',
    'recipe',
  ]);
  if (typeof row.path !== 'string' || !Array.isArray(row.sources) || !Array.isArray(row.primers))
    throw new TypeError('Scientific assembly requires a portable path and explicit input lists.');
  const inputs = (values: unknown[]): readonly ScientificAssemblyInput[] =>
    Object.freeze(values.map(inputChoice));
  return Object.freeze({
    resourceId: must(parseResourceId(textField(row.resourceId))),
    path: must(parseWorkspacePath(row.path)),
    constructId: must(parseResourceId(textField(row.constructId))),
    parent: row.parent === null ? null : pin(row.parent),
    sources: inputs(row.sources),
    primers: inputs(row.primers),
    product: inputChoice(row.product),
    recipe: freezeJson(record(row.recipe) as CanonicalMap),
  });
}

export function compileScientificAssembly(input: {
  readonly graph: RevisionGraph;
  readonly head: WorkspaceVersionId | null;
  readonly entries: readonly ScientificFileEntry[];
  readonly assembly: unknown;
  readonly readBlob: ScientificGraphInput['readBlob'];
  readonly codecs?: readonly ScientificFileCodec[];
}): ReturnType<typeof compileScientificWorkspace> {
  const assembly = defineScientificAssemblyDraft(input.assembly);
  if (input.entries.some((entry) => entry.resourceId === assembly.resourceId))
    throw new TypeError('New accepted history must have its own resource identity.');
  const proposed = compileScientificWorkspace(input);
  const submitted = new Map(
    input.entries.map((entry) => [
      entry.resourceId,
      defineScientificFile(entry, input.codecs).document,
    ])
  );
  const revisions = new Map<ResourceId, RevisionPin>();
  for (const mutation of proposed.mutations) {
    if (
      submitted.has(mutation.resourceId) &&
      (mutation.kind === 'create-resource' ||
        mutation.kind === 'edit-resource' ||
        mutation.kind === 'edit-and-move-resource')
    )
      revisions.set(mutation.resourceId, {
        resourceId: mutation.resourceId,
        revisionId: previewMutationRevision(input.graph, mutation),
      });
  }
  const reader = createScientificReader({
    graph: input.graph,
    head: input.head,
    readBlob: input.readBlob,
    ...(input.codecs ? { codecs: input.codecs } : {}),
  });
  const resolve = (choice: ScientificAssemblyInput, kind: 'primer' | 'sequence'): RevisionPin => {
    if (choice.kind === 'submitted') {
      const revision = revisions.get(choice.resourceId),
        document = submitted.get(choice.resourceId);
      if (!revision || document?.kind !== kind)
        throw new TypeError(`Missing submitted ${kind}: ${choice.resourceId}`);
      return Object.freeze(revision);
    }
    const snapshot = reader.revision(choice.pin);
    if (!snapshot || snapshot.document.kind !== kind)
      throw new TypeError(`Scientific assembly input must resolve to an exact ${kind} revision.`);
    return Object.freeze({ resourceId: snapshot.resourceId, revisionId: snapshot.revisionId });
  };
  const defined = defineScientificDocument({
    formatVersion: 1,
    kind: 'accepted-assembly',
    constructId: assembly.constructId,
    parent: assembly.parent,
    sources: assembly.sources.map((choice) => resolve(choice, 'sequence')),
    primers: assembly.primers.map((choice) => resolve(choice, 'primer')),
    product: resolve(assembly.product, 'sequence'),
    recipe: assembly.recipe,
  });
  return compileScientificWorkspace({
    ...input,
    entries: [
      ...input.entries,
      { resourceId: assembly.resourceId, path: assembly.path, document: defined.document },
    ],
  });
}

function inputChoice(value: unknown): ScientificAssemblyInput {
  const row = record(value);
  if (row.kind === 'submitted') {
    exactKeys(row, ['kind', 'resourceId']);
    return Object.freeze({
      kind: 'submitted',
      resourceId: must(parseResourceId(textField(row.resourceId))),
    });
  }
  if (row.kind === 'accepted') {
    exactKeys(row, ['kind', 'pin']);
    return Object.freeze({ kind: 'accepted', pin: pin(row.pin) });
  }
  throw new TypeError('Assembly input must select an exact accepted or submitted revision.');
}
function pin(value: unknown): RevisionPin {
  const row = record(value);
  exactKeys(row, ['resourceId', 'revisionId']);
  return Object.freeze({
    resourceId: must(parseResourceId(textField(row.resourceId))),
    revisionId: must(parseResourceRevisionId(textField(row.revisionId))),
  });
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Scientific assembly requires JSON objects.');
  return value as Record<string, unknown>;
}
function textField(value: unknown): string {
  if (typeof value !== 'string')
    throw new TypeError('Scientific assembly identities must be text.');
  return value;
}
function exactKeys(row: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(row).length !== keys.length || keys.some((key) => !Object.hasOwn(row, key)))
    throw new TypeError('Scientific assembly has missing or unknown fields.');
}

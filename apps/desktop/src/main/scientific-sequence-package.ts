import { dirname, basename } from 'node:path';
import type { ScientificWorkspaceSubmission } from '@waypoint/domain-services';
import { parseUniqueJson } from '@waypoint/scientific-objects';
import { computeChecksum } from '@waypoint/sequence-utils';
import {
  defineBlob,
  defineResourceState,
  parseResourceId,
  parseWorkspacePath,
  inspectResourceRevision,
  inspectResourceState,
  listWorkspaceResources,
  type ResourceId,
  type ResourceRevisionId,
  type WorkspacePath,
  type RevisionGraph,
  type WorkspaceVersionId,
  type WorkspaceMutation,
} from '@waypoint/workspace-revisions';
import {
  fromPackageRelative,
  parseSequencePackageDocument,
  sequencePackagePaths,
  serializeSequencePackageDocument,
  type SequencePackageDocument,
  type SequencePackageRevisionKind,
} from '../db/sequence-package';
import { prepareSequencePackageRevision } from '../db/sequence-package-versioning';
import { SEQUENCE_PACKAGE_FORMAT_VERSION } from '../db/sequence-package-contract';
import { parseNativeJson } from './scientific-native-json';
import type { ScientificObjectStore } from './scientific-object-store';

const packageKind = `dnaforge.sequence-package.v${SEQUENCE_PACKAGE_FORMAT_VERSION}`;

export function scientificSequencePackageResourceId(sequenceId: string): ResourceId {
  const digest = defineBlob(new TextEncoder().encode(sequenceId)).hash.slice('sha256:'.length);
  const parsed = parseResourceId(`sequence-package:${digest}`);
  if (!parsed.ok) throw new Error('The accepted sequence package identity is invalid.');
  return parsed.value;
}

export function readAcceptedSequencePackage(input: {
  store: ScientificObjectStore;
  graph: RevisionGraph;
  head: WorkspaceVersionId;
  sequenceId: ResourceId;
  productPath: WorkspacePath;
  productText: string;

  verifyProductChecksum?: boolean;
}): {
  resourceId: ResourceId;
  revisionId: ResourceRevisionId;
  path: WorkspacePath;
  text: string;
  resourceKind: string;
} | null {
  const resourceId = scientificSequencePackageResourceId(input.sequenceId);
  const slots = listWorkspaceResources(input.graph, input.head);
  if (!slots.ok) throw new Error('The accepted sequence package namespace is unavailable.');
  const slot = slots.value.find((candidate) => candidate.resourceId === resourceId);
  if (!slot) return null;
  const revision = inspectResourceRevision(input.graph, slot.revisionId);
  const expectedPath = sequencePackagePaths(dirname(input.productPath)).metaPath;
  if (!revision.ok || !revision.value.stateHash || slot.tombstone || slot.path !== expectedPath)
    throw new Error('The accepted sequence package does not match its product path.');
  const state = inspectResourceState(input.graph, revision.value.stateHash);
  if (!state.ok || state.value.layout !== 'file')
    throw new Error('The accepted sequence package has an invalid native format.');
  const bytes = input.store.readBlob(state.value.blob);
  if (!bytes) throw new Error('The accepted sequence package bytes are unavailable.');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const raw = parseNativeJson(text);
  const metadata = parseSequencePackageDocument(text);
  if (
    typeof raw.formatVersion !== 'number' ||
    !Number.isInteger(raw.formatVersion) ||
    raw.formatVersion < 6 ||
    raw.formatVersion > SEQUENCE_PACKAGE_FORMAT_VERSION ||
    state.value.resourceKind !== `dnaforge.sequence-package.v${raw.formatVersion}` ||
    metadata.id !== input.sequenceId ||
    metadata.product.file !== basename(input.productPath) ||
    (input.verifyProductChecksum !== false &&
      metadata.product.genBankChecksum !==
        defineBlob(new TextEncoder().encode(input.productText)).hash)
  )
    throw new Error(
      'The accepted sequence package does not match its identity and exact product bytes.'
    );
  return {
    resourceId,
    revisionId: slot.revisionId,
    path: slot.path,
    text,
    resourceKind: state.value.resourceKind,
  };
}

export async function acceptedSequencePackageSavePublication(input: {
  package: NonNullable<ReturnType<typeof readAcceptedSequencePackage>>;
  productText: string;
  bases: string;
  circular: boolean;
  currentProductText: string;
  graph: RevisionGraph;
  head: WorkspaceVersionId;
  operationId: string;
  createdAt?: string;
}): Promise<{
  mutations: readonly WorkspaceMutation[];
  blobs: readonly Uint8Array[];
  snapshotPaths: readonly WorkspacePath[];
}> {
  const raw = parseSequencePackageDocument(input.package.text);
  const product = raw.product;
  const next: SequencePackageDocument = {
    ...raw,
    updatedAt: input.createdAt ?? raw.updatedAt,
    product: {
      ...product,
      genBankChecksum: defineBlob(new TextEncoder().encode(input.productText)).hash,
      ...(Object.hasOwn(product, 'sequenceChecksum')
        ? { sequenceChecksum: await computeChecksum(input.bases) }
        : {}),
      ...(Object.hasOwn(product, 'topology')
        ? { topology: input.circular ? 'circular' : 'linear' }
        : {}),
    },
  };
  return acceptedSequencePackageRevisionPublication({
    ...input,
    next,
    kind: 'sequence-save',
    createdAt: next.updatedAt,
  });
}

export async function acceptedSequencePackageRevisionPublication(input: {
  package: NonNullable<ReturnType<typeof readAcceptedSequencePackage>>;
  currentProductText: string;
  productText: string;
  next: SequencePackageDocument;
  kind: SequencePackageRevisionKind;
  operationId: string;
  createdAt: string;
  graph: RevisionGraph;
  head: WorkspaceVersionId;
}): Promise<{
  mutations: readonly WorkspaceMutation[];
  blobs: readonly Uint8Array[];
  snapshotPaths: readonly WorkspacePath[];
}> {
  const versioned = await prepareSequencePackageRevision({
    current: parseSequencePackageDocument(input.package.text),
    currentProductContent: input.currentProductText,
    next: input.next,
    nextProductContent: input.productText,
    kind: input.kind,
    operationId: input.operationId,
    revisionId: input.operationId,
    adoptedRevisionId: `adopted-before:${input.operationId}`,
    createdAt: input.createdAt,
  });
  const bytes = new TextEncoder().encode(serializeSequencePackageDocument(versioned.document));
  const state = defineResourceState({
    layout: 'file',
    resourceKind: packageKind,
    mediaType: 'application/json',
    blob: defineBlob(bytes),
  });
  if (!state.ok) throw new Error('The accepted sequence package update is invalid.');
  const mutations: WorkspaceMutation[] = [
    {
      kind: 'edit-resource',
      resourceId: input.package.resourceId,
      expectedRevision: input.package.revisionId,
      state: state.value,
    },
  ];
  const blobs = [bytes];
  const slots = listWorkspaceResources(input.graph, input.head);
  if (!slots.ok) throw new Error('Accepted sequence snapshot paths are unavailable.');
  const packageRoot = dirname(dirname(input.package.path));
  const snapshotPaths: WorkspacePath[] = [];
  const digest = defineBlob(new TextEncoder().encode(input.next.id)).hash.slice('sha256:'.length);
  for (const snapshot of versioned.snapshots) {
    const path = parseWorkspacePath(fromPackageRelative(snapshot.path, packageRoot));
    if (!path.ok) throw new Error('Accepted sequence snapshot path is invalid.');
    snapshotPaths.push(path.value);
    const existing = slots.value.find((slot) => !slot.tombstone && slot.path === path.value);
    if (existing) {
      const revision = inspectResourceRevision(input.graph, existing.revisionId);
      const previous =
        revision.ok && revision.value.stateHash
          ? inspectResourceState(input.graph, revision.value.stateHash)
          : null;
      if (
        !previous?.ok ||
        previous.value.layout !== 'file' ||
        previous.value.resourceKind !== 'dnaforge.sequence-product-snapshot.v1' ||
        previous.value.blob.hash !== snapshot.sha256
      )
        throw new Error('The accepted sequence snapshot belongs to different immutable bytes.');
      continue;
    }
    const snapshotBytes = new TextEncoder().encode(snapshot.content);
    const snapshotState = defineResourceState({
      layout: 'file',
      resourceKind: 'dnaforge.sequence-product-snapshot.v1',
      mediaType: 'text/plain',
      blob: defineBlob(snapshotBytes),
    });
    const id = parseResourceId(
      `sequence-snapshot:${digest}:${defineBlob(new TextEncoder().encode(snapshot.path)).hash.slice('sha256:'.length)}`
    );
    if (!snapshotState.ok || !id.ok) throw new Error('Accepted sequence snapshot is invalid.');
    mutations.push({
      kind: 'create-resource',
      resourceId: id.value,
      path: path.value,
      state: snapshotState.value,
      origin: { kind: 'created' },
    });
    blobs.push(snapshotBytes);
  }
  return { mutations, blobs, snapshotPaths };
}

type NativeEntry = Extract<
  ScientificWorkspaceSubmission['source'],
  { kind: 'native-artifact' }
>['entry'];

export function validateNewScientificSequencePackage(entry: NativeEntry): void {
  const supplied = entry.sequencePackageText;
  if (entry.representation.format !== 'genbank-v1') {
    if (supplied !== undefined)
      throw new Error('Only a managed sequence can carry package metadata.');
    return;
  }
  if (typeof supplied !== 'string')
    throw new Error('New accepted sequences require their package metadata.');
  const raw = parseUniqueJson(supplied);
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    !('formatVersion' in raw) ||
    raw.formatVersion !== SEQUENCE_PACKAGE_FORMAT_VERSION
  )
    throw new Error('New accepted sequences require the current package format.');
  const metadata = parseSequencePackageDocument(supplied);
  const packageRoot = dirname(entry.path);
  if (
    packageRoot === '.' ||
    metadata.id !== entry.resourceId ||
    metadata.name !== basename(packageRoot) ||
    metadata.product.file !== basename(entry.path) ||
    metadata.product.genBankChecksum !==
      defineBlob(new TextEncoder().encode(entry.representation.text)).hash ||
    metadata.assembly !== undefined ||
    metadata.entity.relationships.length !== 0 ||
    metadata.members.length !== 0
  )
    throw new Error(
      'New sequence package metadata does not match its identity, path and exact GenBank bytes.'
    );
}

export function newScientificSequencePackagePublication(entry: NativeEntry): {
  mutations: readonly WorkspaceMutation[];
  blobs: readonly Uint8Array[];
} {
  if (entry.representation.format !== 'genbank-v1') return { mutations: [], blobs: [] };
  validateNewScientificSequencePackage(entry);
  const bytes = new TextEncoder().encode(entry.sequencePackageText);
  const resourceId = scientificSequencePackageResourceId(entry.resourceId);
  const path = parseWorkspacePath(sequencePackagePaths(dirname(entry.path)).metaPath);
  const state = defineResourceState({
    layout: 'file',
    resourceKind: packageKind,
    mediaType: 'application/json',
    blob: defineBlob(bytes),
  });
  if (!path.ok || !state.ok)
    throw new Error('The accepted sequence package publication is invalid.');
  return {
    mutations: [
      {
        kind: 'create-resource',
        resourceId,
        path: path.value,
        state: state.value,
        origin: { kind: 'created' },
      },
    ],
    blobs: [bytes],
  };
}

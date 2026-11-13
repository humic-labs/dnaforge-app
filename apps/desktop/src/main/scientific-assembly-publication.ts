import { dirname, basename } from 'node:path';
import type { ScientificWorkspaceSubmission } from '@waypoint/domain-services';
import {
  canonicalPayload,
  createScientificReader,
  defineScientificFile,
} from '@waypoint/scientific-objects';
import {
  computeChecksum,
  matchesSequenceChecksumIgnoringCase,
  parseGenBankFull,
} from '@waypoint/sequence-utils';
import {
  defineBlob,
  defineResourceState,
  inspectResourceRevision,
  inspectResourceState,
  listWorkspaceResources,
  parseResourceId,
  parseWorkspacePath,
  type RevisionGraph,
  type WorkspaceMutation,
  type WorkspaceVersionId,
} from '@waypoint/workspace-revisions';
import {
  parseSequencePackageDocument,
  fromPackageRelative,
  sequencePackagePaths,
} from '../db/sequence-package';
import { SEQUENCE_PACKAGE_FORMAT_VERSION } from '../db/sequence-package-contract';
import { prepareSequencePackageRevision } from '../db/sequence-package-versioning';
import { nativeRecord, parseNativeJson } from './scientific-native-json';
import { scientificNativeCodecs } from './scientific-native-codecs';
import {
  readAcceptedSequencePackage,
  scientificSequencePackageResourceId,
} from './scientific-sequence-package';
import type { ScientificObjectStore } from './scientific-object-store';
import {
  assertAssemblyPrimerPins,
  declaredAssemblyOligos,
} from './scientific-assembly-primer-pins';

type AssemblySource = Extract<
  ScientificWorkspaceSubmission['source'],
  { kind: 'accepted-assembly' }
>;

export async function scientificAssemblyPackagePublication(input: {
  store: ScientificObjectStore;
  graph: RevisionGraph;
  head: WorkspaceVersionId | null;
  source: AssemblySource;
}): Promise<{ mutations: readonly WorkspaceMutation[]; blobs: readonly Uint8Array[] }> {
  const native = input.source.nativePackage;
  if (!native) return { mutations: [], blobs: [] };
  const assembly = input.source.assembly;
  if (input.head === null || assembly.product.kind !== 'submitted')
    throw new Error('Native finalization requires an enrolled project and a submitted product.');
  const productId = assembly.product.resourceId;
  const product = input.source.entries.find((entry) => entry.resourceId === productId);
  if (
    !product ||
    product.resourceId !== assembly.constructId ||
    product.representation?.format !== 'genbank-v1'
  )
    throw new Error('The assembly product does not match its native construct identity.');
  const raw = parseNativeJson(native.metadataText);
  const metadata = parseSequencePackageDocument(native.metadataText);
  const accepted = metadata.assembly?.accepted;
  const version = nativeRecord(assembly.recipe.nativeAcceptedVersion);
  const projection = nativeRecord(version.projectionInput);
  const packageRoot = dirname(product.path);
  const productBases = parseGenBankFull(product.representation.text).sequence;
  if (
    raw.formatVersion !== SEQUENCE_PACKAGE_FORMAT_VERSION ||
    packageRoot === '.' ||
    metadata.id !== product.resourceId ||
    metadata.product.file !== basename(product.path) ||
    metadata.product.genBankChecksum !==
      defineBlob(new TextEncoder().encode(product.representation.text)).hash ||
    !accepted ||
    accepted.acceptedAssemblyVersionId !== version.id ||
    assembly.resourceId !== `accepted-assembly:${version.id}` ||
    accepted.constructId !== assembly.constructId ||
    canonicalPayload(accepted.projectionInput) !== canonicalPayload(projection) ||
    typeof projection.productSequence !== 'string' ||
    projection.productSequence.toLowerCase() !== productBases.toLowerCase()
  )
    throw new Error(
      'The native assembly package does not match its frozen product and construction record.'
    );

  const reader = createScientificReader({
    graph: input.graph,
    head: input.head,
    readBlob: (blob) => input.store.readBlob(blob),
    codecs: scientificNativeCodecs,
  });
  const provenance = projection.sourceProvenance;
  if (!Array.isArray(provenance)) throw new Error('The native assembly sources are unavailable.');
  const declaredSources = new Set<string>();
  for (const value of provenance) {
    const source = nativeRecord(value);
    const identity = source.sourceConstructId ?? source.sourceSequenceId;
    const choice = assembly.sources.find(
      (value) => value.kind === 'accepted' && value.pin.resourceId === identity
    );
    const snapshot = choice?.kind === 'accepted' ? reader.revision(choice.pin) : null;
    if (
      !snapshot ||
      snapshot.document.kind !== 'sequence' ||
      !snapshot.representation ||
      snapshot.representation.format !== 'genbank-v1' ||
      !(await matchesSequenceChecksumIgnoringCase(
        parseGenBankFull(snapshot.representation.text).sequence,
        source.sourceSequenceChecksum
      ))
    )
      throw new Error('An assembly source does not match its exact accepted native sequence.');
    declaredSources.add(snapshot.resourceId);
  }
  if (assembly.sources.length !== declaredSources.size)
    throw new Error('The assembly source pins do not match its native construction record.');

  const designedPairs = projection.designPrimers;
  if (!Array.isArray(designedPairs)) throw new Error('The assembly primer recipe is unavailable.');
  const designed = designedPairs
    .flatMap((value) => {
      const pair = nativeRecord(value);
      return [nativeRecord(pair.forward), nativeRecord(pair.reverse)];
    })
    .filter((primer) => typeof primer.sequence === 'string' && primer.sequence.trim().length > 0);
  const selected = assembly.primers.map((choice) => {
    if (choice.kind === 'accepted') return reader.revision(choice.pin)?.document;
    const entry = input.source.entries.find((value) => value.resourceId === choice.resourceId);
    return entry?.representation?.format === 'primer-v2'
      ? defineScientificFile(entry, scientificNativeCodecs).document
      : null;
  });
  const selections = assembly.primers.map((choice, index) => {
    const document = selected[index];
    if (!document || document.kind !== 'primer')
      throw new Error('The assembly primer pin is unavailable.');
    return {
      resourceId: choice.kind === 'accepted' ? choice.pin.resourceId : choice.resourceId,
      name: document.name,
      bases: document.bases.toUpperCase(),
    };
  });
  assertAssemblyPrimerPins({
    designed,
    selections,
    declared: declaredAssemblyOligos(accepted.savedPrimerOligos),
  });

  const artifacts = nativeRecord(accepted.artifacts);
  const stem = basename(product.path).replace(/\.(?:gb|gbk|genbank)$/iu, '');
  if (
    artifacts.primerCsvPath !== `contents/${stem}.${version.id}.primers.csv` ||
    artifacts.primerFastaPath !== `contents/${stem}.${version.id}.primers.fasta` ||
    artifacts.primerCsvChecksum !== (await computeChecksum(native.primerCsvText)) ||
    artifacts.primerFastaChecksum !== (await computeChecksum(native.primerFastaText))
  )
    throw new Error('The assembly primer exports do not match their frozen checksums.');
  const digest = defineBlob(new TextEncoder().encode(product.resourceId)).hash.slice(
    'sha256:'.length
  );
  const files = [
    {
      id: scientificSequencePackageResourceId(product.resourceId),
      path: sequencePackagePaths(packageRoot).metaPath,
      kind: `dnaforge.sequence-package.v${SEQUENCE_PACKAGE_FORMAT_VERSION}`,
      mediaType: 'application/json',
      text: native.metadataText,
    },
    {
      id: `assembly-export:${digest}:${version.id}:csv`,
      path: fromPackageRelative(String(artifacts.primerCsvPath), packageRoot),
      kind: 'dnaforge.assembly-primer-export',
      mediaType: 'text/csv',
      text: native.primerCsvText,
    },
    {
      id: `assembly-export:${digest}:${version.id}:fasta`,
      path: fromPackageRelative(String(artifacts.primerFastaPath), packageRoot),
      kind: 'dnaforge.assembly-primer-export',
      mediaType: 'text/plain',
      text: native.primerFastaText,
    },
  ];
  const slots = listWorkspaceResources(input.graph, input.head);
  if (!slots.ok) throw new Error('The accepted assembly namespace is unavailable.');
  const parsedProductId = parseResourceId(product.resourceId);
  if (!parsedProductId.ok) throw new Error('The assembly product identity is invalid.');
  const beforeProduct = reader.current(parsedProductId.value);
  const beforeSlot = slots.value.find(
    (entry) => entry.resourceId === product.resourceId && !entry.tombstone
  );
  let beforePackage = null;
  if (beforeProduct) {
    if (
      beforeProduct.document.kind !== 'sequence' ||
      beforeProduct.representation?.format !== 'genbank-v1' ||
      !beforeSlot?.path
    )
      throw new Error('The previous assembly product is not an accepted native sequence.');
    const previous = readAcceptedSequencePackage({
      store: input.store,
      graph: input.graph,
      head: input.head,
      sequenceId: parsedProductId.value,
      productPath: beforeSlot.path,
      productText: beforeProduct.representation.text,
    });
    if (!previous)
      throw new Error('The previous assembly package is unavailable in accepted storage.');
    beforePackage = parseSequencePackageDocument(previous.text);
  }
  const expectedHistory = await prepareSequencePackageRevision({
    current: beforePackage,
    currentProductContent: beforeProduct?.representation?.text ?? null,
    next: metadata,
    nextProductContent: product.representation.text,
    kind: 'assembly-finalization',
    operationId: `assembly-finalization:${version.id}`,
    revisionId: `assembly-finalization:${version.id}`,
    adoptedRevisionId: `adopted-before:${version.id}`,
    createdAt: String(version.acceptedAt),
  });
  if (
    canonicalPayload(expectedHistory.document.versionHistory) !==
      canonicalPayload(metadata.versionHistory) ||
    canonicalPayload(expectedHistory.snapshots) !== canonicalPayload(native.snapshotFiles ?? [])
  )
    throw new Error(
      'The assembly package history does not match its accepted predecessor and exact product.'
    );
  const suppliedSnapshots = new Map<string, { path: string; content: string; sha256: string }>();
  for (const snapshot of native.snapshotFiles ?? []) {
    const declared = metadata.versionHistory.revisions.find(
      (revision) => revision.productSnapshot.path === snapshot.path
    );
    if (
      suppliedSnapshots.has(snapshot.path) ||
      !declared ||
      declared.productSnapshot.sha256 !== snapshot.sha256 ||
      defineBlob(new TextEncoder().encode(snapshot.content)).hash !== snapshot.sha256
    )
      throw new Error('The assembly product snapshot does not match its frozen revision.');
    suppliedSnapshots.set(snapshot.path, snapshot);
    files.push({
      id: `sequence-snapshot:${digest}:${defineBlob(new TextEncoder().encode(snapshot.path)).hash.slice('sha256:'.length)}`,
      path: fromPackageRelative(snapshot.path, packageRoot),
      kind: 'dnaforge.sequence-product-snapshot.v1',
      mediaType: 'text/plain',
      text: snapshot.content,
    });
  }
  for (const revision of metadata.versionHistory.revisions) {
    if (suppliedSnapshots.has(revision.productSnapshot.path)) continue;
    const path = fromPackageRelative(revision.productSnapshot.path, packageRoot);
    const slot = slots.value.find((entry) => !entry.tombstone && entry.path === path);
    const previous = slot ? inspectResourceRevision(input.graph, slot.revisionId) : null;
    const state =
      previous?.ok && previous.value.stateHash
        ? inspectResourceState(input.graph, previous.value.stateHash)
        : null;
    if (
      !state?.ok ||
      state.value.layout !== 'file' ||
      state.value.blob.hash !== revision.productSnapshot.sha256
    )
      throw new Error('An earlier assembly product snapshot is unavailable in accepted storage.');
  }
  const mutations: WorkspaceMutation[] = [],
    blobs: Uint8Array[] = [];
  for (const file of files) {
    const id = parseResourceId(file.id),
      path = parseWorkspacePath(file.path);
    const bytes = new TextEncoder().encode(file.text);
    const state = defineResourceState({
      layout: 'file',
      resourceKind: file.kind,
      mediaType: file.mediaType,
      blob: defineBlob(bytes),
    });
    if (!id.ok || !path.ok || !state.ok)
      throw new Error('The native assembly file publication is invalid.');
    const existing = slots.value.find((slot) => slot.resourceId === id.value);
    if (existing) {
      const revision = inspectResourceRevision(input.graph, existing.revisionId);
      const prior =
        revision.ok && revision.value.stateHash
          ? inspectResourceState(input.graph, revision.value.stateHash)
          : null;
      if (
        existing.tombstone ||
        existing.path !== path.value ||
        !prior?.ok ||
        (prior.value.resourceKind !== file.kind &&
          !(
            file.id === scientificSequencePackageResourceId(product.resourceId) &&
            /^dnaforge\.sequence-package\.v[678]$/u.test(prior.value.resourceKind)
          ))
      )
        throw new Error('The native assembly file does not match its accepted owner.');
      mutations.push({
        kind: 'edit-resource',
        resourceId: id.value,
        expectedRevision: existing.revisionId,
        state: state.value,
      });
    } else
      mutations.push({
        kind: 'create-resource',
        resourceId: id.value,
        path: path.value,
        state: state.value,
        origin: { kind: 'created' },
      });
    blobs.push(bytes);
  }
  return { mutations, blobs };
}

import type { HostedReferenceBrowserCatalogDefinitionV1 } from '../../shared/hosted-reference-browser-catalog';
import type {
  PreparedReferenceAssemblyEntryV1,
  ReferenceAssetImportLocalRequestV1,
  ReferenceAssetImportLocalResultV1,
  ReferenceAssetPreparationProgressV1,
} from '../../shared/reference-assets-ipc';
import {
  HOSTED_GENOME_BLOCK_BYTES,
  hostedGenomeObjectPath,
  listHostedGenomes,
  pickHostedGenomeFile,
  reconcileHostedGenomeJobs,
  saveHostedGenomeSource,
  startHostedGenomeIndexing,
  waitForHostedGenomeIndexing,
  type HostedGenomeLocation,
} from '../reference-genome-jobs';
import type { BrowserPreparedReferencesV1 } from './browser-prepared-references';
import {
  PreparedReferenceObjectStoreV1,
  type PreparedReferenceBlockDigestsV1,
  type PreparedReferenceObjectLocatorV1,
  type PreparedReferenceObjectStoreOptionsV1,
} from './object-store';

type ProgressListener = (progress: ReferenceAssetPreparationProgressV1) => void;

const progressListeners = new Set<ProgressListener>();
const SIGNED_URL_MARGIN_MS = 15_000;

export function onUserGenomePreparationProgress(listener: ProgressListener): () => void {
  progressListeners.add(listener);
  return () => progressListeners.delete(listener);
}

function report(progress: ReferenceAssetPreparationProgressV1): void {
  for (const listener of progressListeners) listener(progress);
}

export function projectGenomeObjectLocator(
  location: HostedGenomeLocation,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init)
): PreparedReferenceObjectLocatorV1 {
  const objects = new Map(location.record.objects.map((object) => [object.objectKey, object]));
  const signed = new Map<string, { url: string; expiresAt: number }>();
  return async (objectKey) => {
    const cached = signed.get(objectKey);
    if (cached && cached.expiresAt - SIGNED_URL_MARGIN_MS > Date.now()) return cached.url;
    const object = objects.get(objectKey);
    const versionId = location.versionId;
    if (!object || !versionId)
      throw new Error(`Prepared genome object is unavailable: ${objectKey}`);
    const path = hostedGenomeObjectPath(location.record.assembly.id, objectKey);
    const response = await fetchImpl(
      `/api/hosted-workspaces/${encodeURIComponent(location.workspaceId)}` +
        `/versions/${encodeURIComponent(versionId)}/files?path=${encodeURIComponent(path)}&location=json`,
      { credentials: 'same-origin', cache: 'no-store' }
    );
    const body = (await response.json().catch(() => null)) as {
      signedUrl?: unknown;
      contentSha256?: unknown;
      sizeBytes?: unknown;
      expiresAt?: unknown;
    } | null;
    if (
      !response.ok ||
      typeof body?.signedUrl !== 'string' ||
      body.contentSha256 !== object.sha256 ||
      body.sizeBytes !== object.byteLength ||
      typeof body.expiresAt !== 'string'
    ) {
      throw new Error(`Prepared genome object is unavailable: ${objectKey}`);
    }
    signed.set(objectKey, { url: body.signedUrl, expiresAt: Date.parse(body.expiresAt) });
    return body.signedUrl;
  };
}

export function userGenomeDefinition(
  location: HostedGenomeLocation
): HostedReferenceBrowserCatalogDefinitionV1 {
  const { record } = location;
  return {
    listing: {
      id: record.assembly.id,
      name: record.assembly.name,
      organism: record.assembly.organism,
      description: record.assembly.description,
      lengthBp: record.assembly.lengthBp,
      contigCount: record.assembly.contigs.length,
      downloadBytes: record.objects.reduce((sum, object) => sum + object.byteLength, 0),
      provider: 'Project',
      datasetVersion: record.publicationFingerprint.slice(0, 16),
    },
    manifest: {
      relativePath: record.bundle.objectKey,
      sha256: record.bundle.sha256,
      byteLength: record.bundle.byteLength,
    },
    contigs: record.assembly.contigs.map(({ chrom }) => ({ chrom })),
  };
}

export function userGenomeBlockDigests(
  location: HostedGenomeLocation
): PreparedReferenceBlockDigestsV1 {
  const objects = new Map(location.record.objects.map((object) => [object.objectKey, object]));
  return (ref) => {
    const object = objects.get(ref.objectKey);
    if (!object || object.sha256 !== ref.sha256) return null;
    if (object.blockSha256) return object.blockSha256;
    return ref.byteLength <= HOSTED_GENOME_BLOCK_BYTES ? [ref.sha256] : null;
  };
}

export function userGenomeObjectStore(
  location: HostedGenomeLocation,
  options: Partial<PreparedReferenceObjectStoreOptionsV1> = {}
): PreparedReferenceObjectStoreV1 {
  return new PreparedReferenceObjectStoreV1({
    locate: projectGenomeObjectLocator(location),
    ...options,
    hiddenContentRange: true,
    rangeBlockBytes: HOSTED_GENOME_BLOCK_BYTES,
    blockSha256: userGenomeBlockDigests(location),
  });
}

async function admitUserGenome(
  references: BrowserPreparedReferencesV1,
  location: HostedGenomeLocation
): Promise<PreparedReferenceAssemblyEntryV1> {
  references.addDefinition(userGenomeDefinition(location), userGenomeObjectStore(location));
  const admitted = await references.installHosted({
    catalogId: location.record.assembly.id,
    themeMode: 'light',
    intent: 'open-view',
  });
  return admitted.entry;
}

export async function listUserGenomes(
  references: BrowserPreparedReferencesV1
): Promise<PreparedReferenceAssemblyEntryV1[]> {
  await reconcileHostedGenomeJobs();
  const entries: PreparedReferenceAssemblyEntryV1[] = [];
  for (const location of await listHostedGenomes()) {
    const entry = await admitUserGenome(references, location).catch((error: unknown) => {
      console.warn('[hosted-genomes] could not open a saved genome', location.root, error);
      return null;
    });
    if (entry) entries.push(entry);
  }
  return entries;
}

export async function importUserGenome(
  references: () => Promise<BrowserPreparedReferencesV1>,
  request: ReferenceAssetImportLocalRequestV1
): Promise<ReferenceAssetImportLocalResultV1> {
  if (request.sourcePath || request.assemblyLink) {
    throw new Error('In the web app, choose a GenBank genome file to index.');
  }
  const file = await pickHostedGenomeFile();
  if (!file) return { status: 'cancelled' };
  const progress = (phase: string, label: string) =>
    report({ operationId: request.operationId, phase, label });
  progress('inspecting-sources', `Saving ${file.name} to the project`);
  const source = await saveHostedGenomeSource(file);
  progress('indexing-reference', 'Indexing the genome on the server');
  const operation = await startHostedGenomeIndexing(source);
  const location = await waitForHostedGenomeIndexing(operation.id);
  progress('verifying-publication', 'Opening the indexed genome');
  return { status: 'ready', entry: await admitUserGenome(await references(), location) };
}

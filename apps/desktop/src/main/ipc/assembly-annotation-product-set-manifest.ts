import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';

import { joinPath } from '../../features/sequence/indexed-genome-paths';
import type { AssemblyAnnotationProductSetCommitInputV1 } from './assembly-annotation-product-index-coordinator';
import type { AssemblyAnnotationSceneReadRequest } from '../../shared/indexed-genome';

export const ASSEMBLY_ANNOTATION_PRODUCT_SET_MANIFEST_V2 =
  'assembly-annotation-product-set-manifest.v2' as const;

type PublishedAssemblyAnnotationProductV1 = Omit<
  AssemblyAnnotationProductSetCommitInputV1['products'][number],
  'artifactStatus'
> &
  Readonly<{ artifactStatus: 'published' }>;

export interface AssemblyAnnotationProductSetManifestV2 {
  readonly contract: typeof ASSEMBLY_ANNOTATION_PRODUCT_SET_MANIFEST_V2;
  readonly assemblyId: string;
  readonly themeMode: 'light' | 'dark';
  readonly sourceFingerprint: string;
  readonly datasetContract: AssemblyAnnotationProductSetCommitInputV1['datasetContract'];
  readonly scope: AssemblyAnnotationProductSetCommitInputV1['scope'];
  readonly chromosomes: AssemblyAnnotationProductSetCommitInputV1['chromosomes'];
  readonly trackTypes: readonly string[];
  readonly products: readonly PublishedAssemblyAnnotationProductV1[];
  readonly searchIndexes: AssemblyAnnotationProductSetCommitInputV1['searchIndexes'];
  readonly inventoryFingerprint: string;
}

export interface AssemblyAnnotationProductSetManifestDepsV1 {
  readonly assertSafePath: (path: string) => Promise<void>;
  readonly mkdirImpl?: typeof mkdir;
  readonly writeFileImpl?: typeof writeFile;
  readonly renameImpl?: typeof rename;
  readonly unlinkImpl?: typeof unlink;
  readonly randomId?: () => string;
  readonly readFileImpl?: typeof readFile;
}

export async function writeAssemblyAnnotationProductSetManifestV2(
  input: AssemblyAnnotationProductSetCommitInputV1,
  deps: AssemblyAnnotationProductSetManifestDepsV1
): Promise<Readonly<{ inventoryFingerprint: string; manifestPath: string }>> {
  validateCommitInput(input);
  await deps.assertSafePath(input.workspaceRoot);
  const products = input.products
    .map(
      (product): PublishedAssemblyAnnotationProductV1 => ({
        ...product,
        artifactStatus: 'published',
      })
    )
    .sort((left, right) => left.trackType.localeCompare(right.trackType));
  const sourceFingerprint = products[0].sourceFingerprint;
  const trackTypes = products.map((product) => product.trackType);
  const core = {
    contract: ASSEMBLY_ANNOTATION_PRODUCT_SET_MANIFEST_V2,
    assemblyId: input.assemblyId,
    themeMode: input.themeMode,
    sourceFingerprint,
    datasetContract: input.datasetContract,
    scope: input.scope,
    chromosomes: input.chromosomes,
    trackTypes,
    products,
    searchIndexes: input.searchIndexes,
  } as const;
  const inventoryFingerprint = sha256(JSON.stringify(core));
  const manifest: AssemblyAnnotationProductSetManifestV2 = {
    ...core,
    inventoryFingerprint,
  };
  const directory = productSetDirectory(input.workspaceRoot);
  const manifestPath = productSetManifestPath(
    input.workspaceRoot,
    input.assemblyId,
    sourceFingerprint,
    input.themeMode
  );
  const temporaryPath = `${manifestPath}.${deps.randomId?.() ?? randomUUID()}.tmp`;
  await (deps.mkdirImpl ?? mkdir)(directory, { recursive: true });
  try {
    await (deps.writeFileImpl ?? writeFile)(temporaryPath, JSON.stringify(manifest), 'utf8');
    await (deps.renameImpl ?? rename)(temporaryPath, manifestPath);
  } catch (error) {
    await (deps.unlinkImpl ?? unlink)(temporaryPath).catch(() => undefined);
    throw error;
  }
  return { inventoryFingerprint, manifestPath };
}

export async function readAssemblyAnnotationProductSetManifestV2(
  input: {
    readonly seedRequest: AssemblyAnnotationSceneReadRequest;
    readonly sourceFingerprint: string;
  },
  deps: Pick<AssemblyAnnotationProductSetManifestDepsV1, 'assertSafePath' | 'readFileImpl'>
): Promise<AssemblyAnnotationProductSetManifestV2 | null> {
  try {
    const { seedRequest, sourceFingerprint } = input;
    if (!/^[0-9a-f]{24}$/.test(sourceFingerprint)) return null;
    await deps.assertSafePath(seedRequest.workspaceRoot);
    const path = productSetManifestPath(
      seedRequest.workspaceRoot,
      seedRequest.assemblyId,
      sourceFingerprint,
      seedRequest.artifact.themeMode
    );
    const raw = await (deps.readFileImpl ?? readFile)(path, 'utf8');
    const parsed = JSON.parse(String(raw)) as AssemblyAnnotationProductSetManifestV2;
    if (
      parsed?.contract !== ASSEMBLY_ANNOTATION_PRODUCT_SET_MANIFEST_V2 ||
      parsed.assemblyId !== seedRequest.assemblyId ||
      parsed.themeMode !== seedRequest.artifact.themeMode ||
      parsed.sourceFingerprint !== sourceFingerprint ||
      JSON.stringify(parsed.datasetContract) !== JSON.stringify(seedRequest.datasetContract) ||
      JSON.stringify(parsed.scope) !== JSON.stringify(seedRequest.scope) ||
      !relocatableChromosomeContractsEqual(parsed.chromosomes, seedRequest.chromosomes) ||
      !Array.isArray(parsed.trackTypes) ||
      !Array.isArray(parsed.products) ||
      parsed.trackTypes.length === 0 ||
      parsed.trackTypes.length !== parsed.products.length ||
      !searchIndexesAreValid(parsed.searchIndexes)
    ) {
      return null;
    }
    const sortedProducts = [...parsed.products].sort((left, right) =>
      left.trackType.localeCompare(right.trackType)
    );
    const sortedTrackTypes = sortedProducts.map((product) => product.trackType);
    if (
      new Set(sortedTrackTypes).size !== sortedTrackTypes.length ||
      sortedTrackTypes.some((track, index) => track !== parsed.trackTypes[index]) ||
      sortedProducts.some(
        (product) =>
          product.artifactStatus !== 'published' ||
          product.sourceFingerprint !== sourceFingerprint ||
          !/^[0-9a-f]{64}$/.test(product.surfaceManifestFingerprint) ||
          !/^[0-9a-f]{64}$/.test(product.catalogFingerprint)
      )
    ) {
      return null;
    }
    const { inventoryFingerprint: _fingerprint, ...core } = parsed;
    if (sha256(JSON.stringify(core)) !== parsed.inventoryFingerprint) return null;
    return parsed;
  } catch {
    return null;
  }
}

function productSetDirectory(workspaceRoot: string): string {
  return joinPath(workspaceRoot, '.waypoint', 'genome-index', 'assembly-overview');
}

function relocatableChromosomeContractsEqual(
  published: AssemblyAnnotationProductSetManifestV2['chromosomes'],
  current: AssemblyAnnotationSceneReadRequest['chromosomes']
): boolean {
  if (!Array.isArray(published) || published.length !== current.length) return false;
  return published.every((left, index) => {
    const right = current[index];
    if (
      !right ||
      left.chrom !== right.chrom ||
      left.length !== right.length ||
      hasPath(left.sourcePath) !== hasPath(right.sourcePath)
    ) {
      return false;
    }
    if (Boolean(left.manifest) !== Boolean(right.manifest)) return false;
    if (!left.manifest || !right.manifest) return true;
    return (
      left.manifest.chrom === right.manifest.chrom &&
      left.manifest.length === right.manifest.length &&
      hasPath(left.manifest.fastaPath) === hasPath(right.manifest.fastaPath) &&
      hasPath(left.manifest.faiPath) === hasPath(right.manifest.faiPath) &&
      hasPath(left.manifest.gffPath) === hasPath(right.manifest.gffPath) &&
      hasPath(left.manifest.tbiPath) === hasPath(right.manifest.tbiPath)
    );
  });
}

function hasPath(path: string | null | undefined): boolean {
  return typeof path === 'string' && path.trim().length > 0;
}

function productSetManifestPath(
  workspaceRoot: string,
  assemblyId: string,
  sourceFingerprint: string,
  themeMode: 'light' | 'dark'
): string {
  const safeAssemblyId = assemblyId.replace(/[^A-Za-z0-9._-]+/g, '_');
  return joinPath(
    productSetDirectory(workspaceRoot),
    `${safeAssemblyId}-${sourceFingerprint}-${themeMode}.annotation-product-set.v2.json`
  );
}

function validateCommitInput(input: AssemblyAnnotationProductSetCommitInputV1): void {
  if (
    !input?.assemblyId ||
    !input.workspaceRoot ||
    (input.themeMode !== 'light' && input.themeMode !== 'dark') ||
    !Array.isArray(input.products) ||
    input.products.length === 0
  ) {
    throw new Error('Invalid assembly annotation product-set commit input.');
  }
  if (!searchIndexesAreValid(input.searchIndexes)) {
    throw new Error('Assembly annotation product-set search receipts are invalid.');
  }
  const tracks = new Set<string>();
  let sourceFingerprint: string | null = null;
  for (const product of input.products) {
    if (!product.trackType || tracks.has(product.trackType)) {
      throw new Error('Assembly annotation product-set tracks must be unique and nonempty.');
    }
    tracks.add(product.trackType);
    if (!/^[0-9a-f]{24}$/.test(product.sourceFingerprint)) {
      throw new Error('Assembly annotation product-set source fingerprint is invalid.');
    }
    if (sourceFingerprint !== null && sourceFingerprint !== product.sourceFingerprint) {
      throw new Error('Assembly annotation product-set products do not share one source revision.');
    }
    sourceFingerprint = product.sourceFingerprint;
    if (
      !/^[0-9a-f]{64}$/.test(product.surfaceManifestFingerprint) ||
      !/^[0-9a-f]{64}$/.test(product.catalogFingerprint)
    ) {
      throw new Error('Assembly annotation product-set product fingerprint is invalid.');
    }
  }
}

function searchIndexesAreValid(
  value: AssemblyAnnotationProductSetCommitInputV1['searchIndexes'] | null | undefined
): boolean {
  return Boolean(
    value &&
    searchReceiptIsValid(value.annotationSearch) &&
    searchReceiptIsValid(value.proteinSearch)
  );
}

function searchReceiptIsValid(
  value: AssemblyAnnotationProductSetCommitInputV1['searchIndexes']['annotationSearch']
): boolean {
  return Boolean(
    value &&
    /^[0-9a-f]{24}$/.test(value.fingerprint) &&
    Number.isSafeInteger(value.byteCount) &&
    value.byteCount >= 0 &&
    /^[0-9a-f]{64}$/.test(value.payloadSha256) &&
    /^[0-9a-f]{64}$/.test(value.contractSha256) &&
    value.schema?.trim() &&
    value.contractToken?.trim()
  );
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

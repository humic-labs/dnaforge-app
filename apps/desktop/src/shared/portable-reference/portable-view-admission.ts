import {
  resealPartitionedTranscriptSceneBinaryDatasetContractV4,
  resealPartitionedTranscriptSceneRangeCatalogV1,
  type CompiledBroadAnnotationInteractionBinaryManifestV1,
  type PartitionedTranscriptSceneBinaryManifestV4,
  type PartitionedTranscriptSceneRangeCatalogV1,
} from '@waypoint/genome-renderer/pure';

import {
  ANNOTATION_LAYER_IDENTITY_LEGACY_RAW_QUALIFIER_CONTRACT_TOKEN,
  ANNOTATION_TRACK_IDENTITY_CONTRACT_TOKEN,
  ANNOTATION_TRACK_IDENTITY_PREVIOUS_CONTRACT_TOKENS,
  type AnnotationTrackIdentityPublishedContractToken,
} from '../../features/sequence/annotation-layer-identity';
import { annotationSceneCompilerContractFingerprint } from '../annotation-scene-compiler-contract';
import type { AssemblyAnnotationRoleSidecarDiskDescriptorV1 } from '../assembly-annotation-role-sidecar';
import {
  ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
  ASSEMBLY_REFERENCE_ASSET_GENERATION_V1,
  type AssemblyAnnotationSceneArtifactContract,
  type AssemblyAnnotationSceneReadRequest,
  type AssemblyAnnotationSceneScopeContract,
  type AssemblyOverviewChromInput,
  type AssemblyReferenceAssetGenerationByThemeV1,
} from '../indexed-genome';
import { sha256Hex } from '../sha256-sync';
import {
  assertPortableCatalogThemeRosterCoherence,
  type PortablePreparedReferenceViewCatalogEntryV1,
} from './portable-prepared-reference-view-catalog';

export const PORTABLE_ANNOTATION_PRODUCT_SET_MANIFEST_V2 =
  'assembly-annotation-product-set-manifest.v2' as const;

const SHA256 = /^[0-9a-f]{64}$/;
const SOURCE_FINGERPRINT = /^[0-9a-f]{24}$/;

export interface PortableAnnotationProductSetV2 {
  readonly contract: typeof PORTABLE_ANNOTATION_PRODUCT_SET_MANIFEST_V2;
  readonly assemblyId: string;
  readonly themeMode: 'light' | 'dark';
  readonly sourceFingerprint: string;
  readonly datasetContract: Readonly<{
    datasetId: string;
    datasetVersion: string;
    sourceSha256: string;
  }>;
  readonly scope: AssemblyAnnotationSceneScopeContract;
  readonly chromosomes: readonly AssemblyOverviewChromInput[];
  readonly trackTypes: readonly string[];
  readonly products: ReadonlyArray<
    Readonly<{
      trackType: string;
      artifactStatus: string;
      sourceFingerprint: string;
      surfaceManifestFingerprint: string;
      catalogFingerprint: string;
    }>
  >;
  readonly inventoryFingerprint: string;
}

export interface PortablePreparedMemberIdentityV1 {
  readonly chrom: string;
  readonly lengthBp: number;
  readonly manifest: Readonly<{
    fastaPath?: string;
    faiPath?: string;
    gffPath?: string | null;
    tbiPath?: string | null;
  }>;
}

export interface PortablePreparedIdentityV1 {
  readonly id: string;
  readonly members: readonly PortablePreparedMemberIdentityV1[];
}

export interface PortableSceneDiskManifestV1 {
  readonly version?: unknown;
  readonly assemblyId?: unknown;
  readonly fingerprint?: unknown;
  readonly compilerContractFingerprint?: unknown;
  readonly byteCount?: unknown;
  readonly scope?: AssemblyAnnotationSceneScopeContract;
  readonly artifact?: AssemblyAnnotationSceneArtifactContract;
  readonly sceneManifest?: PartitionedTranscriptSceneBinaryManifestV4;
  readonly detailRangeCatalog?: PartitionedTranscriptSceneRangeCatalogV1;
  readonly companionKey?: unknown;
  readonly roleSidecar?: AssemblyAnnotationRoleSidecarDiskDescriptorV1;
}

export interface ValidPortableSceneDiskManifestV1 extends PortableSceneDiskManifestV1 {
  readonly version: 6;
  readonly assemblyId: string;
  readonly fingerprint: string;
  readonly compilerContractFingerprint: string;
  readonly byteCount: number;
  readonly scope: AssemblyAnnotationSceneScopeContract;
  readonly artifact: AssemblyAnnotationSceneArtifactContract;
  readonly sceneManifest: PartitionedTranscriptSceneBinaryManifestV4;
  readonly detailRangeCatalog?: PartitionedTranscriptSceneRangeCatalogV1;
}

export interface LocallyResealedPortableSceneManifestV1 {
  readonly disk: ValidPortableSceneDiskManifestV1;
  readonly publishedManifest: PartitionedTranscriptSceneBinaryManifestV4;
  readonly manifest: PartitionedTranscriptSceneBinaryManifestV4;
  readonly compilerContractFingerprint: string;
  readonly detailRangeCatalog?: PartitionedTranscriptSceneRangeCatalogV1;
}

export function portableViewKeyV1(themeMode: 'dark' | 'light', trackType: string): string {
  return `${themeMode}\0${trackType}`;
}

export function portablePlacementFingerprintV1(
  placements: AssemblyAnnotationSceneScopeContract['placements']
): string | null {
  let total = 0;
  const lines: string[] = [];
  for (let index = 0; index < placements.length; index += 1) {
    const placement = placements[index];
    if (!placement?.chrom || !Number.isSafeInteger(placement.length) || placement.length <= 0) {
      return null;
    }
    const start = total;
    total += placement.length;
    if (!Number.isSafeInteger(total)) return null;
    lines.push(`${index}|${placement.chrom}|${start}|${total}|${placement.length}`);
  }
  const signature = [
    'placement:ordered-linear-assembly-placement-v1',
    `total:${total}`,
    ...lines,
  ].join('\n');
  return `ap1:${sha256Hex(signature).slice(0, 24)}`;
}

export function portableSameScopeV1(
  left: AssemblyAnnotationSceneScopeContract | undefined,
  right: AssemblyAnnotationSceneScopeContract
): boolean {
  return Boolean(
    left &&
    left.kind === right.kind &&
    left.placements.length === right.placements.length &&
    left.placements.every((placement, index) => {
      const expected = right.placements[index];
      return (
        placement.chrom === expected?.chrom &&
        placement.length === expected?.length &&
        placement.annotationCoverage === expected?.annotationCoverage
      );
    })
  );
}

export function portableSamePublishedDatasetContractV1(
  left: PortableAnnotationProductSetV2['datasetContract'],
  right: PortableAnnotationProductSetV2['datasetContract']
): boolean {
  return (
    left.datasetId === right.datasetId &&
    left.datasetVersion === right.datasetVersion &&
    left.sourceSha256 === right.sourceSha256
  );
}

export function portableSameOrderedStringsV1(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function portableSameArtifactV1(
  left: AssemblyAnnotationSceneArtifactContract | undefined,
  right: AssemblyAnnotationSceneArtifactContract
): boolean {
  return Boolean(
    left &&
    left.artifactKey === right.artifactKey &&
    left.themeMode === right.themeMode &&
    left.trackType === right.trackType &&
    left.partitionSpanBp === right.partitionSpanBp &&
    left.annotationBarHeightPx === right.annotationBarHeightPx &&
    left.laneAlgorithmToken === right.laneAlgorithmToken &&
    left.mapperContractToken === right.mapperContractToken &&
    left.geometryContractToken === right.geometryContractToken &&
    left.interactionContractToken === right.interactionContractToken
  );
}

export function portableDatasetContractMatchesV1(
  request: AssemblyAnnotationSceneReadRequest['datasetContract'],
  product: PortableAnnotationProductSetV2['datasetContract']
): boolean {
  return (
    request.datasetId === product.datasetId && request.datasetVersion === product.datasetVersion
  );
}

export function portableProductDatasetVersionV1(
  productsByTheme: ReadonlyMap<
    'dark' | 'light',
    Pick<PortableAnnotationProductSetV2, 'datasetContract'>
  >
): string {
  const light = productsByTheme.get('light')?.datasetContract.datasetVersion.trim();
  const darkProduct = productsByTheme.get('dark');
  const dark = darkProduct?.datasetContract.datasetVersion.trim();
  if (!light || (darkProduct && light !== dark)) {
    throw new Error('Portable prepared-reference product dataset versions are incomplete.');
  }
  return light;
}

export function portableAssetGenerationsByThemeV1(
  productsByTheme: ReadonlyMap<
    'dark' | 'light',
    Pick<PortableAnnotationProductSetV2, 'sourceFingerprint' | 'inventoryFingerprint'>
  >
): AssemblyReferenceAssetGenerationByThemeV1 {
  const light = productsByTheme.get('light');
  const dark = productsByTheme.get('dark');
  if (!light) {
    throw new Error('Portable prepared-reference product themes are incomplete.');
  }
  return Object.freeze({
    light: Object.freeze({
      contract: ASSEMBLY_REFERENCE_ASSET_GENERATION_V1,
      sourceFingerprint: light.sourceFingerprint,
      inventoryFingerprint: light.inventoryFingerprint,
      themeMode: 'light' as const,
    }),
    ...(dark
      ? {
          dark: Object.freeze({
            contract: ASSEMBLY_REFERENCE_ASSET_GENERATION_V1,
            sourceFingerprint: dark.sourceFingerprint,
            inventoryFingerprint: dark.inventoryFingerprint,
            themeMode: 'dark' as const,
          }),
        }
      : {}),
  });
}

export function assertPortableFullThemeProductCoherenceV1(
  catalog: Readonly<{
    entries: readonly Pick<
      PortablePreparedReferenceViewCatalogEntryV1,
      | 'themeMode'
      | 'trackType'
      | 'placementFingerprint'
      | 'sceneContractSha256'
      | 'compiledBroadInteractionPayloadSha256'
      | 'compiledBroadInteractionPayloadObjectId'
    >[];
  }>,
  productsByTheme: ReadonlyMap<
    'dark' | 'light',
    Pick<PortableAnnotationProductSetV2, 'datasetContract' | 'scope' | 'trackTypes'>
  >
): void {
  const light = productsByTheme.get('light');
  const dark = productsByTheme.get('dark');
  if (!light) {
    throw new Error('Portable prepared-reference product themes are incomplete.');
  }
  assertPortableCatalogThemeRosterCoherence(catalog);
  const catalogTracks = {
    light: catalog.entries
      .filter((entry) => entry.themeMode === 'light')
      .map((entry) => entry.trackType),
    dark: catalog.entries
      .filter((entry) => entry.themeMode === 'dark')
      .map((entry) => entry.trackType),
  };
  if (
    !portableSameOrderedStringsV1(light.trackTypes, catalogTracks.light) ||
    !portableSameOrderedStringsV1(dark?.trackTypes ?? [], catalogTracks.dark) ||
    (dark && !portableSameOrderedStringsV1(light.trackTypes, dark.trackTypes))
  ) {
    throw new Error('Portable prepared-reference theme track rosters do not match.');
  }
  if (
    dark &&
    !portableSamePublishedDatasetContractV1(light.datasetContract, dark.datasetContract)
  ) {
    throw new Error('Portable prepared-reference theme dataset contracts do not match.');
  }
  if (dark && !portableSameScopeV1(light.scope, dark.scope)) {
    throw new Error('Portable prepared-reference theme scopes do not match.');
  }
  const expectedPlacementFingerprint = portablePlacementFingerprintV1(light.scope.placements);
  if (
    catalog.entries.some((entry) => entry.placementFingerprint !== expectedPlacementFingerprint)
  ) {
    throw new Error('Portable prepared-reference catalog placements do not match its products.');
  }
}

export function parsePortableProductSetV1(
  value: unknown,
  expectedSourceFingerprint: string
): PortableAnnotationProductSetV2 {
  const root = record(value, 'portable annotation product set');
  onlyKeys(
    root,
    [
      'contract',
      'assemblyId',
      'themeMode',
      'sourceFingerprint',
      'datasetContract',
      'scope',
      'chromosomes',
      'trackTypes',
      'products',
      'searchIndexes',
      'inventoryFingerprint',
    ],
    'portable annotation product set'
  );
  if (
    root.contract !== PORTABLE_ANNOTATION_PRODUCT_SET_MANIFEST_V2 ||
    (root.themeMode !== 'dark' && root.themeMode !== 'light') ||
    root.sourceFingerprint !== expectedSourceFingerprint ||
    !SOURCE_FINGERPRINT.test(String(root.sourceFingerprint)) ||
    !SHA256.test(String(root.inventoryFingerprint)) ||
    !Array.isArray(root.trackTypes) ||
    !Array.isArray(root.products) ||
    root.trackTypes.length === 0 ||
    root.trackTypes.length !== root.products.length
  ) {
    throw new Error('Portable annotation product-set identity is invalid.');
  }
  const product = root as unknown as PortableAnnotationProductSetV2;
  const tracks = product.products.map((receipt) => receipt.trackType);
  if (
    new Set(tracks).size !== tracks.length ||
    tracks.some((track, index) => track !== product.trackTypes[index]) ||
    product.products.some(
      (receipt) =>
        !receipt?.trackType ||
        receipt.artifactStatus !== 'published' ||
        receipt.sourceFingerprint !== product.sourceFingerprint ||
        !SHA256.test(receipt.surfaceManifestFingerprint) ||
        !SHA256.test(receipt.catalogFingerprint)
    )
  ) {
    throw new Error('Portable annotation product-set roster is invalid.');
  }
  const { inventoryFingerprint: _inventoryFingerprint, ...core } = root;
  if (sha256Hex(JSON.stringify(core)) !== product.inventoryFingerprint) {
    throw new Error('Portable annotation product-set fingerprint does not match.');
  }
  return product;
}

export function assertPortableProductViewReceiptsV1(
  product: PortableAnnotationProductSetV2,
  entriesByView: ReadonlyMap<string, PortablePreparedReferenceViewCatalogEntryV1>
): void {
  for (const receipt of product.products) {
    const view = entriesByView.get(portableViewKeyV1(product.themeMode, receipt.trackType));
    if (
      !view ||
      receipt.artifactStatus !== 'published' ||
      receipt.sourceFingerprint !== product.sourceFingerprint ||
      receipt.surfaceManifestFingerprint !== view.surfaceManifestFingerprint ||
      receipt.catalogFingerprint !== view.catalogFingerprint
    ) {
      throw new Error(
        `Portable prepared-reference product receipt is not backed by its view: ${receipt.trackType}`
      );
    }
  }
}

export function portableProductMatchesPreparedDefinitionV1(
  product: PortableAnnotationProductSetV2,
  prepared: PortablePreparedIdentityV1
): boolean {
  if (
    product.assemblyId !== prepared.id ||
    product.scope.kind !== 'complete-assembly' ||
    product.scope.placements.length !== prepared.members.length ||
    product.chromosomes.length !== prepared.members.length
  ) {
    return false;
  }
  return prepared.members.every((member, index) => {
    const placement = product.scope.placements[index];
    const chromosome = product.chromosomes[index];
    return (
      placement?.chrom === member.chrom &&
      placement.length === member.lengthBp &&
      placement.annotationCoverage === 'sourced' &&
      chromosome?.chrom === member.chrom &&
      chromosome.length === member.lengthBp &&
      chromosome.manifest?.chrom === member.chrom &&
      chromosome.manifest.length === member.lengthBp
    );
  });
}

export function portableRequestMatchesProductV1(
  request: AssemblyAnnotationSceneReadRequest,
  admission: Readonly<{
    prepared: PortablePreparedIdentityV1 | undefined;
    familyRoot: string;
    generationRoot: string;
  }>,
  product: PortableAnnotationProductSetV2,
  resolvePath: (...segments: string[]) => string
): boolean {
  const prepared = admission.prepared;
  if (
    !prepared ||
    request?.ipcContractVersion !== ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT ||
    request.assemblyId !== prepared.id ||
    resolvePath(request.workspaceRoot) !== admission.familyRoot ||
    request.artifact.themeMode !== product.themeMode ||
    !product.trackTypes.includes(request.artifact.trackType) ||
    !portableDatasetContractMatchesV1(request.datasetContract, product.datasetContract) ||
    JSON.stringify(request.scope) !== JSON.stringify(product.scope) ||
    request.chromosomes.length !== prepared.members.length
  ) {
    return false;
  }
  return prepared.members.every((member, index) => {
    const chromosome = request.chromosomes[index];
    const manifest = chromosome?.manifest;
    const expectedFasta = resolvePath(admission.generationRoot, member.manifest.fastaPath ?? '');
    const expectedFai = resolvePath(admission.generationRoot, member.manifest.faiPath ?? '');
    const expectedGff = resolvePath(admission.generationRoot, member.manifest.gffPath ?? '');
    const expectedTbi = resolvePath(admission.generationRoot, member.manifest.tbiPath ?? '');
    return (
      chromosome?.chrom === member.chrom &&
      chromosome.length === member.lengthBp &&
      resolvePath(chromosome.sourcePath ?? '') === expectedGff &&
      manifest?.chrom === member.chrom &&
      manifest.length === member.lengthBp &&
      resolvePath(manifest.fastaPath ?? '') === expectedFasta &&
      resolvePath(manifest.faiPath ?? '') === expectedFai &&
      resolvePath(manifest.gffPath ?? '') === expectedGff &&
      resolvePath(manifest.tbiPath ?? '') === expectedTbi
    );
  });
}

export async function resealPortableSceneDiskManifestV1(input: {
  readonly disk: PortableSceneDiskManifestV1;
  readonly request: AssemblyAnnotationSceneReadRequest;
  readonly entry: PortablePreparedReferenceViewCatalogEntryV1;
  readonly legacyLayerIdentityContract?: typeof ANNOTATION_LAYER_IDENTITY_LEGACY_RAW_QUALIFIER_CONTRACT_TOKEN;
}): Promise<LocallyResealedPortableSceneManifestV1 | null> {
  const disk = input.disk;
  if (!disk.sceneManifest || !disk.scope || !disk.artifact) return null;
  const publishedManifest = disk.sceneManifest;
  const publishedScope = disk.scope;
  const publishedArtifact = disk.artifact;
  const localCompilerContractFingerprint = annotationSceneCompilerContractFingerprint(
    input.request.datasetContract,
    input.request.artifact,
    input.request.scope
  );
  const admissibleLayerIdentities: AnnotationTrackIdentityPublishedContractToken[] = [
    ANNOTATION_TRACK_IDENTITY_CONTRACT_TOKEN,
    ...ANNOTATION_TRACK_IDENTITY_PREVIOUS_CONTRACT_TOKENS,
    ...(input.legacyLayerIdentityContract ===
    ANNOTATION_LAYER_IDENTITY_LEGACY_RAW_QUALIFIER_CONTRACT_TOKEN
      ? [ANNOTATION_LAYER_IDENTITY_LEGACY_RAW_QUALIFIER_CONTRACT_TOKEN]
      : []),
  ];
  const publishedCompilerContractFingerprint =
    admissibleLayerIdentities
      .map((identity) =>
        annotationSceneCompilerContractFingerprint(
          publishedManifest.datasetContract,
          publishedArtifact,
          publishedScope,
          identity
        )
      )
      .find((fingerprint) => fingerprint === input.entry.sceneCompilerContractFingerprint) ?? null;
  if (
    disk.version !== 6 ||
    disk.assemblyId !== input.request.assemblyId ||
    disk.fingerprint !== input.entry.sourceFingerprint ||
    disk.compilerContractFingerprint !== input.entry.sceneCompilerContractFingerprint ||
    !portableSameScopeV1(disk.scope, input.request.scope) ||
    !portableSameArtifactV1(disk.artifact, input.request.artifact) ||
    !Number.isSafeInteger(disk.byteCount) ||
    (disk.byteCount as number) <= 0 ||
    disk.sceneManifest?.byteLength !== disk.byteCount ||
    disk.sceneManifest?.integrity?.payloadSha256 !== input.entry.scenePayloadSha256 ||
    disk.sceneManifest?.integrity?.contractSha256 !== input.entry.sceneContractSha256 ||
    disk.sceneManifest?.datasetContract?.datasetId !== input.request.datasetContract.datasetId ||
    disk.sceneManifest?.datasetContract?.datasetVersion !==
      input.request.datasetContract.datasetVersion ||
    publishedCompilerContractFingerprint !== input.entry.sceneCompilerContractFingerprint ||
    !localCompilerContractFingerprint
  ) {
    return null;
  }
  const manifest = await resealPartitionedTranscriptSceneBinaryDatasetContractV4(
    publishedManifest,
    input.request.datasetContract
  );
  if (
    manifest.integrity.payloadSha256 !== input.entry.scenePayloadSha256 ||
    annotationSceneCompilerContractFingerprint(
      manifest.datasetContract,
      disk.artifact,
      disk.scope
    ) !== localCompilerContractFingerprint
  ) {
    return null;
  }
  let detailRangeCatalog: PartitionedTranscriptSceneRangeCatalogV1 | undefined;
  if (disk.detailRangeCatalog) {
    detailRangeCatalog = resealPartitionedTranscriptSceneRangeCatalogV1(
      disk.detailRangeCatalog,
      publishedManifest,
      manifest
    );
  }
  return Object.freeze({
    disk: disk as ValidPortableSceneDiskManifestV1,
    publishedManifest,
    manifest,
    compilerContractFingerprint: localCompilerContractFingerprint,
    ...(detailRangeCatalog ? { detailRangeCatalog } : {}),
  });
}

export function portableLocalCompactInteractionManifestV1(
  entry: PortablePreparedReferenceViewCatalogEntryV1,
  localScene: LocallyResealedPortableSceneManifestV1
): CompiledBroadAnnotationInteractionBinaryManifestV1 | null {
  const publishedCompact = entry.compiledBroadInteractionManifest;
  if (
    !publishedCompact ||
    publishedCompact.sourceScene.payloadSha256 !==
      localScene.publishedManifest.integrity.payloadSha256 ||
    publishedCompact.sourceScene.contractSha256 !==
      localScene.publishedManifest.integrity.contractSha256 ||
    publishedCompact.sourceScene.byteLength !== localScene.publishedManifest.byteLength ||
    publishedCompact.datasetContract.datasetId !==
      localScene.publishedManifest.datasetContract.datasetId ||
    publishedCompact.datasetContract.datasetVersion !==
      localScene.publishedManifest.datasetContract.datasetVersion ||
    publishedCompact.datasetContract.sourceSha256 !==
      localScene.publishedManifest.datasetContract.sourceSha256 ||
    publishedCompact.integrity.payloadSha256 !== entry.compiledBroadInteractionPayloadSha256
  ) {
    return null;
  }
  return {
    ...publishedCompact,
    sourceScene: {
      schema: localScene.manifest.schema,
      payloadSha256: localScene.manifest.integrity.payloadSha256,
      contractSha256: localScene.manifest.integrity.contractSha256,
      byteLength: localScene.manifest.byteLength,
    },
    datasetContract: { ...localScene.manifest.datasetContract },
    assemblyContract: { ...localScene.manifest.assemblyContract },
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
    throw new Error(`${label} fields are invalid.`);
  }
}

import { joinProjectPath } from './reference-catalog';

export const REFERENCE_ASSET_PUBLICATION_V1 = 'reference-asset-publication.v1' as const;
export const REFERENCE_ASSET_PUBLICATION_FILE = 'current-reference-assets.v1.json';
export const REFERENCE_ASSET_PRODUCT_LAYOUT_V1 = 'reference-asset-product-layout.v1' as const;
export const REFERENCE_ASSET_PRODUCT_MANIFEST_V2 =
  'assembly-annotation-product-set-manifest.v2' as const;
export const REFERENCE_ASSET_PRODUCT_STORAGE_SHARED_V1 = 'assembly-cache-root.v1' as const;
export const REFERENCE_ASSET_PRODUCT_STORAGE_GENERATION_V1 =
  'publication-generation-root.v1' as const;

export interface ReferenceAssetRequiredAnnotationProductV1 {
  readonly assemblyId: string;
  readonly themeMode: 'light' | 'dark';
  readonly sourceFingerprint: string;
  readonly inventoryFingerprint: string;
}

export interface ReferenceAssetProductLayoutV1 {
  readonly contract: typeof REFERENCE_ASSET_PRODUCT_LAYOUT_V1;
  readonly productManifestContract: typeof REFERENCE_ASSET_PRODUCT_MANIFEST_V2;
  readonly storage:
    | typeof REFERENCE_ASSET_PRODUCT_STORAGE_SHARED_V1
    | typeof REFERENCE_ASSET_PRODUCT_STORAGE_GENERATION_V1;
  readonly completeness: 'complete';
  readonly requiredAnnotationProducts: readonly ReferenceAssetRequiredAnnotationProductV1[];
}

export interface ReferenceAssetPublicationV1 {
  readonly contract: typeof REFERENCE_ASSET_PUBLICATION_V1;
  readonly assetCacheKey: string;
  readonly publicationId: string;
  readonly sourceMaterializationFingerprint: string;
  readonly publishedAtMs: number;
  readonly productLayout?: ReferenceAssetProductLayoutV1;
}

export interface CurrentReferenceAssetPublicationV1 {
  readonly publication: ReferenceAssetPublicationV1;
  readonly sourceGenerationRoot: string;
  readonly productWorkspaceRoot: string;
}

export function parseReferenceAssetPublicationV1(
  value: unknown,
  expectedAssetCacheKey: string
): ReferenceAssetPublicationV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.contract !== REFERENCE_ASSET_PUBLICATION_V1 ||
    candidate.assetCacheKey !== expectedAssetCacheKey ||
    typeof candidate.publicationId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(candidate.publicationId) ||
    typeof candidate.sourceMaterializationFingerprint !== 'string' ||
    !/^[0-9a-f]{64}$/.test(candidate.sourceMaterializationFingerprint) ||
    typeof candidate.publishedAtMs !== 'number' ||
    !Number.isSafeInteger(candidate.publishedAtMs) ||
    candidate.publishedAtMs <= 0
  ) {
    return null;
  }
  const productLayout =
    candidate.productLayout === undefined
      ? undefined
      : parseReferenceAssetProductLayoutV1(candidate.productLayout);
  if (candidate.productLayout !== undefined && !productLayout) return null;
  return {
    ...(candidate as unknown as ReferenceAssetPublicationV1),
    ...(productLayout ? { productLayout } : {}),
  };
}

export function createReferenceAssetProductLayoutV1(
  requiredAnnotationProducts: readonly ReferenceAssetRequiredAnnotationProductV1[],
  storage:
    | typeof REFERENCE_ASSET_PRODUCT_STORAGE_SHARED_V1
    | typeof REFERENCE_ASSET_PRODUCT_STORAGE_GENERATION_V1 = REFERENCE_ASSET_PRODUCT_STORAGE_SHARED_V1
): ReferenceAssetProductLayoutV1 {
  const layout: ReferenceAssetProductLayoutV1 = {
    contract: REFERENCE_ASSET_PRODUCT_LAYOUT_V1,
    productManifestContract: REFERENCE_ASSET_PRODUCT_MANIFEST_V2,
    storage,
    completeness: 'complete',
    requiredAnnotationProducts: [...requiredAnnotationProducts].sort((left, right) =>
      `${left.assemblyId}:${left.themeMode}`.localeCompare(`${right.assemblyId}:${right.themeMode}`)
    ),
  };
  const parsed = parseReferenceAssetProductLayoutV1(layout);
  if (!parsed) throw new Error('Reference asset product layout is incomplete or invalid.');
  return parsed;
}

export function requiredReferenceAssetAnnotationProductV1(
  publication: ReferenceAssetPublicationV1,
  assemblyId: string,
  themeMode: 'light' | 'dark'
): ReferenceAssetRequiredAnnotationProductV1 | null {
  return (
    publication.productLayout?.requiredAnnotationProducts.find(
      (product) => product.assemblyId === assemblyId && product.themeMode === themeMode
    ) ?? null
  );
}

export function referenceAssetPublicationPath(assemblyCacheRoot: string): string {
  return joinProjectPath(assemblyCacheRoot, REFERENCE_ASSET_PUBLICATION_FILE);
}

export function referenceAssetPublicationSourceRoot(
  assemblyCacheRoot: string,
  publication: Pick<ReferenceAssetPublicationV1, 'publicationId'>
): string {
  return joinProjectPath(assemblyCacheRoot, `generations/${publication.publicationId}`);
}

export function referenceAssetPublicationProductRoot(
  assemblyCacheRoot: string,
  publication: ReferenceAssetPublicationV1
): string {
  return publication.productLayout?.storage === REFERENCE_ASSET_PRODUCT_STORAGE_GENERATION_V1
    ? referenceAssetPublicationSourceRoot(assemblyCacheRoot, publication)
    : assemblyCacheRoot;
}

export async function resolveCurrentReferenceAssetPublicationV1(input: {
  readonly assemblyCacheRoot: string;
  readonly publicationAssemblyRoot?: string;
  readonly fallbackPublicationAssemblyRoot?: string | null;
  readonly assetCacheKey: string;
  readonly readTextFile: (path: string) => Promise<string>;
}): Promise<CurrentReferenceAssetPublicationV1 | null> {
  const publicationRoots = [
    input.publicationAssemblyRoot ?? input.assemblyCacheRoot,
    input.fallbackPublicationAssemblyRoot,
  ].filter((root, index, roots): root is string => Boolean(root) && roots.indexOf(root) === index);
  for (const publicationRoot of publicationRoots) {
    try {
      const text = await input.readTextFile(referenceAssetPublicationPath(publicationRoot));
      const publication = parseReferenceAssetPublicationV1(
        JSON.parse(text) as unknown,
        input.assetCacheKey
      );
      if (!publication) continue;
      return {
        publication,
        sourceGenerationRoot: referenceAssetPublicationSourceRoot(
          input.assemblyCacheRoot,
          publication
        ),
        productWorkspaceRoot: referenceAssetPublicationProductRoot(
          input.assemblyCacheRoot,
          publication
        ),
      };
    } catch {}
  }
  return null;
}

function parseReferenceAssetProductLayoutV1(value: unknown): ReferenceAssetProductLayoutV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.contract !== REFERENCE_ASSET_PRODUCT_LAYOUT_V1 ||
    candidate.productManifestContract !== REFERENCE_ASSET_PRODUCT_MANIFEST_V2 ||
    (candidate.storage !== REFERENCE_ASSET_PRODUCT_STORAGE_SHARED_V1 &&
      candidate.storage !== REFERENCE_ASSET_PRODUCT_STORAGE_GENERATION_V1) ||
    candidate.completeness !== 'complete' ||
    !Array.isArray(candidate.requiredAnnotationProducts) ||
    candidate.requiredAnnotationProducts.length === 0
  ) {
    return null;
  }
  const products: ReferenceAssetRequiredAnnotationProductV1[] = [];
  const keys = new Set<string>();
  const themesByAssembly = new Map<string, Set<'light' | 'dark'>>();
  const sourceFingerprintByAssembly = new Map<string, string>();
  for (const value of candidate.requiredAnnotationProducts) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const product = value as Record<string, unknown>;
    if (
      typeof product.assemblyId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(product.assemblyId) ||
      (product.themeMode !== 'light' && product.themeMode !== 'dark') ||
      typeof product.sourceFingerprint !== 'string' ||
      !/^[0-9a-f]{24}$/.test(product.sourceFingerprint) ||
      typeof product.inventoryFingerprint !== 'string' ||
      !/^[0-9a-f]{64}$/.test(product.inventoryFingerprint)
    ) {
      return null;
    }
    const key = `${product.assemblyId}:${product.themeMode}`;
    if (keys.has(key)) return null;
    keys.add(key);
    const themeMode = product.themeMode;
    const themes = themesByAssembly.get(product.assemblyId) ?? new Set<'light' | 'dark'>();
    themes.add(themeMode);
    themesByAssembly.set(product.assemblyId, themes);
    const priorSourceFingerprint = sourceFingerprintByAssembly.get(product.assemblyId);
    if (
      priorSourceFingerprint !== undefined &&
      priorSourceFingerprint !== product.sourceFingerprint
    ) {
      return null;
    }
    sourceFingerprintByAssembly.set(product.assemblyId, product.sourceFingerprint);
    products.push({
      assemblyId: product.assemblyId,
      themeMode,
      sourceFingerprint: product.sourceFingerprint,
      inventoryFingerprint: product.inventoryFingerprint,
    });
  }
  if ([...themesByAssembly.values()].some((themes) => !themes.has('light'))) {
    return null;
  }
  return {
    contract: REFERENCE_ASSET_PRODUCT_LAYOUT_V1,
    productManifestContract: REFERENCE_ASSET_PRODUCT_MANIFEST_V2,
    storage: candidate.storage,
    completeness: 'complete',
    requiredAnnotationProducts: products.sort((left, right) =>
      `${left.assemblyId}:${left.themeMode}`.localeCompare(`${right.assemblyId}:${right.themeMode}`)
    ),
  };
}

export const LOCAL_REFERENCE_ASSEMBLY_ID_PREFIX = 'local-';

export function isLocalReferenceAssemblyId(assemblyId: string): boolean {
  return assemblyId.startsWith(LOCAL_REFERENCE_ASSEMBLY_ID_PREFIX);
}

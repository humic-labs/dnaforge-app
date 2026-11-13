import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ReferenceVersionIdentity } from '../../shared/reference-content-identity';
import { ANNOTATION_LAYER_IDENTITY_LEGACY_RAW_QUALIFIER_CONTRACT_TOKEN } from '../../features/sequence/annotation-layer-identity';
import type { HostedReferenceCatalogDefinitionV1 } from './hosted-reference-catalog';
import type { PortablePreparedReferenceHydrator } from './portable-prepared-reference-hydrator';
import { portablePreparedReferenceContentObjectKeyV1 } from './portable-prepared-reference-bundle';
import { readPreparedReferenceProductRepairInput } from './prepared-reference-library';
import { resolveCurrentReferenceAssetPublicationV1 } from '../../features/sequence/reference-asset-publication';

const SHA256 = /^[0-9a-f]{64}$/;
const HISTORY = '.reference-version-history';

const RETIRED_LEGACY_LAYER_IDENTITY_BUNDLE_MANIFESTS: ReadonlySet<string> = new Set([
  'b0ded75b20e8f710de10d1526eb43f95ae767782483f3b7d18b8f53b9c4b9063',
]);

export function installedBundleLegacyLayerIdentityContract(
  definition: HostedReferenceCatalogDefinitionV1,
  installedManifestSha256: string
): typeof ANNOTATION_LAYER_IDENTITY_LEGACY_RAW_QUALIFIER_CONTRACT_TOKEN | undefined {
  if (definition.preparedBundle?.manifest.sha256 === installedManifestSha256) {
    return definition.preparedBundle.legacyLayerIdentityContract;
  }
  return (
    definition.preparedBundle?.legacyLayerIdentityContract ??
    (RETIRED_LEGACY_LAYER_IDENTITY_BUNDLE_MANIFESTS.has(installedManifestSha256)
      ? ANNOTATION_LAYER_IDENTITY_LEGACY_RAW_QUALIFIER_CONTRACT_TOKEN
      : undefined)
  );
}

export async function inspectInstalledHostedReference(input: {
  readonly cacheRoot: string;
  readonly publicationRoot: string;
  readonly fallbackPublicationRoot: string | null;
  readonly definition: HostedReferenceCatalogDefinitionV1;
  readonly hydrator: PortablePreparedReferenceHydrator;
}) {
  const prepared = await readPreparedReferenceProductRepairInput(
    input.cacheRoot,
    input.definition.id,
    input.publicationRoot,
    input.fallbackPublicationRoot
  );
  if (!prepared) return null;
  const familyRoot = join(input.cacheRoot, input.definition.id);
  const current = await resolveCurrentReferenceAssetPublicationV1({
    assemblyCacheRoot: familyRoot,
    publicationAssemblyRoot: join(input.publicationRoot, input.definition.id),
    fallbackPublicationAssemblyRoot: input.fallbackPublicationRoot
      ? join(input.fallbackPublicationRoot, input.definition.id)
      : null,
    assetCacheKey: input.definition.id,
    readTextFile: (path) => readFile(path, 'utf8'),
  });
  if (!current || !SHA256.test(current.publication.publicationId)) return null;
  for (const name of ['detail.v2.json', 'shell.v2.json', 'first-view-pack-admission.v1.json']) {
    try {
      const marker = JSON.parse(
        await readFile(join(current.sourceGenerationRoot, '.readiness', name), 'utf8')
      ) as Record<string, unknown>;
      const digest = marker.bundleManifestSha256;
      if (
        typeof digest !== 'string' ||
        !SHA256.test(digest) ||
        marker.bundleFingerprint !== current.publication.publicationId
      )
        continue;
      const manifestPath = join(
        input.cacheRoot,
        '.portable-reference-objects',
        'sha256',
        digest.slice(0, 2),
        digest
      );
      const file = await lstat(manifestPath);
      if (!file.isFile() || file.isSymbolicLink() || file.size > 64 * 1024 * 1024) continue;
      const bytes = await readFile(manifestPath);
      if (createHash('sha256').update(bytes).digest('hex') !== digest) continue;
      const legacyLayerIdentityContract = installedBundleLegacyLayerIdentityContract(
        input.definition,
        digest
      );
      const definition: HostedReferenceCatalogDefinitionV1 = {
        ...input.definition,
        sources: {
          fasta: { ...input.definition.sources.fasta, sha256: prepared.expectedSource.fastaSha256 },
          annotations: {
            ...input.definition.sources.annotations,
            sha256: prepared.expectedSource.gffSha256 ?? '',
          },
        },
        preparedBundle: {
          ...(legacyLayerIdentityContract ? { legacyLayerIdentityContract } : {}),
          manifest: {
            relativePath: portablePreparedReferenceContentObjectKeyV1(digest),
            sha256: digest,
            byteLength: bytes.byteLength,
          },
        },
      };
      const hydration = await input.hydrator.inspectCached({
        definition,
        tiers: ['detail', 'search'],
      });
      if (
        hydration?.hydratedTiers.includes('detail') &&
        hydration.bundle.bundleFingerprint === current.publication.publicationId
      ) {
        return {
          entry: prepared.entry,
          definition,
          hydration,
          expectedSource: prepared.expectedSource,
        };
      }
    } catch {}
  }
  return null;
}

export async function readReferenceVersionHistory(
  familyRoot: string
): Promise<readonly ReferenceVersionIdentity[]> {
  const directory = join(familyRoot, HISTORY);
  const history: ReferenceVersionIdentity[] = [];
  for (const name of await readdir(directory).catch(() => [] as string[])) {
    if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
    try {
      const path = join(directory, name);
      const file = await lstat(path);
      if (!file.isFile() || file.isSymbolicLink() || file.size > 16384) continue;
      const record = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      if (
        record.bundleFingerprint !== name.slice(0, -5) ||
        typeof record.sequenceIdentity !== 'string' ||
        !SHA256.test(record.sequenceIdentity) ||
        typeof record.annotationIdentity !== 'string' ||
        !SHA256.test(record.annotationIdentity) ||
        !Array.isArray(record.assetGenerations)
      )
        continue;
      const assetGenerations = record.assetGenerations.map((value: unknown) => {
        if (!value || typeof value !== 'object' || Array.isArray(value))
          throw new Error('Invalid reference version generation.');
        const generation = value as Record<string, unknown>;
        if (
          typeof generation.sourceFingerprint !== 'string' ||
          !/^[0-9a-f]{24}$/.test(generation.sourceFingerprint) ||
          typeof generation.inventoryFingerprint !== 'string' ||
          !SHA256.test(generation.inventoryFingerprint)
        )
          throw new Error('Invalid reference version generation identity.');
        return {
          sourceFingerprint: generation.sourceFingerprint,
          inventoryFingerprint: generation.inventoryFingerprint,
        };
      });
      history.push({
        bundleFingerprint: name.slice(0, -5),
        sequenceIdentity: record.sequenceIdentity,
        annotationIdentity: record.annotationIdentity,
        assetGenerations,
      });
    } catch {}
  }
  return history;
}

export async function recordReferenceVersionIdentity(
  familyRoot: string,
  version: ReferenceVersionIdentity
): Promise<void> {
  if (!SHA256.test(version.bundleFingerprint))
    throw new Error('Invalid reference version identity.');
  const directory = join(resolve(familyRoot), HISTORY);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `${version.bundleFingerprint}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(version)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, join(directory, `${version.bundleFingerprint}.json`));
  } finally {
    const { rm } = await import('node:fs/promises');
    await rm(temporary, { force: true });
  }
}

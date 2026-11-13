import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import type { ReferenceAssemblyEntry } from '../../features/sequence/reference-catalog';
import { resolveCurrentReferenceAssetPublicationV1 } from '../../features/sequence/reference-asset-publication';
import {
  parsePreparedReferenceDefinition,
  PREPARED_REFERENCE_DEFINITION_FILE,
  preparedReferenceAssemblyEntry,
} from './reference-preparation-manifest';

const SAFE_ASSET_CACHE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface PreparedReferenceProductRepairInput {
  readonly entry: ReferenceAssemblyEntry;
  readonly expectedSource: Readonly<{
    fastaSha256: string;
    gffSha256?: string;
  }>;
}

export async function listPreparedReferenceAssemblyEntries(
  referenceAssetCacheRoot: string,
  referenceAssetPublicationRoot: string = referenceAssetCacheRoot,
  fallbackReferenceAssetPublicationRoot: string | null = referenceAssetPublicationRoot ===
  referenceAssetCacheRoot
    ? null
    : referenceAssetCacheRoot
): Promise<ReadonlyArray<ReferenceAssemblyEntry>> {
  const cacheRoot = resolve(referenceAssetCacheRoot);
  let cacheRealRoot: string;
  let families: Dirent[];
  try {
    cacheRealRoot = await realpath(cacheRoot);
    families = await readdir(cacheRoot, { withFileTypes: true, encoding: 'utf8' });
  } catch {
    return [];
  }

  const discovered: ReferenceAssemblyEntry[] = [];
  for (const family of families.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!family.isDirectory() || !SAFE_ASSET_CACHE_KEY.test(family.name)) continue;
    const prepared = await readPublishedPreparedReference({
      cacheRoot,
      cacheRealRoot,
      publicationRoot: resolve(referenceAssetPublicationRoot),
      fallbackPublicationRoot: fallbackReferenceAssetPublicationRoot
        ? resolve(fallbackReferenceAssetPublicationRoot)
        : null,
      assetCacheKey: family.name,
    });
    if (prepared) discovered.push(prepared.entry);
  }

  const idCounts = new Map<string, number>();
  for (const entry of discovered) {
    idCounts.set(entry.id, (idCounts.get(entry.id) ?? 0) + 1);
  }
  return discovered
    .filter((entry) => idCounts.get(entry.id) === 1)
    .sort((left, right) => left.id.localeCompare(right.id));
}

export async function readPreparedReferenceProductRepairInput(
  referenceAssetCacheRoot: string,
  assemblyId: string,
  referenceAssetPublicationRoot: string = referenceAssetCacheRoot,
  fallbackReferenceAssetPublicationRoot: string | null = referenceAssetPublicationRoot ===
  referenceAssetCacheRoot
    ? null
    : referenceAssetCacheRoot
): Promise<PreparedReferenceProductRepairInput | null> {
  if (!SAFE_ASSET_CACHE_KEY.test(assemblyId)) return null;
  const cacheRoot = resolve(referenceAssetCacheRoot);
  try {
    const cacheRealRoot = await realpath(cacheRoot);
    const prepared = await readPublishedPreparedReference({
      cacheRoot,
      cacheRealRoot,
      publicationRoot: resolve(referenceAssetPublicationRoot),
      fallbackPublicationRoot: fallbackReferenceAssetPublicationRoot
        ? resolve(fallbackReferenceAssetPublicationRoot)
        : null,
      assetCacheKey: assemblyId,
    });
    if (!prepared || prepared.entry.id !== assemblyId) return null;
    return prepared;
  } catch {
    return null;
  }
}

async function readPublishedPreparedReference(input: {
  readonly cacheRoot: string;
  readonly cacheRealRoot: string;
  readonly publicationRoot: string;
  readonly fallbackPublicationRoot: string | null;
  readonly assetCacheKey: string;
}): Promise<PreparedReferenceProductRepairInput | null> {
  try {
    const familyRoot = resolve(input.cacheRoot, input.assetCacheKey);
    const familyRealRoot = await realpath(familyRoot);
    if (!pathIsAtOrBelow(input.cacheRealRoot, familyRealRoot)) return null;

    const current = await resolveCurrentReferenceAssetPublicationV1({
      assemblyCacheRoot: familyRoot,
      publicationAssemblyRoot: resolve(input.publicationRoot, input.assetCacheKey),
      fallbackPublicationAssemblyRoot: input.fallbackPublicationRoot
        ? resolve(input.fallbackPublicationRoot, input.assetCacheKey)
        : null,
      assetCacheKey: input.assetCacheKey,
      readTextFile: (path) => readFile(path, 'utf8'),
    });
    if (!current) return null;

    const sourceGenerationRoot = resolve(current.sourceGenerationRoot);
    const sourceGenerationStat = await lstat(sourceGenerationRoot);
    if (!sourceGenerationStat.isDirectory() || sourceGenerationStat.isSymbolicLink()) return null;
    const sourceGenerationRealRoot = await realpath(sourceGenerationRoot);
    if (!pathIsAtOrBelow(familyRealRoot, sourceGenerationRealRoot)) return null;

    const definitionPath = resolve(sourceGenerationRoot, PREPARED_REFERENCE_DEFINITION_FILE);
    if (!pathIsAtOrBelow(sourceGenerationRoot, definitionPath)) return null;
    const definitionStat = await lstat(definitionPath);
    if (!definitionStat.isFile() || definitionStat.isSymbolicLink()) return null;
    const definitionRealPath = await realpath(definitionPath);
    if (!pathIsAtOrBelow(sourceGenerationRealRoot, definitionRealPath)) return null;

    const definition = parsePreparedReferenceDefinition(
      JSON.parse(await readFile(definitionPath, 'utf8')) as unknown,
      input.assetCacheKey
    );
    return {
      entry: preparedReferenceAssemblyEntry(definition),
      expectedSource: {
        fastaSha256: definition.source.fastaSha256,
        ...(definition.source.gffSha256 ? { gffSha256: definition.source.gffSha256 } : {}),
      },
    };
  } catch {
    return null;
  }
}

function pathIsAtOrBelow(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return (
    relativePath === '' ||
    (!isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${sep}`))
  );
}

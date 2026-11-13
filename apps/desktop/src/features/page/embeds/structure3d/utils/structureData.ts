import { fetchStructureBytes, type StructureByteFormat } from '../api/structure-service-client';
import {
  getCachedStructure,
  getCachedStructureAlias,
  cacheStructure,
  cacheStructureAlias,
} from './structureDataCache';

type StructureProvider = 'rcsb' | 'alphafold';

export interface StructureFetchIdentity {
  provider: StructureProvider;
  externalId: string;
  fetchExternalId?: string;
  format?: StructureByteFormat;
  pdbId?: string;
  pdbEntityId?: string;
  labelAsymIds?: string[];
  authAsymIds?: string[];
  assemblyId?: string;
  accession?: string;
  fragment?: string;
  version?: string;
  modelId?: string;
}

interface StructureByteIdentity {
  provider: StructureProvider;
  externalId: string;
  fetchExternalId?: string;
  format: StructureByteFormat;
  cacheIdentity: string;
  pdbId?: string;
  pdbEntityId?: string;
  labelAsymIds?: string[];
  authAsymIds?: string[];
  assemblyId?: string;
  accession?: string;
  fragment?: string;
  version?: string;
  modelId?: string;
}

function identityForProviderId(
  id: string | StructureFetchIdentity,
  provider: StructureProvider
): StructureByteIdentity {
  if (typeof id !== 'string') {
    if (id.provider !== provider) {
      throw new Error(`Structure provider mismatch: expected ${provider}, received ${id.provider}`);
    }
    return identityForScopedProvider(id);
  }
  const raw = id.trim();
  if (provider === 'rcsb') {
    const normalized = raw.toUpperCase();
    return identityForScopedProvider({
      provider,
      externalId: normalized.startsWith('RCSB:') ? normalized : `RCSB:${normalized}:ENTRY`,
    });
  }
  const isScopedAlphaFoldIdentity = /^AF:/i.test(raw);
  return identityForScopedProvider({
    provider,
    externalId: isScopedAlphaFoldIdentity ? raw : `AF:${raw.toUpperCase()}:F1:LATEST`,
  });
}

function isMutableAlphaFoldIdentity(identity: StructureByteIdentity): boolean {
  return identity.provider === 'alphafold' && identity.version === 'LATEST';
}

function identityForScopedProvider(input: StructureFetchIdentity): StructureByteIdentity {
  const format = input.format ?? 'mmcif';
  if (input.provider === 'rcsb') {
    const parsed = parseRcsbExternalId(input.externalId);
    const pdbId = mergeScopeValue(input.pdbId, parsed?.pdbId, 'pdbId')?.toUpperCase();
    if (!pdbId) {
      throw new Error(`Invalid RCSB structure identity: ${input.externalId}`);
    }
    const pdbEntityId = mergeScopeValue(input.pdbEntityId, parsed?.pdbEntityId, 'pdbEntityId');
    const labelAsymIds = mergeScopeList(input.labelAsymIds, parsed?.labelAsymIds, 'labelAsymIds');
    const authAsymIds = mergeScopeList(input.authAsymIds, parsed?.authAsymIds, 'authAsymIds');
    const assemblyId = mergeScopeValue(input.assemblyId, parsed?.assemblyId, 'assemblyId');
    const externalId = rcsbProviderIdentityKey({
      pdbId,
      pdbEntityId,
      labelAsymIds,
      authAsymIds,
      assemblyId,
    });
    const fetchExternalId = normalizeRcsbFetchExternalId(input.fetchExternalId, pdbId);
    return {
      provider: 'rcsb',
      externalId,
      ...(fetchExternalId ? { fetchExternalId } : {}),
      format,
      cacheIdentity: cacheIdentityForFormat(externalId, format),
      pdbId,
      pdbEntityId,
      labelAsymIds,
      authAsymIds,
      assemblyId,
    };
  }
  const parsed = parseAlphaFoldExternalId(input.externalId);
  const accession = mergeScopeValue(input.accession, parsed?.accession, 'accession')?.toUpperCase();
  if (!accession) {
    throw new Error(`Invalid AlphaFold structure identity: ${input.externalId}`);
  }
  const fragment =
    mergeScopeValue(input.fragment, parsed?.fragment, 'fragment')?.toUpperCase() ?? 'F1';
  const version =
    mergeScopeValue(input.version, parsed?.version, 'version')?.toUpperCase() ?? 'LATEST';
  const rawModelId = mergeScopeValue(input.modelId, parsed?.modelId, 'modelId');
  let modelId: string | undefined;
  if (rawModelId) {
    const normalizedModelId = normalizeAlphaFoldModelId(rawModelId);
    if (!normalizedModelId) {
      throw new Error(`Invalid AlphaFold model identity: ${rawModelId}`);
    }
    const modelScope = parseAlphaFoldModelId(normalizedModelId);
    if (
      modelScope.accession !== accession ||
      modelScope.fragment !== fragment ||
      (version !== 'LATEST' && modelScope.version !== version)
    ) {
      throw new Error(`AlphaFold model identity does not match scoped structure identity`);
    }
    modelId = normalizedModelId;
  } else if (version !== 'LATEST') {
    modelId = `AF-${accession}-${fragment}-model_v${version.slice(1)}`;
  }
  const externalId = alphaFoldProviderIdentityKey({ accession, fragment, version, modelId });
  const fetchExternalId = normalizeAlphaFoldFetchExternalId(input.fetchExternalId, accession);
  return {
    provider: 'alphafold',
    externalId,
    ...(fetchExternalId ? { fetchExternalId } : {}),
    format,
    cacheIdentity: cacheIdentityForFormat(externalId, format),
    accession,
    fragment,
    version,
    modelId,
  };
}

function normalizeRcsbFetchExternalId(
  fetchExternalId: string | undefined,
  requestPdbId: string
): string | undefined {
  const raw = fetchExternalId?.trim();
  if (!raw) return undefined;
  const parsed = parseRcsbExternalId(raw);
  if (!parsed?.pdbId) {
    throw new Error(`Invalid RCSB fetch structure identity: ${raw}`);
  }
  if (parsed.pdbId.toUpperCase() !== requestPdbId.toUpperCase()) {
    throw new Error(`RCSB fetch identity does not match scoped structure identity`);
  }
  return rcsbProviderIdentityKey({
    pdbId: parsed.pdbId,
    pdbEntityId: parsed.pdbEntityId,
    labelAsymIds: parsed.labelAsymIds,
    authAsymIds: parsed.authAsymIds,
    assemblyId: parsed.assemblyId,
  });
}

function normalizeAlphaFoldFetchExternalId(
  fetchExternalId: string | undefined,
  requestAccession: string
): string | undefined {
  const raw = fetchExternalId?.trim();
  if (!raw) return undefined;
  const parsed = parseAlphaFoldExternalId(raw);
  if (!parsed?.accession) {
    throw new Error(`Invalid AlphaFold fetch structure identity: ${raw}`);
  }
  if (parsed.accession.toUpperCase() !== requestAccession.toUpperCase()) {
    throw new Error(`AlphaFold fetch identity does not match scoped structure identity`);
  }
  return alphaFoldProviderIdentityKey(parsed);
}

export function structureFetchIdentityCacheIdentity(input: StructureFetchIdentity): string {
  return identityForScopedProvider(input).cacheIdentity;
}

interface ParsedRcsbExternalId {
  pdbId: string;
  pdbEntityId?: string;
  labelAsymIds?: string[];
  authAsymIds?: string[];
  assemblyId?: string;
}

function parseRcsbExternalId(externalId: string): ParsedRcsbExternalId | null {
  const stripped = externalId.trim();
  const compactRcsb = stripped.match(
    /^([0-9][A-Za-z0-9]{3})(?:\/([A-Za-z0-9,]+))?(?:#([A-Za-z0-9]+))?$/
  );
  if (compactRcsb) {
    return {
      pdbId: compactRcsb[1].toUpperCase(),
      authAsymIds: compactRcsb[2] ? parseRcsbScopeTokens(compactRcsb[2], externalId) : undefined,
      pdbEntityId: compactRcsb[3]?.toUpperCase(),
    };
  }
  const parts = stripped.split(':');
  if (parts.length < 3 || parts[0].toUpperCase() !== 'RCSB' || parts[2].toUpperCase() !== 'ENTRY')
    return null;
  const pdbId = parts[1].toUpperCase();
  if (!/^[0-9][A-Z0-9]{3}$/.test(pdbId)) return null;
  const parsed: ParsedRcsbExternalId = { pdbId };
  const seen = new Set<string>();
  for (let index = 3; index < parts.length; index += 2) {
    if (index + 1 >= parts.length) {
      throw new Error(`Invalid RCSB structure identity: ${externalId}`);
    }
    const key = parts[index].toUpperCase();
    const value = parts[index + 1];
    if (seen.has(key)) {
      throw new Error(`Duplicate RCSB scope ${key} in structure identity`);
    }
    seen.add(key);
    if (key === 'ASSEMBLY') parsed.assemblyId = value.toUpperCase();
    else if (key === 'ENTITY') parsed.pdbEntityId = value.toUpperCase();
    else if (key === 'LABEL_ASYM') parsed.labelAsymIds = parseRcsbScopeTokens(value, externalId);
    else if (key === 'AUTH_ASYM') parsed.authAsymIds = parseRcsbScopeTokens(value, externalId);
    else throw new Error(`Unsupported RCSB scope ${key} in structure identity`);
  }
  return parsed;
}

function parseRcsbScopeTokens(value: string, externalId: string): string[] {
  const tokens = value.split(',');
  if (tokens.some((token) => token.trim() === '')) {
    throw new Error(`Invalid RCSB structure identity: ${externalId}`);
  }
  const canonical = canonicalScopeTokens(tokens);
  if (canonical.length !== tokens.length) {
    throw new Error(`Duplicate RCSB scope token in structure identity: ${externalId}`);
  }
  return tokens;
}

interface ParsedAlphaFoldExternalId {
  accession: string;
  fragment: string;
  version: string;
  modelId?: string;
}

function parseAlphaFoldExternalId(externalId: string): ParsedAlphaFoldExternalId | null {
  const parts = externalId.trim().split(':');
  if (parts[0].toUpperCase() !== 'AF') return null;
  if (parts.length < 4) throw new Error(`Invalid AlphaFold structure identity: ${externalId}`);
  const accession = parts[1].toUpperCase();
  const fragment = parts[2].toUpperCase();
  const version = parts[3].toUpperCase();
  if (!/^F[1-9][0-9]*$/.test(fragment) || !/^(?:LATEST|V[1-9][0-9]*)$/.test(version)) {
    throw new Error(`Invalid AlphaFold structure identity: ${externalId}`);
  }
  if (parts.length === 4) {
    return { accession, fragment, version };
  }
  if (parts.length === 6 && parts[4].toUpperCase() === 'MODEL') {
    const modelId = normalizeAlphaFoldModelId(parts[5]);
    if (!modelId) return null;
    const modelScope = parseAlphaFoldModelId(modelId);
    if (
      modelScope.accession !== accession ||
      modelScope.fragment !== fragment ||
      (version !== 'LATEST' && modelScope.version !== version)
    ) {
      throw new Error(`AlphaFold model identity does not match scoped structure identity`);
    }
    return { accession, fragment, version, modelId };
  }
  throw new Error(`Invalid AlphaFold structure identity: ${externalId}`);
}

function normalizeAlphaFoldModelId(value: string): string | null {
  const match = value.match(/^AF-([A-Za-z0-9]+)-(F[1-9][0-9]*)-model_v([1-9][0-9]*)$/);
  if (!match) return null;
  return `AF-${match[1].toUpperCase()}-${match[2].toUpperCase()}-model_v${match[3]}`;
}

function parseAlphaFoldModelId(modelId: string): {
  accession: string;
  fragment: string;
  version: string;
} {
  const match = modelId.match(/^AF-([A-Z0-9]+)-(F[1-9][0-9]*)-model_v([1-9][0-9]*)$/);
  if (!match) {
    throw new Error(`Invalid AlphaFold model identity: ${modelId}`);
  }
  return {
    accession: match[1],
    fragment: match[2],
    version: `V${match[3]}`,
  };
}

function mergeScopeValue(
  explicit: string | undefined,
  scoped: string | undefined,
  field: string
): string | undefined {
  const explicitValue = explicit?.trim();
  const scopedValue = scoped?.trim();
  if (explicitValue && scopedValue && explicitValue.toUpperCase() !== scopedValue.toUpperCase()) {
    throw new Error(`${field} does not match scoped structure identity`);
  }
  return explicitValue || scopedValue || undefined;
}

function mergeScopeList(
  explicit: string[] | undefined,
  scoped: string[] | undefined,
  field: string
): string[] | undefined {
  const explicitValues = canonicalScopeTokens(explicit ?? []);
  const scopedValues = canonicalScopeTokens(scoped ?? []);
  if (explicitValues.length > 0 && scopedValues.length > 0) {
    if (explicitValues.join(',') !== scopedValues.join(',')) {
      throw new Error(`${field} does not match scoped structure identity`);
    }
  }
  const merged = explicitValues.length > 0 ? explicitValues : scopedValues;
  return merged.length > 0 ? merged : undefined;
}

function rcsbProviderIdentityKey({
  pdbId,
  pdbEntityId,
  labelAsymIds,
  authAsymIds,
  assemblyId,
}: {
  pdbId: string;
  pdbEntityId?: string;
  labelAsymIds?: string[];
  authAsymIds?: string[];
  assemblyId?: string;
}): string {
  const parts = [`RCSB:${pdbId.toUpperCase()}:ENTRY`];
  if (assemblyId) parts.push(`ASSEMBLY:${assemblyId}`);
  if (pdbEntityId) parts.push(`ENTITY:${pdbEntityId}`);
  if (labelAsymIds?.length)
    parts.push(`LABEL_ASYM:${canonicalScopeTokens(labelAsymIds).join(',')}`);
  if (authAsymIds?.length) parts.push(`AUTH_ASYM:${canonicalScopeTokens(authAsymIds).join(',')}`);
  return parts.join(':');
}

function alphaFoldProviderIdentityKey({
  accession,
  fragment,
  version,
  modelId,
}: {
  accession: string;
  fragment: string;
  version: string;
  modelId?: string;
}): string {
  const base = `AF:${accession.toUpperCase()}:${fragment.toUpperCase()}:${version.toUpperCase()}`;
  return modelId ? `${base}:MODEL:${modelId}` : base;
}

function canonicalScopeTokens(tokens: string[]): string[] {
  return [...new Set(tokens.map((token) => token.trim()).filter(Boolean))].sort();
}

async function getCacheKey(identity: StructureByteIdentity): Promise<string> {
  return `structure-bytes:v2:${await sha256Hex(identity.cacheIdentity)}`;
}

function cacheIdentityForFormat(externalId: string, format: StructureByteFormat): string {
  return format === 'pdb' ? `${externalId}:pdb` : externalId;
}

async function sha256Hex(input: string): Promise<string> {
  const buffer = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function fetchStructureData(
  id: string | StructureFetchIdentity,
  provider: StructureProvider,
  signal?: AbortSignal
): Promise<{ data: string; format: 'mmcif' | 'pdb' }> {
  const identity = identityForProviderId(id, provider);
  const cacheKey = await getCacheKey(identity);
  const fetchIdentity = identityForByteFetch(identity);

  if (isMutableAlphaFoldIdentity(identity)) {
    const aliasedCacheKey = await getCachedStructureAlias(cacheKey);
    if (aliasedCacheKey) {
      const cached = await getCachedStructure(aliasedCacheKey);
      if (cached) {
        console.log(`[structureData] Cache hit for ${cacheKey} via ${aliasedCacheKey}`);
        return cached;
      }
    }
  } else {
    const cached = await getCachedStructure(cacheKey);
    if (cached) {
      console.log(`[structureData] Cache hit for ${cacheKey}`);
      return cached;
    }
  }

  console.log(`[structureData] Cache miss for ${cacheKey}, fetching from network...`);

  const fetchInput = {
    provider: fetchIdentity.provider,
    externalId: fetchIdentity.externalId,
    format: fetchIdentity.format,
    pdbId: fetchIdentity.pdbId,
    pdbEntityId: fetchIdentity.pdbEntityId,
    labelAsymIds: fetchIdentity.labelAsymIds,
    authAsymIds: fetchIdentity.authAsymIds,
    assemblyId: fetchIdentity.assemblyId,
    accession: fetchIdentity.accession,
    fragment: fetchIdentity.fragment,
    version: fetchIdentity.version,
    modelId: fetchIdentity.modelId,
  };
  const result = signal
    ? await fetchStructureBytes(fetchInput, signal)
    : await fetchStructureBytes(fetchInput);
  const format = asStructureFormat(result.format);
  const responseIdentity =
    result.externalId && result.externalId !== fetchIdentity.externalId
      ? identityForScopedProvider({
          provider: fetchIdentity.provider,
          externalId: result.externalId,
          format,
        })
      : { ...fetchIdentity, format };
  assertCompatibleResponseIdentity(fetchIdentity, responseIdentity);
  const responseCacheKey = await getCacheKey(responseIdentity);

  cacheResolvedStructure(
    identity,
    cacheKey,
    responseIdentity,
    responseCacheKey,
    result.data,
    format
  ).catch((err) => {
    console.warn('[structureData] Failed to cache structure:', err);
  });

  return {
    data: result.data,
    format,
  };
}

function identityForByteFetch(identity: StructureByteIdentity): StructureByteIdentity {
  if (!identity.fetchExternalId) return identity;
  return identityForScopedProvider({
    provider: identity.provider,
    externalId: identity.fetchExternalId,
    format: identity.format,
  });
}

async function cacheResolvedStructure(
  requestIdentity: StructureByteIdentity,
  requestCacheKey: string,
  responseIdentity: StructureByteIdentity,
  responseCacheKey: string,
  data: string,
  format: StructureByteFormat
): Promise<void> {
  if (isMutableAlphaFoldIdentity(responseIdentity)) {
    return;
  }
  await cacheStructure(responseCacheKey, data, format);
  if (requestCacheKey !== responseCacheKey || isMutableAlphaFoldIdentity(requestIdentity)) {
    await cacheStructureAlias(requestCacheKey, responseCacheKey);
  }
}

function assertCompatibleResponseIdentity(
  request: StructureByteIdentity,
  response: StructureByteIdentity
): void {
  if (request.provider !== response.provider) {
    throw new Error(
      `Structure byte response provider ${response.provider} does not match requested ${request.provider}`
    );
  }
  if (request.provider === 'rcsb') {
    if (request.externalId !== response.externalId) {
      throw new Error(
        `RCSB byte response identity ${response.externalId} does not match requested ${request.externalId}`
      );
    }
    return;
  }
  if (request.accession !== response.accession || request.fragment !== response.fragment) {
    throw new Error(
      `AlphaFold byte response identity ${response.externalId} does not match requested ${request.externalId}`
    );
  }
  if (request.version !== 'LATEST' && request.version !== response.version) {
    throw new Error(
      `AlphaFold byte response version ${response.version} does not match requested ${request.version}`
    );
  }
  if (request.modelId && request.modelId !== response.modelId) {
    throw new Error(
      `AlphaFold byte response model ${response.modelId} does not match requested ${request.modelId}`
    );
  }
}

function asStructureFormat(format: unknown): StructureByteFormat {
  if (format === 'pdb' || format === 'mmcif') {
    return format;
  }
  throw new Error(`Expected a structure format, received ${format}`);
}

export async function fetchStructureFromUrl(
  url: string,
  signal?: AbortSignal
): Promise<{ data: string; format: 'mmcif' | 'pdb' }> {
  const parsed = parseKnownStructureUrl(url);
  if (!parsed) {
    throw new Error(
      'Unsupported structure URL. Use a saved cache entry or upload a structure file.'
    );
  }
  const cacheKey = await getCacheKey(parsed);

  const cached = await getCachedStructure(cacheKey);
  if (cached) {
    console.log(`[structureData] Cache hit for URL: ${url}`);
    return cached;
  }

  console.log(`[structureData] Cache miss for URL, fetching: ${url}`);

  const fetchInput = {
    provider: parsed.provider,
    externalId: parsed.externalId,
    format: parsed.format,
    pdbId: parsed.pdbId,
    pdbEntityId: parsed.pdbEntityId,
    labelAsymIds: parsed.labelAsymIds,
    authAsymIds: parsed.authAsymIds,
    assemblyId: parsed.assemblyId,
    accession: parsed.accession,
    fragment: parsed.fragment,
    version: parsed.version,
    modelId: parsed.modelId,
  };
  const result = signal
    ? await fetchStructureBytes(fetchInput, signal)
    : await fetchStructureBytes(fetchInput);
  const format = asStructureFormat(result.format);
  const responseIdentity =
    result.externalId && result.externalId !== parsed.externalId
      ? identityForScopedProvider({
          provider: parsed.provider,
          externalId: result.externalId,
          format,
        })
      : parsed;
  assertCompatibleResponseIdentity(parsed, responseIdentity);
  const responseCacheKey = await getCacheKey(responseIdentity);

  cacheResolvedStructure(
    parsed,
    cacheKey,
    responseIdentity,
    responseCacheKey,
    result.data,
    format
  ).catch((err) => {
    console.warn('[structureData] Failed to cache URL structure:', err);
  });

  return {
    data: result.data,
    format,
  };
}

function parseKnownStructureUrl(url: string): {
  provider: StructureProvider;
  externalId: string;
  format: StructureByteFormat;
  cacheIdentity: string;
  pdbId?: string;
  pdbEntityId?: string;
  labelAsymIds?: string[];
  authAsymIds?: string[];
  assemblyId?: string;
  accession?: string;
  fragment?: string;
  version?: string;
  modelId?: string;
} | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  if (host === 'files.rcsb.org') {
    const match = parsed.pathname.match(/^\/download\/([0-9][A-Za-z0-9]{3})\.(cif|pdb)$/);
    if (!match) return null;
    const format = match[2].toLowerCase() === 'pdb' ? 'pdb' : 'mmcif';
    const externalId = `RCSB:${match[1].toUpperCase()}:ENTRY`;
    return {
      provider: 'rcsb',
      externalId,
      format,
      cacheIdentity: cacheIdentityForFormat(externalId, format),
      pdbId: match[1].toUpperCase(),
    };
  }

  if (host === 'alphafold.ebi.ac.uk') {
    const match = parsed.pathname.match(
      /^\/files\/AF-([A-Za-z0-9]+)-F([1-9][0-9]*)-model_v([1-9][0-9]*)\.cif$/
    );
    if (!match) return null;
    const accession = match[1].toUpperCase();
    const fragment = `F${match[2]}`;
    const version = `V${match[3]}`;
    const modelId = `AF-${accession}-${fragment}-model_v${match[3]}`;
    const externalId = `AF:${accession}:${fragment}:${version}:MODEL:${modelId}`;
    return {
      provider: 'alphafold',
      externalId,
      format: 'mmcif',
      cacheIdentity: externalId,
      accession,
      fragment,
      version,
      modelId,
    };
  }

  return null;
}

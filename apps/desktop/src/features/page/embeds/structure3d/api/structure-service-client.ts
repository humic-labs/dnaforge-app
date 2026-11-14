import { serviceManager } from '../../../../../services/service-manager';
import {
  isApiError,
  postAlphafoldSummaryExternalAlphafoldSummaryPost,
  postRcsbValidateExternalRcsbValidatePost,
  postUniprotSummaryExternalUniprotSummaryPost,
  type AlphaFoldSummaryResponseModel,
} from '@waypoint/api-client';

export type StructureByteProvider = 'rcsb' | 'alphafold';
export type StructureByteFormat = 'mmcif' | 'pdb';

export interface FetchStructureBytesInput {
  provider: StructureByteProvider;
  externalId: string;
  format: StructureByteFormat;
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

export interface FetchStructureBytesResult {
  data: string;
  format: StructureByteFormat;
  externalId?: string;
  sourceUrl?: string;
}

export interface StructureMetadata {
  title?: string;
  description?: string;
  organism?: string;
  resolution?: number;
  method?: string;
}

export interface ValidateStructureIdResult {
  valid: boolean;
  metadata?: StructureMetadata;
  providerIdentityKey?: string;
  latestVersion?: number;
  cifUrl?: string;
  fragment?: string;
  modelId?: string;
}

const STRUCTURE_CAPABILITIES = ['external-fetch:structure'] as const;
const ANNOTATION_CAPABILITIES = ['external-fetch:annotation'] as const;

export async function fetchStructureBytes(
  input: FetchStructureBytesInput,
  signal?: AbortSignal
): Promise<FetchStructureBytesResult> {
  const path = '/external/structure/bytes';
  const response = await postRawStructureBytes(
    path,
    {
      provider: input.provider,
      external_id: input.externalId,
      format: input.format,
      pdb_id: input.pdbId,
      pdb_entity_id: input.pdbEntityId,
      label_asym_ids: input.labelAsymIds,
      auth_asym_ids: input.authAsymIds,
      assembly_id: input.assemblyId,
      accession: input.accession,
      fragment: input.fragment,
      version: input.version,
      model_id: input.modelId,
      granted_capabilities: STRUCTURE_CAPABILITIES,
    },
    signal
  );
  throwForBlockingSidecarFailure(response, path);
  if (!response.ok) {
    throw new Error(`Failed to fetch structure bytes: ${response.status} ${response.statusText}`);
  }
  const headerFormat = response.headers.get('X-Structure-Format');
  return {
    data: await response.text(),
    format: headerFormat === 'pdb' ? 'pdb' : 'mmcif',
    externalId: response.headers.get('X-External-Id') ?? undefined,
    sourceUrl: response.headers.get('X-Source-Url') ?? undefined,
  };
}

export async function validateRcsbId(
  pdbId: string,
  signal?: AbortSignal
): Promise<ValidateStructureIdResult> {
  const apiClient = serviceManager.externalLookupClient();
  const body = await callGeneratedStructureJson('/external/rcsb/validate', () =>
    postRcsbValidateExternalRcsbValidatePost(
      {
        pdb_id: pdbId,
        granted_capabilities: [...ANNOTATION_CAPABILITIES],
      },
      apiClient.options({ signal })
    )
  );
  if (!body) return { valid: false };
  if (!body.valid) return { valid: false };
  const metadata = body.metadata ?? {};
  return {
    valid: true,
    metadata: {
      title: stringField(metadata.title),
      organism: stringField(metadata.organism),
      resolution: numberField(metadata.resolution),
      method: stringField(metadata.experimental_method),
    },
  };
}

export async function validateAlphaFoldId(
  uniprotId: string,
  signal?: AbortSignal
): Promise<ValidateStructureIdResult> {
  const apiClient = serviceManager.externalLookupClient();
  const alphafold = await callGeneratedStructureJson('/external/alphafold/summary', () =>
    postAlphafoldSummaryExternalAlphafoldSummaryPost(
      {
        accession: uniprotId,
        granted_capabilities: [...ANNOTATION_CAPABILITIES],
      },
      apiClient.options({ signal })
    )
  );
  if (!alphafold?.valid) return { valid: false };
  const alphafoldIdentity = normalizeAlphaFoldSummaryIdentity(uniprotId, alphafold);

  const uniprot = await callGeneratedStructureJson(
    '/external/uniprot/summary',
    () =>
      postUniprotSummaryExternalUniprotSummaryPost(
        {
          accession: uniprotId,
          granted_capabilities: [...ANNOTATION_CAPABILITIES],
        },
        apiClient.options({ signal })
      ),
    { serverErrorIsNull: true }
  );
  if (!uniprot?.valid) return { valid: true, ...alphafoldIdentity };

  const uniprotMetadata = uniprot.metadata ?? {};
  return {
    valid: true,
    ...alphafoldIdentity,
    metadata: {
      title: stringField(uniprotMetadata.name) ?? stringField(uniprotMetadata.protein_name),
      description: stringField(uniprotMetadata.function),
      organism: stringField(uniprotMetadata.organism),
    },
  };
}

async function postRawStructureBytes(
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal
): Promise<Response> {
  try {
    return await fetch(`${serviceManager.getExternalLookupBaseUrl()}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw Object.assign(new Error(`Structure sidecar provider failure ${path}: ${message}`), {
      name: 'SidecarProviderError',
    });
  }
}

type SidecarResponse = { status: number; data: unknown };
type SuccessData<TResponse> = TResponse extends { status: 200; data: infer TData } ? TData : never;

async function callGeneratedStructureJson<TResponse extends SidecarResponse>(
  path: string,
  call: () => Promise<TResponse>,
  options: { serverErrorIsNull?: boolean } = {}
): Promise<SuccessData<TResponse> | null> {
  let response: TResponse;
  try {
    response = await call();
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    if (isApiError(error)) {
      if (
        error.status === 401 ||
        error.status === 403 ||
        error.status === 429 ||
        (error.status >= 500 && !options.serverErrorIsNull)
      ) {
        throwForBlockingSidecarStatus(error.status, path);
      }
      return null;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw Object.assign(new Error(`Structure sidecar provider failure ${path}: ${message}`), {
      name: 'SidecarProviderError',
    });
  }
  if (response.status !== 200) throwForBlockingSidecarStatus(response.status, path);
  return response.data as SuccessData<TResponse>;
}

function throwForBlockingSidecarStatus(status: number, path: string): never {
  if (status === 401 || status === 403) {
    throw Object.assign(new Error(`Structure sidecar rejected ${path}: HTTP ${status}`), {
      name: 'SidecarAuthError',
    });
  }
  throw Object.assign(new Error(`Structure sidecar provider failure ${path}: HTTP ${status}`), {
    name: 'SidecarProviderError',
  });
}

function throwForBlockingSidecarFailure(response: Response, path: string): void {
  if (response.status === 401 || response.status === 403) {
    throw Object.assign(new Error(`Structure sidecar rejected ${path}: HTTP ${response.status}`), {
      name: 'SidecarAuthError',
    });
  }
  if (response.status >= 500) {
    throw Object.assign(
      new Error(`Structure sidecar provider failure ${path}: HTTP ${response.status}`),
      { name: 'SidecarProviderError' }
    );
  }
}

function throwSidecarProviderContract(message: string): never {
  throw Object.assign(new Error(message), { name: 'SidecarProviderError' });
}

function normalizeAlphaFoldSummaryIdentity(
  requestedAccession: string,
  alphafold: AlphaFoldSummaryResponseModel
): Pick<
  ValidateStructureIdResult,
  'providerIdentityKey' | 'latestVersion' | 'cifUrl' | 'fragment' | 'modelId'
> {
  const accession = requestedAccession.trim().toUpperCase();
  const responseAccession = stringField(alphafold.accession)?.toUpperCase();
  if (responseAccession && responseAccession !== accession) {
    throwSidecarProviderContract(
      `AlphaFold sidecar returned accession ${responseAccession} for ${accession}`
    );
  }

  const latestVersion =
    typeof alphafold.latest_version === 'number' &&
    Number.isInteger(alphafold.latest_version) &&
    alphafold.latest_version > 0
      ? alphafold.latest_version
      : undefined;
  if (
    alphafold.latest_version !== null &&
    alphafold.latest_version !== undefined &&
    !latestVersion
  ) {
    throwSidecarProviderContract('AlphaFold sidecar returned invalid latest_version');
  }

  const parsedProviderKey = parseAlphaFoldProviderIdentity(
    stringField(alphafold.provider_identity_key)
  );
  const fragment =
    stringField(alphafold.fragment)?.toUpperCase() ?? parsedProviderKey?.fragment ?? 'F1';
  if (!/^F[1-9][0-9]*$/.test(fragment)) {
    throwSidecarProviderContract(`AlphaFold sidecar returned invalid fragment ${fragment}`);
  }

  const modelId = stringField(alphafold.model_id) ?? parsedProviderKey?.modelId;
  const parsedModel = modelId ? parseAlphaFoldModelId(modelId) : undefined;
  if (parsedProviderKey) {
    if (parsedProviderKey.accession !== accession || parsedProviderKey.fragment !== fragment) {
      throwSidecarProviderContract('AlphaFold sidecar returned mismatched provider identity');
    }
    if (
      latestVersion &&
      parsedProviderKey.version !== 'LATEST' &&
      parsedProviderKey.version !== `V${latestVersion}`
    ) {
      throwSidecarProviderContract('AlphaFold sidecar returned stale provider identity version');
    }
  }
  if (parsedModel) {
    if (parsedModel.accession !== accession || parsedModel.fragment !== fragment) {
      throwSidecarProviderContract('AlphaFold sidecar returned mismatched model identity');
    }
    if (latestVersion && parsedModel.version !== `V${latestVersion}`) {
      throwSidecarProviderContract('AlphaFold sidecar returned stale model identity version');
    }
    if (
      parsedProviderKey &&
      parsedProviderKey.version !== 'LATEST' &&
      parsedProviderKey.version !== parsedModel.version
    ) {
      throwSidecarProviderContract('AlphaFold sidecar returned inconsistent model identity');
    }
  }

  return {
    providerIdentityKey:
      parsedProviderKey?.providerIdentityKey ?? stringField(alphafold.provider_identity_key),
    latestVersion,
    cifUrl: stringField(alphafold.cif_url),
    fragment,
    modelId: parsedModel?.modelId ?? modelId,
  };
}

function parseAlphaFoldProviderIdentity(value: string | undefined):
  | {
      providerIdentityKey: string;
      accession: string;
      fragment: string;
      version: string;
      modelId?: string;
    }
  | undefined {
  if (!value) return undefined;
  const parts = value.trim().split(':');
  if (parts.length !== 4 && parts.length !== 6) {
    throwSidecarProviderContract('AlphaFold sidecar returned invalid provider identity');
  }
  if (parts[0].toUpperCase() !== 'AF') {
    throwSidecarProviderContract('AlphaFold sidecar returned invalid provider identity');
  }
  const accession = parts[1].toUpperCase();
  const fragment = parts[2].toUpperCase();
  const version = parts[3].toUpperCase();
  if (!/^F[1-9][0-9]*$/.test(fragment) || !/^(?:LATEST|V[1-9][0-9]*)$/.test(version)) {
    throwSidecarProviderContract('AlphaFold sidecar returned invalid provider identity');
  }
  let modelId: string | undefined;
  if (parts.length === 6) {
    if (parts[4].toUpperCase() !== 'MODEL') {
      throwSidecarProviderContract('AlphaFold sidecar returned invalid provider identity');
    }
    modelId = parseAlphaFoldModelId(parts[5]).modelId;
  }
  return {
    providerIdentityKey: modelId
      ? `AF:${accession}:${fragment}:${version}:MODEL:${modelId}`
      : `AF:${accession}:${fragment}:${version}`,
    accession,
    fragment,
    version,
    modelId,
  };
}

function parseAlphaFoldModelId(value: string): {
  modelId: string;
  accession: string;
  fragment: string;
  version: string;
} {
  const match = value.match(/^AF-([A-Za-z0-9]+)-(F[1-9][0-9]*)-model_v([1-9][0-9]*)$/);
  if (!match) {
    throwSidecarProviderContract('AlphaFold sidecar returned invalid model identity');
  }
  return {
    modelId: `AF-${match[1].toUpperCase()}-${match[2].toUpperCase()}-model_v${match[3]}`,
    accession: match[1].toUpperCase(),
    fragment: match[2].toUpperCase(),
    version: `V${match[3]}`,
  };
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

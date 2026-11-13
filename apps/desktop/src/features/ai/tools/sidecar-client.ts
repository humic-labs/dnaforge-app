import {
  isApiError,
  postSequenceBytesExternalSequenceBytesPost,
  postSequenceUrlBytesExternalSequenceUrlBytesPost,
} from '@waypoint/api-client';
import {
  configureRendererSidecarApiClient,
  resolveExternalLookupBaseUrl,
} from '../../../services/sidecar-session';

export {
  configureSidecarApiClient,
  getSidecarBaseUrl,
  resolveSidecarBaseUrl,
} from '../../../services/sidecar-session';

export interface SidecarSequenceImportResult {
  provider: string;
  externalId: string;
  format: string;
  content: string;
  contentSha256: string;
  sourceUrl?: string;
  license?: string;
  attribution?: string;
  versionIdentifier?: string;
  etag?: string;
  metadata: Record<string, unknown>;
}

interface SidecarSequenceBytesWire {
  provider?: unknown;
  external_id?: unknown;
  format?: unknown;
  content?: unknown;
  content_sha256?: unknown;
  source_url?: unknown;
  license?: unknown;
  attribution?: unknown;
  version_identifier?: unknown;
  etag?: unknown;
  metadata?: unknown;
}

export interface SidecarFetchSequenceBytesParams {
  externalId: string;
  provider?: 'ncbi-nuccore';
  format?: 'genbank';
  workspaceId?: string;
}

export interface SidecarFetchSequenceUrlBytesParams {
  url: string;
  workspaceId?: string;
}

export async function sidecarFetchSequenceBytes(
  params: SidecarFetchSequenceBytesParams,
  opts: { signal?: AbortSignal; grantedCapabilities?: readonly string[] } = {}
): Promise<SidecarSequenceImportResult> {
  const toolName = 'import_sequence';
  configureRendererSidecarApiClient(await resolveExternalLookupBaseUrl(toolName));
  const body = {
    provider: params.provider ?? 'ncbi-nuccore',
    external_id: params.externalId,
    format: params.format ?? 'genbank',
    workspace_id: params.workspaceId,
    granted_capabilities: [
      ...(opts.grantedCapabilities ?? ['external-fetch:annotation']),
    ],
  };

  try {
    const response = await postSequenceBytesExternalSequenceBytesPost(body, {
      signal: opts.signal,
    });
    const data = response.data as SidecarSequenceBytesWire;
    const content = typeof data.content === 'string' ? data.content : '';
    if (content.length === 0) {
      throw new Error(`NCBI returned no record for ${params.externalId}.`);
    }

    return {
      provider: stringOr(data.provider, 'ncbi-nuccore'),
      externalId: stringOr(data.external_id, params.externalId),
      format: stringOr(data.format, 'genbank'),
      content,
      contentSha256: stringOr(data.content_sha256, ''),
      sourceUrl: optionalString(data.source_url),
      license: optionalString(data.license),
      attribution: optionalString(data.attribution),
      versionIdentifier: optionalString(data.version_identifier),
      etag: optionalString(data.etag),
      metadata:
        data.metadata && typeof data.metadata === 'object' && !Array.isArray(data.metadata)
          ? (data.metadata as Record<string, unknown>)
          : {},
    };
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    if (isApiError(err)) {
      throw new Error(describeSequenceBytesApiError(err.status, err.body, params.externalId));
    }
    if (err instanceof Error && err.message.startsWith('NCBI returned no record')) throw err;
    throw new Error(
      `Could not reach the sidecar to import ${params.externalId} from NCBI ` +
        `(${(err as Error).message}). Make sure the app's compute service is running, then retry.`
    );
  }
}

export async function sidecarFetchSequenceUrlBytes(
  params: SidecarFetchSequenceUrlBytesParams,
  opts: { signal?: AbortSignal; grantedCapabilities?: readonly string[] } = {}
): Promise<SidecarSequenceImportResult> {
  configureRendererSidecarApiClient(await resolveExternalLookupBaseUrl('import_sequence'));
  try {
    const response = await postSequenceUrlBytesExternalSequenceUrlBytesPost(
      {
        url: params.url,
        workspace_id: params.workspaceId,
        granted_capabilities: [
          ...(opts.grantedCapabilities ?? ['external-fetch:annotation']),
        ],
      },
      { signal: opts.signal }
    );
    return sequenceImportResult(response.data as SidecarSequenceBytesWire, params.url);
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    if (isApiError(err)) {
      const message = detailField(
        err.body && typeof err.body === 'object' && 'detail' in err.body
          ? (err.body as { detail?: unknown }).detail
          : undefined,
        'message'
      );
      throw new Error(
        message
          ? `Could not import the sequence URL: ${message}`
          : `Could not import the sequence URL (HTTP ${err.status}).`
      );
    }
    throw new Error(
      `Could not reach the compute service to import the sequence URL (${(err as Error).message}).`
    );
  }
}

function sequenceImportResult(
  data: SidecarSequenceBytesWire,
  fallbackExternalId: string
): SidecarSequenceImportResult {
  const content = typeof data.content === 'string' ? data.content : '';
  if (content.length === 0) {
    throw new Error(`The sequence source returned no record for ${fallbackExternalId}.`);
  }
  return {
    provider: stringOr(data.provider, 'public-url'),
    externalId: stringOr(data.external_id, fallbackExternalId),
    format: stringOr(data.format, 'auto'),
    content,
    contentSha256: stringOr(data.content_sha256, ''),
    sourceUrl: optionalString(data.source_url),
    license: optionalString(data.license),
    attribution: optionalString(data.attribution),
    versionIdentifier: optionalString(data.version_identifier),
    etag: optionalString(data.etag),
    metadata:
      data.metadata && typeof data.metadata === 'object' && !Array.isArray(data.metadata)
        ? (data.metadata as Record<string, unknown>)
        : {},
  };
}

function describeSequenceBytesApiError(
  status: number,
  body: unknown,
  externalId: string
): string {
  if (status === 401 || status === 403) {
    return `The compute service rejected the NCBI import request (HTTP ${status}).`;
  }

  const detail =
    body && typeof body === 'object' && 'detail' in body
      ? (body as { detail?: unknown }).detail
      : undefined;
  const failureKind = detailField(detail, 'failure_kind');
  const message = detailField(detail, 'message');

  if (status === 413 || failureKind === 'sequence_too_large') {
    return `The NCBI record for ${externalId} is too large to import. Download it manually if you need it.`;
  }
  if (status === 422) {
    return `"${externalId}" is not a recognized NCBI nucleotide accession (e.g. NC_000913.3, U00096.3).`;
  }
  if (status === 503 || failureKind === 'circuit_open') {
    return `NCBI is temporarily unavailable. Wait a moment and try importing ${externalId} again.`;
  }
  if (failureKind === 'rate_limited') {
    return `NCBI rate-limited the request for ${externalId}. Wait a moment and try again.`;
  }
  if (failureKind === 'provider_contract_error') {
    return `NCBI has no usable record for ${externalId}. Check the accession and try again.`;
  }
  if (failureKind === 'timeout') {
    return `The request for ${externalId} to NCBI timed out. Try again shortly.`;
  }
  return message
    ? `NCBI import for ${externalId} failed: ${message}`
    : `NCBI import for ${externalId} failed (HTTP ${status}).`;
}

function detailField(detail: unknown, key: string): string | undefined {
  if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
    const value = (detail as Record<string, unknown>)[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }
  return undefined;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

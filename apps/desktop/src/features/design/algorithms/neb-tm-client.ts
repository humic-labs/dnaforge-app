import {
  createRendererSidecarApiClient,
  resolveSidecarBaseUrl,
} from '../../../services/sidecar-session';
import {
  isApiError,
  postNebTmBatchExternalNebTmBatchPost,
  postNebTmExternalNebTmPost,
  type NebTmOligoModel,
  type NebTmResponseModel,
} from '@waypoint/api-client';

const TOOL_NAME = 'neb_tm';

const NEB_TM_CAPABILITIES: readonly string[] = ['external-compute:tm'];

export interface SidecarNebTmOligo {
  tm: number;
  gcFraction: number;
  length: number;
  seq: string;
}

export interface SidecarNebTmResult {
  prodcode: string;
  concNm: number;
  p1: SidecarNebTmOligo;
  p2?: SidecarNebTmOligo;
  ta?: number;
  nebApiVersion: string;
  fetchedAt: string;
  notes: string[];
}

export interface SidecarNebTmParams {
  seq1: string;
  seq2?: string;
  prodcode?: string;
  concNm?: number;
  workspaceId?: string;
}

export async function sidecarNebTm(
  params: SidecarNebTmParams,
  opts: { signal?: AbortSignal; grantedCapabilities?: readonly string[] } = {}
): Promise<SidecarNebTmResult> {
  const baseUrl = await resolveSidecarBaseUrl(TOOL_NAME);
  const apiClient = createRendererSidecarApiClient(baseUrl);
  const prodcode = params.prodcode ?? 'q5-0';
  const concNm = params.concNm ?? 250;
  const body = {
    seq1: params.seq1,
    seq2: params.seq2,
    prodcode,
    conc_nm: concNm,
    workspace_id: params.workspaceId,
    granted_capabilities: [...(opts.grantedCapabilities ?? NEB_TM_CAPABILITIES)],
  };

  let response: Awaited<ReturnType<typeof postNebTmExternalNebTmPost>>;
  try {
    response = await postNebTmExternalNebTmPost(body, apiClient.options({ signal: opts.signal }));
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    if (isApiError(err)) throw new Error(describeNebTmApiError(err.status, err.body));
    throw new Error(
      `Could not reach the sidecar for the NEB Tm calculation (${err instanceof Error ? err.message : String(err)}).`
    );
  }
  if (response.status !== 200) {
    throw new Error(describeNebTmApiError(response.status, response.data));
  }
  return toNebTmResult(response.data, { prodcode, concNm, fetchedAt: new Date().toISOString() });
}

function toNebTmResult(
  data: NebTmResponseModel,
  defaults: { prodcode: string; concNm: number; fetchedAt: string }
): SidecarNebTmResult {
  const p1 = parseOligo(data.p1);
  if (!p1) {
    throw new Error('The NEB Tm response was missing the primary oligo.');
  }
  return {
    prodcode: stringOr(data.prodcode, defaults.prodcode),
    concNm: numberOr(data.conc_nm, defaults.concNm),
    p1,
    p2: parseOligo(data.p2),
    ta: typeof data.ta === 'number' && Number.isFinite(data.ta) ? data.ta : undefined,
    nebApiVersion: stringOr(data.api_version, ''),
    fetchedAt: defaults.fetchedAt,
    notes: Array.isArray(data.notes) ? data.notes : [],
  };
}

export interface NebFetchResult {
  tm: number;
  ta?: number;
  nebApiVersion: string;
  fetchedAt: string;
}

export function makeNebBatchFetch(defaults: { prodcode?: string } = {}) {
  return async (args: {
    seqs: string[];
    prodcode: string;
    conc_nM: number;
    signal?: AbortSignal;
  }): Promise<NebFetchResult[]> => {
    const results = await sidecarNebTmBatch(
      {
        sequences: args.seqs,
        prodcode: args.prodcode ?? defaults.prodcode,
        concNm: args.conc_nM,
      },
      { signal: args.signal }
    );
    return results.map((result) => ({
      tm: result.p1.tm,
      ta: result.ta,
      nebApiVersion: result.nebApiVersion,
      fetchedAt: result.fetchedAt,
    }));
  };
}

export function makeNebFetch(
  defaults: { prodcode?: string; grantedCapabilities?: readonly string[] } = {}
) {
  return async (args: {
    seq: string;
    prodcode: string;
    conc_nM: number;
    signal?: AbortSignal;
  }): Promise<NebFetchResult> => {
    const result = await sidecarNebTm(
      {
        seq1: args.seq,
        prodcode: args.prodcode ?? defaults.prodcode,
        concNm: args.conc_nM,
      },
      { signal: args.signal, grantedCapabilities: defaults.grantedCapabilities }
    );
    return {
      tm: result.p1.tm,
      ta: result.ta,
      nebApiVersion: result.nebApiVersion,
      fetchedAt: result.fetchedAt,
    };
  };
}

export async function sidecarNebTmBatch(
  params: { sequences: string[]; prodcode?: string; concNm?: number; workspaceId?: string },
  opts: { signal?: AbortSignal } = {}
): Promise<SidecarNebTmResult[]> {
  if (params.sequences.length === 0) return [];
  const baseUrl = await resolveSidecarBaseUrl(TOOL_NAME);
  const apiClient = createRendererSidecarApiClient(baseUrl);
  const prodcode = params.prodcode ?? 'q5-0';
  const concNm = params.concNm ?? 250;
  const body = {
    sequences: params.sequences,
    prodcode,
    conc_nm: concNm,
    workspace_id: params.workspaceId,
    granted_capabilities: [...NEB_TM_CAPABILITIES],
  };

  let response: Awaited<ReturnType<typeof postNebTmBatchExternalNebTmBatchPost>>;
  try {
    response = await postNebTmBatchExternalNebTmBatchPost(
      body,
      apiClient.options({ signal: opts.signal })
    );
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    if (isApiError(err)) throw new Error(describeNebTmApiError(err.status, err.body));
    throw new Error(
      `Could not reach the sidecar for the NEB Tm batch calculation (${err instanceof Error ? err.message : String(err)}).`
    );
  }
  if (response.status !== 200) {
    throw new Error(describeNebTmApiError(response.status, response.data));
  }

  const rows = response.data.results;
  if (!Array.isArray(rows) || rows.length !== params.sequences.length) {
    throw new Error('The NEB Tm batch response did not include one result per primer.');
  }

  const fetchedAt = new Date().toISOString();
  return rows.map((row) => toNebTmResult(row, { prodcode, concNm, fetchedAt }));
}

function describeNebTmApiError(status: number, body: unknown): string {
  const detailValue =
    body && typeof body === 'object' && 'detail' in body
      ? (body as { detail?: unknown }).detail
      : undefined;
  const detail =
    detailValue && typeof detailValue === 'object'
      ? String(
          (detailValue as { message?: unknown; error?: unknown }).message ??
            (detailValue as { error?: unknown }).error ??
            ''
        )
      : undefined;
  return `The NEB Tm calculation failed (HTTP ${status}${detail ? `: ${detail}` : ''}).`;
}

function parseOligo(entry: NebTmOligoModel | null | undefined): SidecarNebTmOligo | undefined {
  if (!entry || typeof entry.tm !== 'number' || !Number.isFinite(entry.tm)) return undefined;
  return {
    tm: entry.tm,
    gcFraction: typeof entry.gc_fraction === 'number' ? entry.gc_fraction : 0,
    length: typeof entry.length === 'number' ? entry.length : 0,
    seq: typeof entry.seq === 'string' ? entry.seq : '',
  };
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' ? value : fallback;
}

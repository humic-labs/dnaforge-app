import { createHash, randomUUID } from 'node:crypto';

import {
  configureApiClient,
  discoverOperationsOperationsCatalogGet,
  getOperationOperationsOperationIdGet,
  getOperationResultOperationsOperationIdResultGet,
  isApiError,
  startGenomeIndexingOperationOperationsGenomeIndexingPost,
  type GenomeIndexSubmission,
} from '@waypoint/api-client';

import { getApiUrl } from './config';
import {
  delayManagedOperationRequest,
  retryIdempotentManagedOperationRequest,
  throwIfManagedOperationAborted,
  type ManagedOperationRetryDelay,
} from './managed-operation-request-retry';
import { sidecarFetch } from './sidecar-session-runtime';

const GENOME_INDEX_KIND = 'genome-indexing';
const DEFAULT_POLL_INTERVAL_MS = 500;
const ACTIVE_STATES = new Set(['queued', 'running', 'stopping']);
const TERMINAL_FAILURE_STATES = new Set(['failed', 'canceled', 'interrupted']);

export interface ManagedGenomeIndexInput {
  readonly input: string;
  readonly outputDir: string;
  readonly name: string;
  readonly workspaceRoot: string;
}

export interface ManagedGenomeIndexResult {
  readonly fastaPath: string;
  readonly faiPath: string;
  readonly gffPath?: string | null;
  readonly tbiPath?: string | null;
  readonly metadata: {
    readonly length: number;
    readonly circular: boolean;
    readonly featureCount: number;
    readonly annotationTypes: string[];
    readonly annotationRasterReady: boolean;
  };
}

export interface ManagedGenomeIndexApi {
  discover(signal?: AbortSignal): Promise<unknown>;
  start(submission: GenomeIndexSubmission): Promise<unknown>;
  get(operationId: string, signal?: AbortSignal): Promise<unknown>;
  getResult(operationId: string, signal?: AbortSignal): Promise<unknown>;
}

interface ManagedGenomeIndexRunnerDependencies {
  readonly api: ManagedGenomeIndexApi;
  readonly createSubmissionKey?: (input: ManagedGenomeIndexInput) => string;
  readonly ownerInstanceId?: string;
  readonly createAttemptId?: () => string;
  readonly delay?: ManagedOperationRetryDelay;
  readonly pollIntervalMs?: number;
}

interface OperationSnapshot {
  readonly id: string;
  readonly state: string;
  readonly error: { readonly code: string; readonly message: string } | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalGenomeInput(value: ManagedGenomeIndexInput): string {
  return JSON.stringify({
    input: value.input,
    name: value.name,
    outputDir: value.outputDir,
    workspaceRoot: value.workspaceRoot,
  });
}

export function genomeIndexInputRevision(value: ManagedGenomeIndexInput): string {
  return `genome-index-v1:sha256:${createHash('sha256').update(canonicalGenomeInput(value)).digest('hex')}`;
}

export function genomeIndexSubjectId(value: ManagedGenomeIndexInput): string {
  const identity = JSON.stringify({
    input: value.input,
    outputDir: value.outputDir,
    workspaceRoot: value.workspaceRoot,
  });
  return `genome-source-v1:sha256:${createHash('sha256').update(identity).digest('hex')}`;
}

export function genomeIndexSubmissionKey(
  value: ManagedGenomeIndexInput,
  ownerInstanceId: string
): string {
  const inputDigest = createHash('sha256').update(canonicalGenomeInput(value)).digest('hex');
  return `genome-index-ui-v1:${ownerInstanceId}:${inputDigest}`;
}

function apiFailureMessage(error: unknown, action: string): string {
  if (isApiError(error)) {
    const detail = isRecord(error.body) ? error.body.detail : undefined;
    if (typeof detail === 'string' && detail) return detail;
    if (isRecord(detail) && typeof detail.message === 'string') return detail.message;
    return `${action} failed (${error.status}${error.statusText ? ` ${error.statusText}` : ''})`;
  }
  return error instanceof Error && error.message ? error.message : `${action} failed.`;
}

async function apiPayload(action: string, request: () => Promise<unknown>): Promise<unknown> {
  try {
    return await request();
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new Error(apiFailureMessage(error, action), { cause: error });
  }
}

function parseCatalogStart(payload: unknown): { scopeId: string } {
  if (!isRecord(payload) || typeof payload.scope_id !== 'string' || !Array.isArray(payload.kinds)) {
    throw new Error('The managed operation catalog returned an invalid response.');
  }
  const kind = payload.kinds.find(
    (value) => isRecord(value) && value.kind === GENOME_INDEX_KIND && value.executable === true
  );
  const surfaces = isRecord(kind) && isRecord(kind.surfaces) ? kind.surfaces : undefined;
  if (!surfaces || surfaces.http_start !== '/operations/genome-indexing') {
    throw new Error('Genome indexing is unavailable in the managed operation runtime.');
  }
  return { scopeId: payload.scope_id };
}

function parseSnapshot(payload: unknown): OperationSnapshot {
  if (
    !isRecord(payload) ||
    typeof payload.id !== 'string' ||
    payload.kind !== GENOME_INDEX_KIND ||
    typeof payload.state !== 'string'
  ) {
    throw new Error('The genome-index operation returned an invalid status.');
  }
  const error = payload.error;
  if (
    error !== null &&
    error !== undefined &&
    (!isRecord(error) || typeof error.code !== 'string' || typeof error.message !== 'string')
  ) {
    throw new Error('The genome-index operation returned an invalid error.');
  }
  return {
    id: payload.id,
    state: payload.state,
    error: isRecord(error)
      ? { code: error.code as string, message: error.message as string }
      : null,
  };
}

function terminalFailure(snapshot: OperationSnapshot): Error {
  const fallback =
    snapshot.state === 'canceled'
      ? 'Genome indexing was stopped.'
      : snapshot.state === 'interrupted'
        ? 'Genome indexing was interrupted.'
        : 'Genome indexing failed.';
  return new Error(snapshot.error?.message || fallback);
}

function parseResult(payload: unknown, operationId: string): ManagedGenomeIndexResult {
  if (
    !isRecord(payload) ||
    payload.operation_id !== operationId ||
    payload.kind !== GENOME_INDEX_KIND ||
    payload.status !== 'available' ||
    !isRecord(payload.result)
  ) {
    throw new Error('The completed genome-index operation has no available result.');
  }
  const result = payload.result;
  const metadata = result.metadata;
  if (
    typeof result.fastaPath !== 'string' ||
    !result.fastaPath ||
    typeof result.faiPath !== 'string' ||
    !result.faiPath ||
    (result.gffPath !== undefined &&
      result.gffPath !== null &&
      typeof result.gffPath !== 'string') ||
    (result.tbiPath !== undefined &&
      result.tbiPath !== null &&
      typeof result.tbiPath !== 'string') ||
    !isRecord(metadata) ||
    !Number.isSafeInteger(metadata.length) ||
    (metadata.length as number) < 0 ||
    typeof metadata.circular !== 'boolean' ||
    !Number.isSafeInteger(metadata.featureCount) ||
    (metadata.featureCount as number) < 0 ||
    !Array.isArray(metadata.annotationTypes) ||
    metadata.annotationTypes.some((value) => typeof value !== 'string') ||
    typeof metadata.annotationRasterReady !== 'boolean'
  ) {
    throw new Error('The completed genome-index operation returned an invalid result.');
  }
  return {
    fastaPath: result.fastaPath,
    faiPath: result.faiPath,
    ...(result.gffPath !== undefined ? { gffPath: result.gffPath as string | null } : {}),
    ...(result.tbiPath !== undefined ? { tbiPath: result.tbiPath as string | null } : {}),
    metadata: {
      length: metadata.length as number,
      circular: metadata.circular,
      featureCount: metadata.featureCount as number,
      annotationTypes: metadata.annotationTypes as string[],
      annotationRasterReady: metadata.annotationRasterReady,
    },
  };
}

export function createManagedGenomeIndexRunner(dependencies: ManagedGenomeIndexRunnerDependencies) {
  const ownerInstanceId = dependencies.ownerInstanceId ?? randomUUID();
  const createAttemptId = dependencies.createAttemptId ?? randomUUID;
  const activeSubmissionKeys = new Map<string, string>();
  const createSubmissionKey =
    dependencies.createSubmissionKey ??
    ((input: ManagedGenomeIndexInput) => {
      const identity = canonicalGenomeInput(input);
      const existing = activeSubmissionKeys.get(identity);
      if (existing) return existing;
      const created = genomeIndexSubmissionKey(input, `${ownerInstanceId}:${createAttemptId()}`);
      activeSubmissionKeys.set(identity, created);
      return created;
    });
  const delay = dependencies.delay ?? delayManagedOperationRequest;
  const pollIntervalMs = dependencies.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
    throw new Error('Genome-index polling interval must be a non-negative number.');
  }

  return async function runManagedGenomeIndex(
    input: ManagedGenomeIndexInput,
    signal?: AbortSignal
  ): Promise<ManagedGenomeIndexResult> {
    const inputIdentity = canonicalGenomeInput(input);
    throwIfManagedOperationAborted(signal);
    const { scopeId } = parseCatalogStart(
      await apiPayload('Loading managed operations', () =>
        retryIdempotentManagedOperationRequest(() => dependencies.api.discover(signal), {
          signal,
          delay,
        })
      )
    );
    throwIfManagedOperationAborted(signal);

    const submission: GenomeIndexSubmission = {
      submission_key: createSubmissionKey(input),
      subject: {
        scope_id: scopeId,
        subject_id: genomeIndexSubjectId(input),
        input_revision: genomeIndexInputRevision(input),
      },
      input,
    };

    let operation = parseSnapshot(
      await apiPayload('Starting genome indexing', () =>
        retryIdempotentManagedOperationRequest(() => dependencies.api.start(submission), {
          signal,
          delay,
        })
      )
    );

    while (ACTIVE_STATES.has(operation.state)) {
      await delay(pollIntervalMs, signal);
      throwIfManagedOperationAborted(signal);
      operation = parseSnapshot(
        await apiPayload('Reading genome-index status', () =>
          retryIdempotentManagedOperationRequest(() => dependencies.api.get(operation.id, signal), {
            signal,
            delay,
          })
        )
      );
    }

    if (TERMINAL_FAILURE_STATES.has(operation.state)) {
      if (!dependencies.createSubmissionKey) activeSubmissionKeys.delete(inputIdentity);
      throw terminalFailure(operation);
    }
    if (operation.state !== 'succeeded') {
      throw new Error('The genome-index operation entered an unknown state.');
    }
    throwIfManagedOperationAborted(signal);
    return parseResult(
      await apiPayload('Reading the genome-index result', () =>
        retryIdempotentManagedOperationRequest(
          () => dependencies.api.getResult(operation.id, signal),
          { signal, delay }
        )
      ),
      operation.id
    );
  };
}

function bindMainSidecarApiClient(): void {
  configureApiClient({ baseUrl: getApiUrl(), fetch: sidecarFetch });
}

const generatedGenomeIndexApi: ManagedGenomeIndexApi = {
  async discover(signal) {
    bindMainSidecarApiClient();
    return (await discoverOperationsOperationsCatalogGet({ signal })).data;
  },
  async start(submission) {
    bindMainSidecarApiClient();
    return (await startGenomeIndexingOperationOperationsGenomeIndexingPost(submission)).data;
  },
  async get(operationId, signal) {
    bindMainSidecarApiClient();
    return (await getOperationOperationsOperationIdGet(operationId, { signal })).data;
  },
  async getResult(operationId, signal) {
    bindMainSidecarApiClient();
    return (await getOperationResultOperationsOperationIdResultGet(operationId, { signal })).data;
  },
};

export const runManagedGenomeIndex = createManagedGenomeIndexRunner({
  api: generatedGenomeIndexApi,
});

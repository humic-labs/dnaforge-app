import { handleGroup } from '../../shared/ipc-contract';
import { computeContract } from '../../shared/ipc/compute.contract';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, link, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseProviderManifest, type ProviderManifest } from '@waypoint/compute-endpoints';
import {
  COMPUTE_CREDENTIAL_HEADER,
  type ComputeConnectResult,
  type ComputeDisconnectResult,
  type ComputeFailureKind,
  type ComputeManifestInstallResult,
  type ComputeManifestRemoveResult,
  type ComputeProviderSummary,
} from '../../shared/compute-ipc';
import type {
  ComputeRecoveryResult,
  ComputeImportDetails,
  ComputeJobIntentInput,
  ComputeJobIntentReceipt,
  ComputeJobRecord,
  ComputeJobsListOptions,
  ComputeJobsSnapshot,
  ComputeJobsSnapshotOptions,
} from '../../shared/compute-jobs-ipc';
import {
  deleteComputeCredential,
  hasComputeCredential,
  lastComputeVerification,
  readComputeCredential,
  recordComputeVerification,
  writeComputeCredential,
} from './credentials';
import type { ComputeJobRegistry } from './jobs';

type SidecarFetch = (pathOrUrl: string | URL, init?: RequestInit) => Promise<Response>;

export interface ComputeIpcDeps {
  sidecarFetch: SidecarFetch;

  jobs?: ComputeJobRegistry;

  grantedCapabilities: () => string[];

  userManifestsDir?: string;

  restartSidecar?: () => Promise<void>;
  now?: () => Date;
}

interface ProviderWire {
  id: string;
  display_name: string;
  summary: string;
  transport: 'mcp' | 'rest';
  driver?: string;
  custom?: boolean;
  auth_scheme: 'header' | 'bearer' | 'oauth';
  credential_header: string | null;
  endpoint_url: string;
  verify_target: string;
  catalog: string;
  job_model: string;
  cost: string;
  disclosure: string;
  retention_note: string;
  cancellation_mode: 'provider' | 'unavailable';
  cancellation_note: string;
  docs_url: string;
  key_page_url: string | null;
  terms_url: string;
  privacy_url: string;
  has_binding: boolean;
}

const KNOWN_KINDS: ReadonlySet<string> = new Set<ComputeFailureKind>([
  'bad_credential',
  'budget_exhausted',
  'rate_limited',
  'provider_unavailable',
  'mapped_tool_missing',
  'invalid_settings',
  'unknown_job',
  'circuit_open',
  'provider_error',
  'missing_credential',
  'unknown_provider',
  'capability_denied',
]);

async function failureFromResponse(
  response: Response
): Promise<{ kind: ComputeFailureKind; message: string }> {
  let detail: unknown = null;
  try {
    const parsed: unknown = await response.json();
    detail =
      parsed && typeof parsed === 'object' && 'detail' in parsed
        ? (parsed as { detail: unknown }).detail
        : null;
  } catch {
    detail = null;
  }
  const rawKind =
    detail && typeof detail === 'object' ? (detail as { error?: unknown }).error : undefined;
  const rawMessage =
    detail && typeof detail === 'object' ? (detail as { message?: unknown }).message : undefined;
  const kind: ComputeFailureKind =
    typeof rawKind === 'string' && KNOWN_KINDS.has(rawKind)
      ? (rawKind as ComputeFailureKind)
      : response.status === 503
        ? 'sidecar_unavailable'
        : 'provider_error';
  return {
    kind,
    message: typeof rawMessage === 'string' ? rawMessage : `HTTP ${response.status}`,
  };
}

function looksLikeKey(secret: string): boolean {
  const trimmed = secret.trim();
  return trimmed.length >= 8 && trimmed.length <= 512 && !/\s/.test(trimmed);
}

function providerFromWire(
  p: ProviderWire,
  connection: { connected: boolean; lastVerifiedAt: string | null }
): ComputeProviderSummary {
  return {
    id: p.id,
    displayName: p.display_name,
    summary: p.summary,
    transport: p.transport,
    driver: p.driver ?? (p.transport === 'mcp' ? 'mcp-tool-map' : 'legacy-rest'),
    custom: p.custom ?? false,
    authScheme: p.auth_scheme,
    credentialHeader: p.credential_header,
    endpointUrl: p.endpoint_url,
    verifyTarget: p.verify_target,
    catalog: p.catalog,
    jobModel: p.job_model,
    cost: p.cost,
    disclosure: p.disclosure,
    retentionNote: p.retention_note,
    cancellationMode: p.cancellation_mode,
    cancellationNote: p.cancellation_note,
    docsUrl: p.docs_url,
    keyPageUrl: p.key_page_url,
    termsUrl: p.terms_url,
    privacyUrl: p.privacy_url,
    hasBinding: p.has_binding,
    connected: connection.connected,
    lastVerifiedAt: connection.lastVerifiedAt,
  };
}

async function manifestFailureFromResponse(
  response: Response
): Promise<Exclude<ComputeManifestInstallResult, { ok: true }>> {
  let detail: { error?: unknown; message?: unknown } | null = null;
  try {
    const parsed = (await response.json()) as { detail?: unknown };
    if (parsed.detail && typeof parsed.detail === 'object') {
      detail = parsed.detail as { error?: unknown; message?: unknown };
    }
  } catch {}
  const error = typeof detail?.error === 'string' ? detail.error : '';
  const kind =
    error === 'provider_id_conflict' || error === 'unsupported_compute_driver'
      ? error
      : response.status === 503
        ? 'sidecar_unavailable'
        : 'invalid_manifest';
  return {
    ok: false,
    kind,
    message:
      typeof detail?.message === 'string'
        ? detail.message
        : `The compute manifest was rejected (HTTP ${response.status}).`,
  };
}

async function atomicInstallManifest(
  directory: string,
  manifest: ProviderManifest
): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, `${manifest.id}.json`);
  const temporary = join(directory, `.${manifest.id}.${randomUUID()}.tmp`);
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(temporary, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  try {
    await link(temporary, target);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  return target;
}

export function createComputeIpcHandlers(deps: ComputeIpcDeps) {
  const now = deps.now ?? (() => new Date());

  async function verifyWithSidecar(
    providerId: string,
    secret: string
  ): Promise<
    { ok: true; toolCount: number } | { ok: false; kind: ComputeFailureKind; message: string }
  > {
    let response: Response;
    try {
      response = await deps.sidecarFetch(`/compute/${encodeURIComponent(providerId)}/verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [COMPUTE_CREDENTIAL_HEADER]: secret,
        },
        body: JSON.stringify({ granted_capabilities: deps.grantedCapabilities() }),
      });
    } catch (error) {
      return {
        ok: false,
        kind: 'sidecar_unavailable',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    if (!response.ok) {
      const failure = await failureFromResponse(response);
      return { ok: false, ...failure };
    }
    const body = (await response.json()) as { tool_count?: unknown };
    return { ok: true, toolCount: typeof body.tool_count === 'number' ? body.tool_count : 0 };
  }

  async function listProviders(): Promise<ComputeProviderSummary[]> {
    const response = await deps.sidecarFetch('/compute/providers', { method: 'GET' });
    if (!response.ok) {
      const failure = await failureFromResponse(response);
      throw new Error(`compute providers unavailable: ${failure.kind}: ${failure.message}`);
    }
    const body = (await response.json()) as { providers: ProviderWire[] };
    const out: ComputeProviderSummary[] = [];
    for (const p of body.providers) {
      out.push(
        providerFromWire(p, {
          connected: await hasComputeCredential(p.id),
          lastVerifiedAt: lastComputeVerification(p.id),
        })
      );
    }
    return out;
  }

  async function installManifest(manifestJson: string): Promise<ComputeManifestInstallResult> {
    if (manifestJson.length > 256_000) {
      return { ok: false, kind: 'invalid_manifest', message: 'Manifest exceeds 256 KB.' };
    }
    let input: unknown;
    try {
      input = JSON.parse(manifestJson);
    } catch {
      return { ok: false, kind: 'invalid_manifest', message: 'Manifest is not valid JSON.' };
    }
    const parsed = parseProviderManifest(input);
    if (!parsed.ok) {
      return { ok: false, kind: 'invalid_manifest', message: parsed.errors.join('\n') };
    }
    if (parsed.manifest.schemaVersion !== 2) {
      return {
        ok: false,
        kind: 'invalid_manifest',
        message: 'Custom compute manifests must use schemaVersion 2.',
      };
    }
    let response: Response;
    try {
      response = await deps.sidecarFetch('/compute/providers/validate-manifest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          granted_capabilities: deps.grantedCapabilities(),
          manifest: parsed.manifest,
        }),
      });
    } catch (error) {
      return {
        ok: false,
        kind: 'sidecar_unavailable',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    if (!response.ok) return manifestFailureFromResponse(response);
    const validated = (await response.json()) as ProviderWire;
    if (!validated.custom || validated.id !== parsed.manifest.id || !validated.has_binding) {
      return {
        ok: false,
        kind: 'invalid_manifest',
        message: 'The sidecar returned an inconsistent manifest validation result.',
      };
    }
    if (!deps.userManifestsDir || !deps.restartSidecar) {
      return {
        ok: false,
        kind: 'persistence_failed',
        message: 'Custom compute endpoint storage is not configured.',
      };
    }
    let target: string;
    try {
      target = await atomicInstallManifest(deps.userManifestsDir, parsed.manifest);
    } catch (error) {
      return {
        ok: false,
        kind:
          error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST'
            ? 'provider_id_conflict'
            : 'persistence_failed',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    try {
      await deps.restartSidecar();
      const providers = await listProviders();
      const installed = providers.find((provider) => provider.id === validated.id);
      if (!installed?.custom || !installed.hasBinding) {
        throw new Error('The restarted compute service did not register the endpoint.');
      }
    } catch (error) {
      await unlink(target).catch(() => undefined);
      await deps.restartSidecar().catch(() => undefined);
      return {
        ok: false,
        kind: 'restart_failed',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    return {
      ok: true,
      providerId: validated.id,
      displayName: validated.display_name,
    };
  }

  async function removeCustomProvider(providerId: string): Promise<ComputeManifestRemoveResult> {
    if (!/^[a-z][a-z0-9_-]{1,63}$/.test(providerId)) {
      return { ok: false, kind: 'not_found', message: 'Unknown custom compute provider.' };
    }
    if (!deps.userManifestsDir || !deps.restartSidecar) {
      return {
        ok: false,
        kind: 'persistence_failed',
        message: 'Custom compute endpoint storage is not configured.',
      };
    }
    const providers = await listProviders();
    const provider = providers.find((candidate) => candidate.id === providerId);
    if (!provider) {
      return { ok: false, kind: 'not_found', message: 'Unknown custom compute provider.' };
    }
    if (!provider.custom) {
      return {
        ok: false,
        kind: 'not_custom',
        message: 'Bundled compute providers cannot be removed.',
      };
    }
    const target = join(deps.userManifestsDir, `${providerId}.json`);
    const tombstone = join(deps.userManifestsDir, `.${providerId}.${randomUUID()}.removed`);
    try {
      await access(target, fsConstants.F_OK);
      await rename(target, tombstone);
    } catch (error) {
      return {
        ok: false,
        kind: 'not_found',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    try {
      await deps.restartSidecar();
      if ((await listProviders()).some((candidate) => candidate.id === providerId)) {
        throw new Error('The restarted compute service still lists the removed endpoint.');
      }
    } catch (error) {
      await rename(tombstone, target).catch(() => undefined);
      await deps.restartSidecar().catch(() => undefined);
      return {
        ok: false,
        kind: 'restart_failed',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    const removedCredential = await deleteComputeCredential(providerId);
    await unlink(tombstone).catch(() => undefined);
    return { ok: true, providerId, removedCredential };
  }

  async function connect(providerId: string, secret: string): Promise<ComputeConnectResult> {
    if (!looksLikeKey(secret)) {
      return { ok: false, kind: 'bad_key_format', message: 'Paste the whole key, without spaces.' };
    }
    const verified = await verifyWithSidecar(providerId, secret.trim());
    if (!verified.ok) return verified;
    try {
      await writeComputeCredential(providerId, secret.trim());
    } catch (error) {
      return {
        ok: false,
        kind: 'keychain_unavailable',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    const verifiedAt = now().toISOString();
    recordComputeVerification(providerId, verifiedAt);
    return { ok: true, providerId, toolCount: verified.toolCount, verifiedAt };
  }

  async function test(providerId: string): Promise<ComputeConnectResult> {
    const secret = await readComputeCredential(providerId);
    if (!secret) {
      return {
        ok: false,
        kind: 'missing_credential',
        message: 'No key is stored for this provider.',
      };
    }
    const verified = await verifyWithSidecar(providerId, secret);
    if (!verified.ok) return verified;
    const verifiedAt = now().toISOString();
    recordComputeVerification(providerId, verifiedAt);
    return { ok: true, providerId, toolCount: verified.toolCount, verifiedAt };
  }

  async function disconnect(providerId: string): Promise<ComputeDisconnectResult> {
    const removed = await deleteComputeCredential(providerId);
    return { ok: true, providerId, removed };
  }

  function jobsOrThrow(): ComputeJobRegistry {
    if (!deps.jobs) throw new Error('compute job registry is not available');
    return deps.jobs;
  }

  async function recordJobIntent(input: ComputeJobIntentInput): Promise<ComputeJobIntentReceipt> {
    return jobsOrThrow().recordIntent(input);
  }
  async function markJobSubmitted(id: string, remoteId: string): Promise<ComputeJobRecord | null> {
    return jobsOrThrow().markSubmitted(id, remoteId);
  }
  async function markJobFailed(id: string, error: string): Promise<ComputeJobRecord | null> {
    return jobsOrThrow().markFailed(id, error);
  }
  async function markJobSubmissionUnknown(
    id: string,
    error: string
  ): Promise<ComputeJobRecord | null> {
    return jobsOrThrow().markSubmissionUnknown(id, error);
  }
  async function markJobCanceled(
    id: string,
    providerState: string
  ): Promise<ComputeJobRecord | null> {
    return jobsOrThrow().markCanceled(id, providerState);
  }
  async function markJobImported(
    id: string,
    paths: string[],
    details?: ComputeImportDetails | null
  ): Promise<ComputeJobRecord | null> {
    return jobsOrThrow().markImported(id, paths, details);
  }
  async function listJobs(options?: ComputeJobsListOptions): Promise<ComputeJobRecord[]> {
    return jobsOrThrow().list(options ?? {});
  }
  async function listJobsSnapshot(
    options?: ComputeJobsSnapshotOptions
  ): Promise<ComputeJobsSnapshot> {
    return jobsOrThrow().snapshot(options);
  }
  async function findJob(providerId: string, remoteId: string): Promise<ComputeJobRecord | null> {
    return jobsOrThrow().findByRemote(providerId, remoteId);
  }

  async function recoverLegacyResult(id: string): Promise<ComputeRecoveryResult> {
    const job = jobsOrThrow().get(id);
    if (!job || job.state !== 'imported' || !job.workspaceRoot || !job.remoteId)
      throw new Error('The imported compute job is unavailable.');
    return jobsOrThrow().recoverLegacyResult(job);
  }

  return {
    recoverLegacyResult,
    listProviders,
    installManifest,
    removeCustomProvider,
    connect,
    test,
    disconnect,
    recordJobIntent,
    markJobSubmitted,
    markJobFailed,
    markJobSubmissionUnknown,
    markJobCanceled,
    markJobImported,
    listJobs,
    listJobsSnapshot,
    findJob,
  };
}

export function registerComputeHandlers(deps: ComputeIpcDeps): void {
  const handlers = createComputeIpcHandlers(deps);
  handleGroup(computeContract, {
    recoverLegacyResult: (_event, id) => handlers.recoverLegacyResult(id),
    listJobsSnapshot: (_event, options) => handlers.listJobsSnapshot(options),
    listProviders: () => handlers.listProviders(),
    installManifest: (_event, manifestJson: string) => handlers.installManifest(manifestJson),
    removeCustomProvider: (_event, providerId: string) => handlers.removeCustomProvider(providerId),
    connect: (_event, providerId: string, secret: string) => handlers.connect(providerId, secret),
    test: (_event, providerId: string) => handlers.test(providerId),
    disconnect: (_event, providerId: string) => handlers.disconnect(providerId),
    recordJobIntent: (_event, input: ComputeJobIntentInput) => handlers.recordJobIntent(input),
    markJobSubmitted: (_event, id: string, remoteId: string) =>
      handlers.markJobSubmitted(id, remoteId),
    markJobFailed: (_event, id: string, error: string) => handlers.markJobFailed(id, error),
    markJobSubmissionUnknown: (_event, id: string, error: string) =>
      handlers.markJobSubmissionUnknown(id, error),
    markJobCanceled: (_event, id: string, providerState: string) =>
      handlers.markJobCanceled(id, providerState),
    markJobImported: (_event, id: string, paths: string[], details?: ComputeImportDetails | null) =>
      handlers.markJobImported(id, paths, details),
    listJobs: (_event, options?: ComputeJobsListOptions) => handlers.listJobs(options),
    findJob: (_event, providerId: string, remoteId: string) =>
      handlers.findJob(providerId, remoteId),
  });
}

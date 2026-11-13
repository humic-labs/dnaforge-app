import {
  userMessage,
  userMessageWithValues,
  userMessageValue,
  type UserMessage,
} from '@waypoint/user-messages';
export type ComputeProviderTransport = 'mcp' | 'rest';
export type ComputeDriverKind = 'mcp-tool-map' | 'nvcf' | 'legacy-rest' | string;
export type ComputeProviderAuthScheme = 'header' | 'bearer' | 'oauth';
export type ComputeCancellationMode = 'provider' | 'unavailable';

export interface ComputeProviderSummary {
  id: string;
  displayName: string;
  summary: string;
  transport: ComputeProviderTransport;
  driver: ComputeDriverKind;
  custom: boolean;
  authScheme: ComputeProviderAuthScheme;
  endpointUrl: string;
  verifyTarget: string;
  credentialHeader: string | null;
  catalog: string;
  jobModel: string;
  cost: string;
  disclosure: string;
  retentionNote: string;
  cancellationMode: ComputeCancellationMode;
  cancellationNote: string;
  docsUrl: string;
  keyPageUrl: string | null;
  termsUrl: string;
  privacyUrl: string;
  hasBinding: boolean;
  connected: boolean;
  lastVerifiedAt: string | null;
}

export type ComputeFailureKind =
  | 'bad_credential'
  | 'budget_exhausted'
  | 'rate_limited'
  | 'provider_unavailable'
  | 'mapped_tool_missing'
  | 'invalid_settings'
  | 'unknown_job'
  | 'circuit_open'
  | 'provider_error'
  | 'missing_credential'
  | 'unknown_provider'
  | 'capability_denied'
  | 'sidecar_unavailable'
  | 'keychain_unavailable'
  | 'bad_key_format';

export interface ComputeConnectFailure {
  ok: false;
  kind: ComputeFailureKind;
  message: string;
}

export interface ComputeConnectSuccess {
  ok: true;
  providerId: string;
  toolCount: number;
  verifiedAt: string;
}

export type ComputeConnectResult = ComputeConnectSuccess | ComputeConnectFailure;

export interface ComputeDisconnectResult {
  ok: true;
  providerId: string;
  removed: boolean;
}

export type ComputeManifestFailureKind =
  | 'invalid_manifest'
  | 'provider_id_conflict'
  | 'unsupported_compute_driver'
  | 'sidecar_unavailable'
  | 'persistence_failed'
  | 'restart_failed';

export type ComputeManifestInstallResult =
  | {
      ok: true;
      providerId: string;
      displayName: string;
    }
  | {
      ok: false;
      kind: ComputeManifestFailureKind;
      message: string;
    };

export type ComputeManifestRemoveResult =
  | { ok: true; providerId: string; removedCredential: boolean }
  | {
      ok: false;
      kind: 'not_custom' | 'not_found' | 'persistence_failed' | 'restart_failed';
      message: string;
    };

export const COMPUTE_CREDENTIAL_HEADER = 'X-DNAForge-Compute-Credential';

export const COMPUTE_KEYRING_SERVICE = 'dnaforge';

export function computeKeyringAccount(providerId: string): string {
  if (!/^[a-z][a-z0-9_-]{1,63}$/.test(providerId)) {
    throw new Error(`invalid compute provider id: ${providerId}`);
  }
  return `${providerId}_compute_key`;
}

export function describeComputeFailure(kind: ComputeFailureKind, displayName: string): UserMessage {
  switch (kind) {
    case 'unknown_provider':
      return userMessage('compute.unknown_provider');
    case 'capability_denied':
      return userMessage('compute.capability_denied');
    case 'sidecar_unavailable':
      return userMessage('compute.sidecar_unavailable');
    case 'keychain_unavailable':
      return userMessage('compute.keychain_unavailable');
    case 'bad_credential':
      return userMessageWithValues('compute.bad_credential', {
        provider: userMessageValue(displayName),
      });
    case 'budget_exhausted':
      return userMessageWithValues('compute.budget_exhausted', {
        provider: userMessageValue(displayName),
      });
    case 'rate_limited':
      return userMessageWithValues('compute.rate_limited', {
        provider: userMessageValue(displayName),
      });
    case 'provider_unavailable':
      return userMessageWithValues('compute.provider_unavailable', {
        provider: userMessageValue(displayName),
      });
    case 'circuit_open':
      return userMessageWithValues('compute.circuit_open', {
        provider: userMessageValue(displayName),
      });
    case 'mapped_tool_missing':
      return userMessageWithValues('compute.mapped_tool_missing', {
        provider: userMessageValue(displayName),
      });
    case 'invalid_settings':
      return userMessageWithValues('compute.invalid_settings', {
        provider: userMessageValue(displayName),
      });
    case 'unknown_job':
      return userMessageWithValues('compute.unknown_job', {
        provider: userMessageValue(displayName),
      });
    case 'missing_credential':
      return userMessageWithValues('compute.missing_credential', {
        provider: userMessageValue(displayName),
      });
    case 'bad_key_format':
      return userMessageWithValues('compute.bad_key_format', {
        provider: userMessageValue(displayName),
      });
    default:
      return userMessageWithValues('compute.provider_error', {
        provider: userMessageValue(displayName),
      });
  }
}

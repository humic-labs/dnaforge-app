import { userMessage, type UserMessage } from '@waypoint/user-messages';
export type AgentGrantKind = 'in-app' | 'stdio-mcp' | 'http-api-key';
export type AgentGrantOrigin = 'app' | 'tool-key' | 'local-mcp' | 'dev-test';
export type AgentGrantStoreSource = 'pending' | 'fixture' | 'connected';

import { configureSidecarApiClient } from '../../services/sidecar-session';
import {
  createApiKeyGrantAgentGrantsApiKeysPost,
  isApiError,
  listAgentGrantsAgentGrantsGet,
  revokeAgentGrantAgentGrantsGrantIdDelete,
} from '@waypoint/api-client';

export interface AgentGrantScopeOption {
  value: string;
  label: UserMessage;
  description: UserMessage;
}

export interface AgentGrant {
  id: string;
  label: string;
  kind: AgentGrantKind;
  origin?: AgentGrantOrigin;
  isDevelopment?: boolean;
  environmentId?: string | null;
  createdBy?: string | null;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  lastCallStatus?: string | null;
  lastToolName?: string | null;
  clientName?: string | null;
  clientVersion?: string | null;
  boundWorkspace?: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface CreateApiKeyGrantInput {
  label: string;
  scopes: string[];
}

export interface CreateApiKeyGrantResult {
  grant: AgentGrant;
  apiKey: string;
}

export interface AgentGrantStoreSnapshot {
  source: AgentGrantStoreSource;
  grants: AgentGrant[];
  hiddenDevelopmentGrantCount: number;
  hasMore: boolean;
  nextCursor: string | null;
}

export interface AgentGrantStoreSnapshotOptions {
  includeDevelopment?: boolean;
  cursor?: string;
}

export const AGENT_GRANT_SCOPE_OPTIONS: readonly AgentGrantScopeOption[] = [
  {
    value: 'read-workspace',
    label: userMessage('permission.read-workspace.label'),
    description: userMessage('permission.read-workspace.description'),
  },
  {
    value: 'write-workspace',
    label: userMessage('permission.write-workspace.label'),
    description: userMessage('permission.write-workspace.description'),
  },
  {
    value: 'edit-primers',
    label: userMessage('permission.edit-primers.label'),
    description: userMessage('permission.edit-primers.description'),
  },
  {
    value: 'edit-protocols',
    label: userMessage('permission.edit-protocols.label'),
    description: userMessage('permission.edit-protocols.description'),
  },
  {
    value: 'finalize-protocol',
    label: userMessage('permission.finalize-protocol.label'),
    description: userMessage('permission.finalize-protocol.description'),
  },
  {
    value: 'modify-tabs',
    label: userMessage('permission.modify-tabs.label'),
    description: userMessage('permission.modify-tabs.description'),
  },
  {
    value: 'create-entity',
    label: userMessage('permission.create-entity.label'),
    description: userMessage('permission.create-entity.description'),
  },
  {
    value: 'read-sequences',
    label: userMessage('permission.read-sequences.label'),
    description: userMessage('permission.read-sequences.description'),
  },
  {
    value: 'edit-assembly',
    label: userMessage('permission.edit-assembly.label'),
    description: userMessage('permission.edit-assembly.description'),
  },
  {
    value: 'finalize-assembly',
    label: userMessage('permission.finalize-assembly.label'),
    description: userMessage('permission.finalize-assembly.description'),
  },
  {
    value: 'modify-settings',
    label: userMessage('permission.modify-settings.label'),
    description: userMessage('permission.modify-settings.description'),
  },
  {
    value: 'submit-feedback',
    label: userMessage('permission.submit-feedback.label'),
    description: userMessage('permission.submit-feedback.description'),
  },
  {
    value: 'manage-agent-access',
    label: userMessage('permission.manage-agent-access.label'),
    description: userMessage('permission.manage-agent-access.description'),
  },
  {
    value: 'external-fetch:annotation',
    label: userMessage('permission.external-fetch:annotation.label'),
    description: userMessage('permission.external-fetch:annotation.description'),
  },
  {
    value: 'external-fetch:xref-resolution',
    label: userMessage('permission.external-fetch:xref-resolution.label'),
    description: userMessage('permission.external-fetch:xref-resolution.description'),
  },
  {
    value: 'external-fetch:structure',
    label: userMessage('permission.external-fetch:structure.label'),
    description: userMessage('permission.external-fetch:structure.description'),
  },
  {
    value: 'external-fetch:paper',
    label: userMessage('permission.external-fetch:paper.label'),
    description: userMessage('permission.external-fetch:paper.description'),
  },
  {
    value: 'external-fetch:homology-search',
    label: userMessage('permission.external-fetch:homology-search.label'),
    description: userMessage('permission.external-fetch:homology-search.description'),
  },
  {
    value: 'external-fetch:bulk-download',
    label: userMessage('permission.external-fetch:bulk-download.label'),
    description: userMessage('permission.external-fetch:bulk-download.description'),
  },
  {
    value: 'external-compute:tm',
    label: userMessage('permission.external-compute:tm.label'),
    description: userMessage('permission.external-compute:tm.description'),
  },
  {
    value: 'external-compute:discover',
    label: userMessage('permission.external-compute:discover.label'),
    description: userMessage('permission.external-compute:discover.description'),
  },
  {
    value: 'external-compute:submit',
    label: userMessage('permission.external-compute:submit.label'),
    description: userMessage('permission.external-compute:submit.description'),
  },
  {
    value: 'external-compute:manage',
    label: userMessage('permission.external-compute:manage.label'),
    description: userMessage('permission.external-compute:manage.description'),
  },
] as const;

const OPT_IN_SCOPES: readonly string[] = [
  'external-compute:submit',
  'external-compute:manage',
  'manage-agent-access',
];
export const DEFAULT_EXTERNAL_ACCESS_KEY_SCOPES = AGENT_GRANT_SCOPE_OPTIONS.map(
  (scope) => scope.value
).filter((scope) => !OPT_IN_SCOPES.includes(scope));

const DEFAULT_ACTIVE_GRANTS: AgentGrant[] = [
  {
    id: 'agent_in_app_strider',
    label: 'In-app Strider',
    kind: 'in-app',
    origin: 'app',
    isDevelopment: false,
    scopes: [
      'read-workspace',
      'edit-primers',
      'edit-assembly',
      'edit-protocols',
      'finalize-protocol',
      'modify-tabs',
      'create-entity',
      'read-sequences',
      'external-fetch:annotation',
      'external-fetch:paper',
    ],
    createdAt: '2026-05-26T15:04:00.000Z',
    lastUsedAt: '2026-05-26T16:52:00.000Z',
    expiresAt: null,
    revokedAt: null,
  },
  {
    id: 'agent_stdio_bridge',
    label: 'MCP stdio bridge',
    kind: 'stdio-mcp',
    origin: 'local-mcp',
    isDevelopment: false,
    scopes: ['read-workspace', 'read-sequences', 'external-fetch:annotation'],
    createdAt: '2026-05-26T14:10:00.000Z',
    lastUsedAt: '2026-05-26T15:41:00.000Z',
    lastCallStatus: 'completed',
    lastToolName: 'get_workspace',
    clientName: 'Claude Code',
    clientVersion: '2.1.0',
    boundWorkspace: '/Users/researcher/plasmids',
    expiresAt: null,
    revokedAt: null,
  },
  {
    id: 'agent_http_bench_script',
    label: 'Bench script key',
    kind: 'http-api-key',
    origin: 'tool-key',
    isDevelopment: false,
    scopes: ['read-workspace', 'external-fetch:annotation'],
    createdAt: '2026-05-26T13:20:00.000Z',
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
  },
];

const DEFAULT_STORE_SOURCE: AgentGrantStoreSource =
  import.meta.env.MODE === 'test' ? 'fixture' : 'connected';

let storeSource: AgentGrantStoreSource = DEFAULT_STORE_SOURCE;
let grants: AgentGrant[] =
  DEFAULT_STORE_SOURCE === 'fixture' ? cloneGrants(DEFAULT_ACTIVE_GRANTS) : [];

export function getInitialAgentGrantStoreSnapshot(
  options: AgentGrantStoreSnapshotOptions = {}
): AgentGrantStoreSnapshot {
  const grantState = activeGrantState(options);
  return {
    source: storeSource,
    grants: grantState.grants,
    hiddenDevelopmentGrantCount: grantState.hiddenDevelopmentGrantCount,
    hasMore: false,
    nextCursor: null,
  };
}

export async function getAgentGrantStoreSnapshot(
  options: AgentGrantStoreSnapshotOptions = {}
): Promise<AgentGrantStoreSnapshot> {
  if (storeSource !== 'connected') {
    return getInitialAgentGrantStoreSnapshot(options);
  }
  return fetchAgentGrantStoreSnapshot(options);
}

export function listActiveAgentGrants(options: AgentGrantStoreSnapshotOptions = {}): AgentGrant[] {
  return activeGrantState(options).grants;
}

function activeGrantState(options: AgentGrantStoreSnapshotOptions): {
  grants: AgentGrant[];
  hiddenDevelopmentGrantCount: number;
} {
  if (storeSource === 'pending') {
    return { grants: [], hiddenDevelopmentGrantCount: 0 };
  }

  const now = Date.now();
  const activeGrants = grants.filter((grant) => {
    if (grant.revokedAt !== null) return false;
    if (grant.expiresAt === null) return true;
    return Date.parse(grant.expiresAt) > now;
  });
  const hiddenDevelopmentGrantCount = activeGrants.filter(
    (grant) => grant.isDevelopment === true
  ).length;
  const visibleGrants = options.includeDevelopment
    ? activeGrants
    : activeGrants.filter((grant) => grant.isDevelopment !== true);
  return {
    grants: cloneGrants(visibleGrants),
    hiddenDevelopmentGrantCount: options.includeDevelopment ? 0 : hiddenDevelopmentGrantCount,
  };
}

export async function revokeAgentGrant(grantId: string): Promise<void> {
  assertGrantStoreWritable();
  if (storeSource === 'connected') {
    await configureSidecarApiClient('Agent grants');
    try {
      const response = await revokeAgentGrantAgentGrantsGrantIdDelete(grantId);
      assertSuccessfulAgentGrantEnvelope(response.data as Record<string, unknown>);
    } catch (error) {
      rethrowAgentGrantRequestError(error);
    }
    return;
  }
  const revokedAt = new Date().toISOString();
  grants = grants.map((grant) => (grant.id === grantId ? { ...grant, revokedAt } : grant));
}

export async function createApiKeyAgentGrant(
  input: CreateApiKeyGrantInput
): Promise<CreateApiKeyGrantResult> {
  assertGrantStoreWritable();
  const label = input.label.trim();
  const scopes = dedupe(input.scopes);
  if (!label) {
    throw new Error('External access key name is required.');
  }
  if (scopes.length === 0) {
    throw new Error('Select at least one allowed action.');
  }

  if (storeSource === 'connected') {
    await configureSidecarApiClient('Agent grants');
    let response: Awaited<ReturnType<typeof createApiKeyGrantAgentGrantsApiKeysPost>>;
    try {
      response = await createApiKeyGrantAgentGrantsApiKeysPost({ label, scopes });
    } catch (error) {
      rethrowAgentGrantRequestError(error);
    }
    const data = response.data as Record<string, unknown>;
    assertSuccessfulAgentGrantEnvelope(data);
    return parseCreateApiKeyResult(data);
  }

  const id = `agent_http_${Date.now().toString(36)}_${randomTokenSuffix(4)}`;
  const grant: AgentGrant = {
    id,
    label,
    kind: 'http-api-key',
    origin: 'tool-key',
    isDevelopment: false,
    scopes,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
  };
  grants = [grant, ...grants];
  return {
    grant: { ...grant, scopes: [...grant.scopes] },
    apiKey: `dna_mock_${randomTokenSuffix(24)}`,
  };
}

export function __resetAgentGrantsForTests(
  next: AgentGrant[] = DEFAULT_ACTIVE_GRANTS,
  source: AgentGrantStoreSource = 'fixture'
): void {
  storeSource = source;
  grants = cloneGrants(next);
}

function assertGrantStoreWritable(): void {
  if (storeSource === 'pending') {
    throw new Error('Grant store is not connected yet.');
  }
}

async function fetchAgentGrantStoreSnapshot(
  options: AgentGrantStoreSnapshotOptions
): Promise<AgentGrantStoreSnapshot> {
  await configureSidecarApiClient('Agent grants');
  let data: Record<string, unknown>;
  try {
    const response = await listAgentGrantsAgentGrantsGet({
      includeDevTest: options.includeDevelopment,
      cursor: options.cursor,
    });
    data = response.data as Record<string, unknown>;
    assertSuccessfulAgentGrantEnvelope(data);
  } catch (error) {
    rethrowAgentGrantRequestError(error);
  }
  const rawGrants = Array.isArray(data.grants) ? data.grants : [];
  return {
    source: 'connected',
    grants: rawGrants.map(parseAgentGrant).filter((grant): grant is AgentGrant => grant !== null),
    hiddenDevelopmentGrantCount:
      typeof data.hiddenDevelopmentGrantCount === 'number' ? data.hiddenDevelopmentGrantCount : 0,
    hasMore: data.hasMore === true,
    nextCursor: typeof data.nextCursor === 'string' ? data.nextCursor : null,
  };
}

function parseCreateApiKeyResult(data: Record<string, unknown>): CreateApiKeyGrantResult {
  const grant = parseAgentGrant(data.grant);
  const apiKey = typeof data.apiKey === 'string' ? data.apiKey : '';
  if (!grant || !apiKey) {
    throw new Error('Agent grant response was missing the new API key.');
  }
  return { grant, apiKey };
}

function parseAgentGrant(value: unknown): AgentGrant | null {
  if (value === null || typeof value !== 'object') return null;
  const grant = value as Record<string, unknown>;
  const id = stringField(grant.id);
  const label = stringField(grant.label);
  const kind = parseGrantKind(grant.kind);
  if (!id || !label || !kind) return null;
  const scopes = Array.isArray(grant.scopes)
    ? grant.scopes.filter((scope): scope is string => typeof scope === 'string')
    : [];
  return {
    id,
    label,
    kind,
    origin: parseGrantOrigin(grant.origin),
    isDevelopment: grant.isDevelopment === true,
    environmentId: nullableStringField(grant.environmentId),
    createdBy: nullableStringField(grant.createdBy),
    scopes,
    createdAt: stringField(grant.createdAt) ?? new Date(0).toISOString(),
    lastUsedAt: nullableStringField(grant.lastUsedAt),
    lastCallStatus: nullableStringField(grant.lastCallStatus),
    lastToolName: nullableStringField(grant.lastToolName),
    clientName: nullableStringField(grant.clientName),
    clientVersion: nullableStringField(grant.clientVersion),
    boundWorkspace: nullableStringField(grant.boundWorkspace),
    expiresAt: nullableStringField(grant.expiresAt),
    revokedAt: nullableStringField(grant.revokedAt),
  };
}

function parseGrantKind(value: unknown): AgentGrantKind | null {
  return value === 'in-app' || value === 'stdio-mcp' || value === 'http-api-key' ? value : null;
}

function parseGrantOrigin(value: unknown): AgentGrantOrigin | undefined {
  return value === 'app' || value === 'tool-key' || value === 'local-mcp' || value === 'dev-test'
    ? value
    : undefined;
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function nullableStringField(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function extractAgentGrantError(data: Record<string, unknown>, fallback: string): string {
  const error = data.error;
  if (error !== null && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return fallback || 'Agent grant request failed.';
}

function assertSuccessfulAgentGrantEnvelope(data: Record<string, unknown>): void {
  if (data.ok === false) {
    throw new Error(extractAgentGrantError(data, 'Agent grant request failed.'));
  }
}

function rethrowAgentGrantRequestError(error: unknown): never {
  if (isApiError(error)) {
    throw new Error(
      extractAgentGrantError((error.body ?? {}) as Record<string, unknown>, error.statusText)
    );
  }
  throw error;
}

function cloneGrants(source: AgentGrant[]): AgentGrant[] {
  return source.map((grant) => ({ ...grant, scopes: [...grant.scopes] }));
}

function dedupe(scopes: string[]): string[] {
  return scopes.filter((scope, index) => scope && scopes.indexOf(scope) === index);
}

function randomTokenSuffix(length: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(length);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}

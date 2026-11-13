const CONTROL_RESPONSE_MAX_BYTES = 256 * 1024;
const ARGUMENTS_MAX_BYTES = 16 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type HostedBrowserProposalToolName = 'workspace.metadata_read' | 'workspace.file_remove';

export type HostedBrowserProposalEffectOutcomeCode =
  | 'proposal_expired'
  | 'unsupported_effect'
  | 'workspace_not_writable'
  | 'stale_proposal'
  | 'effect_conflict'
  | 'effect_unavailable';

export interface HostedBrowserProposalSnapshot {
  readonly proposal_id: string;
  readonly workspace_id: string;
  readonly version_id: string;
  readonly version_sha256: string;
  readonly tool_name: HostedBrowserProposalToolName;
  readonly arguments: Record<string, unknown>;
  readonly arguments_sha256: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly decision: 'approved' | 'denied' | null;
  readonly decided_at: string | null;
  readonly status: 'pending' | 'approved' | 'denied' | 'expired';
  readonly execution:
    | {
        readonly status: 'claimed';
        readonly claim_id: string;
        readonly claimed_at: string;
      }
    | {
        readonly status: 'completed';
        readonly claim_id: string;
        readonly receipt_id: string;
        readonly claimed_at: string;
        readonly completed_at: string;
        readonly effect_receipt_sha256: string;
        readonly result: Record<string, unknown>;
      }
    | {
        readonly status: 'failed' | 'unavailable';
        readonly outcome_id: string;
        readonly error_code: HostedBrowserProposalEffectOutcomeCode;
        readonly recorded_at: string;
      }
    | null;
}

export class HostedBrowserProposalError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'HostedBrowserProposalError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

function isSafeWorkspacePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 1_024 &&
    value === value.trim() &&
    !hasControlCharacters(value) &&
    !value.startsWith('/') &&
    !value.startsWith('\\') &&
    !/^[A-Za-z]:/u.test(value) &&
    !value.includes('\\') &&
    !/(^|\/)\.\.?($|\/)/u.test(value) &&
    !value.includes('//')
  );
}

function validArguments(
  toolName: HostedBrowserProposalToolName,
  value: Record<string, unknown>,
  workspaceId?: string,
  versionId?: string
): boolean {
  if (toolName === 'workspace.metadata_read') {
    return (
      Object.keys(value).length === 3 &&
      isUuid(value.workspace_id) &&
      isUuid(value.version_id) &&
      (workspaceId === undefined || value.workspace_id === workspaceId) &&
      (versionId === undefined || value.version_id === versionId) &&
      Array.isArray(value.include) &&
      value.include.length === 1 &&
      value.include[0] === 'metadata'
    );
  }
  return Object.keys(value).length === 1 && isSafeWorkspacePath(value.path);
}

function invalidRequest(message: string): HostedBrowserProposalError {
  return new HostedBrowserProposalError(400, 'INVALID_REQUEST', message);
}

function invalidResponse(): HostedBrowserProposalError {
  return new HostedBrowserProposalError(
    502,
    'BAD_RESPONSE',
    'The browser proposal projection was invalid.'
  );
}

function parseSnapshot(value: unknown): HostedBrowserProposalSnapshot {
  if (!isRecord(value)) throw invalidResponse();
  const decision = value.decision;
  const status = value.status;
  const execution = value.execution === undefined ? null : value.execution;
  if (
    !isUuid(value.proposal_id) ||
    !isUuid(value.workspace_id) ||
    !isUuid(value.version_id) ||
    !isSha256(value.version_sha256) ||
    (value.tool_name !== 'workspace.metadata_read' &&
      value.tool_name !== 'workspace.file_remove') ||
    !isRecord(value.arguments) ||
    !validArguments(value.tool_name as HostedBrowserProposalToolName, value.arguments) ||
    !isSha256(value.arguments_sha256) ||
    !boundedString(value.created_at, 64) ||
    !boundedString(value.expires_at, 64) ||
    (decision !== null && decision !== 'approved' && decision !== 'denied') ||
    (value.decided_at !== null && !boundedString(value.decided_at, 64)) ||
    (status !== 'pending' &&
      status !== 'approved' &&
      status !== 'denied' &&
      status !== 'expired') ||
    !validExecution(execution)
  ) {
    throw invalidResponse();
  }
  return {
    proposal_id: value.proposal_id,
    workspace_id: value.workspace_id,
    version_id: value.version_id,
    version_sha256: value.version_sha256,
    tool_name: value.tool_name as HostedBrowserProposalToolName,
    arguments: value.arguments,
    arguments_sha256: value.arguments_sha256,
    created_at: value.created_at,
    expires_at: value.expires_at,
    decision,
    decided_at: value.decided_at,
    status,
    execution: execution as HostedBrowserProposalSnapshot['execution'],
  };
}

function validExecution(value: unknown): boolean {
  if (value === null) return true;
  if (!isRecord(value)) {
    return false;
  }
  if (value.status === 'claimed') {
    return isUuid(value.claim_id) && boundedString(value.claimed_at, 64);
  }
  if (value.status === 'completed') {
    return (
      isUuid(value.claim_id) &&
      isUuid(value.receipt_id) &&
      boundedString(value.claimed_at, 64) &&
      boundedString(value.completed_at, 64) &&
      isSha256(value.effect_receipt_sha256) &&
      isRecord(value.result)
    );
  }
  return (
    (value.status === 'failed' || value.status === 'unavailable') &&
    isUuid(value.outcome_id) &&
    boundedString(value.recorded_at, 64) &&
    (value.error_code === 'proposal_expired' ||
      value.error_code === 'unsupported_effect' ||
      value.error_code === 'workspace_not_writable' ||
      value.error_code === 'stale_proposal' ||
      value.error_code === 'effect_conflict' ||
      value.error_code === 'effect_unavailable')
  );
}

function errorFromResponse(status: number, value: unknown): HostedBrowserProposalError {
  const code = isRecord(value) && typeof value.error === 'string' ? value.error : 'UNAVAILABLE';
  if (status === 401) {
    return new HostedBrowserProposalError(
      status,
      code,
      'Sign in again before creating or deciding a browser proposal.'
    );
  }
  if (status === 403) {
    return new HostedBrowserProposalError(
      status,
      code,
      'This browser session cannot create or decide that proposal.'
    );
  }
  if (status === 404) {
    return new HostedBrowserProposalError(status, code, 'The browser proposal is unavailable.');
  }
  if (status === 409) {
    return new HostedBrowserProposalError(
      status,
      code,
      code === 'stale_proposal'
        ? 'The inspected revision changed; inspect the workspace again before deciding.'
        : code === 'proposal_not_approved'
          ? 'Approve the browser proposal before executing it.'
          : code === 'effect_conflict'
            ? 'The proposed workspace effect could not be applied.'
            : 'The browser proposal decision was refused.'
    );
  }
  if (status === 503 && code === 'effect_unavailable') {
    return new HostedBrowserProposalError(
      status,
      code,
      'The approved browser effect was unavailable and no workspace change was applied. Create a new proposal after inspecting the current revision.'
    );
  }
  return new HostedBrowserProposalError(
    status,
    code,
    'The browser proposal service is unavailable.'
  );
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > CONTROL_RESPONSE_MAX_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new HostedBrowserProposalError(
      502,
      'OVERSIZED_RESPONSE',
      'The browser proposal response was too large.'
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > CONTROL_RESPONSE_MAX_BYTES) {
    throw new HostedBrowserProposalError(
      502,
      'OVERSIZED_RESPONSE',
      'The browser proposal response was too large.'
    );
  }
  if (bytes.byteLength === 0) return {};
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw invalidResponse();
  }
}

async function requestProposal(
  path: string,
  init: RequestInit
): Promise<HostedBrowserProposalSnapshot> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
      signal: init.signal ?? AbortSignal.timeout(8_000),
    });
  } catch {
    throw new HostedBrowserProposalError(
      503,
      'UNAVAILABLE',
      'The browser proposal service is unavailable.'
    );
  }
  const body = await readJsonResponse(response);
  if (!response.ok) throw errorFromResponse(response.status, body);
  return parseSnapshot(body);
}

function assertProposalIdentifiers(workspaceId: string, versionId: string): void {
  if (!isUuid(workspaceId) || !isUuid(versionId)) {
    throw invalidRequest('The workspace or revision identifier is invalid.');
  }
}

function assertArguments(argumentsPayload: Record<string, unknown>): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(argumentsPayload);
  } catch {
    throw invalidRequest('The browser proposal arguments are not serializable.');
  }
  if (new TextEncoder().encode(serialized).byteLength > ARGUMENTS_MAX_BYTES) {
    throw invalidRequest('The browser proposal arguments are too large.');
  }
}

export async function createHostedBrowserProposal(args: {
  readonly workspaceId: string;
  readonly versionId: string;
  readonly versionSha256: string;
  readonly toolName?: HostedBrowserProposalToolName;
  readonly argumentsPayload: Record<string, unknown>;
  readonly idempotencyKey: string;
}): Promise<HostedBrowserProposalSnapshot> {
  assertProposalIdentifiers(args.workspaceId, args.versionId);
  if (!isSha256(args.versionSha256) || !boundedString(args.idempotencyKey, 200)) {
    throw invalidRequest('The browser proposal identifiers are invalid.');
  }
  assertArguments(args.argumentsPayload);
  const toolName = args.toolName ?? 'workspace.metadata_read';
  if (!validArguments(toolName, args.argumentsPayload, args.workspaceId, args.versionId)) {
    throw invalidRequest('The browser proposal arguments do not match the selected tool.');
  }
  return requestProposal('/v1/hosted/browser/proposals', {
    method: 'POST',
    body: JSON.stringify({
      workspace_id: args.workspaceId,
      version_id: args.versionId,
      version_sha256: args.versionSha256,
      tool_name: toolName,
      arguments: args.argumentsPayload,
      idempotency_key: args.idempotencyKey,
    }),
  });
}

export async function executeHostedBrowserProposal(args: {
  readonly proposalId: string;
  readonly idempotencyKey: string;
}): Promise<HostedBrowserProposalSnapshot> {
  if (!isUuid(args.proposalId) || !boundedString(args.idempotencyKey, 200)) {
    throw invalidRequest('The browser proposal execution is invalid.');
  }
  return requestProposal(`/v1/hosted/browser/proposals/${args.proposalId}/execute`, {
    method: 'POST',
    body: JSON.stringify({ idempotency_key: args.idempotencyKey }),
  });
}

export async function loadHostedBrowserProposal(
  proposalId: string
): Promise<HostedBrowserProposalSnapshot> {
  if (!isUuid(proposalId)) throw invalidRequest('The browser proposal identifier is invalid.');
  return requestProposal(`/v1/hosted/browser/proposals/${proposalId}`, { method: 'GET' });
}

export async function decideHostedBrowserProposal(args: {
  readonly proposalId: string;
  readonly decision: 'approve' | 'deny';
  readonly idempotencyKey: string;
}): Promise<HostedBrowserProposalSnapshot> {
  if (
    !isUuid(args.proposalId) ||
    (args.decision !== 'approve' && args.decision !== 'deny') ||
    !boundedString(args.idempotencyKey, 200)
  ) {
    throw invalidRequest('The browser proposal decision is invalid.');
  }
  return requestProposal(`/v1/hosted/browser/proposals/${args.proposalId}/decision`, {
    method: 'POST',
    body: JSON.stringify({ decision: args.decision, idempotency_key: args.idempotencyKey }),
  });
}

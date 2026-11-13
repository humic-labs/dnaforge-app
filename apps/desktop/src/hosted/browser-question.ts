import {
  parseHostedBrowserWorkspaceReadProjection,
  type HostedBrowserWorkspaceReadProjection,
} from './browser-workspace-read';

const CONTROL_RESPONSE_MAX_BYTES = 256 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface HostedBrowserQuestionObservation {
  readonly status: 'read_observation';
  readonly question: string;
  readonly tool_name: 'workspace.metadata_read';
  readonly arguments: {
    readonly workspace_id: string;
    readonly version_id: string;
    readonly include: readonly ['metadata'];
  };
  readonly idempotency_key: string;
  readonly workspace: HostedBrowserWorkspaceReadProjection;
}

export class HostedBrowserQuestionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'HostedBrowserQuestionError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}

function invalidRequest(message: string): HostedBrowserQuestionError {
  return new HostedBrowserQuestionError(400, 'INVALID_REQUEST', message);
}

function invalidResponse(): HostedBrowserQuestionError {
  return new HostedBrowserQuestionError(
    502,
    'BAD_RESPONSE',
    'The browser question observation was invalid.'
  );
}

function parseObservation(value: unknown): HostedBrowserQuestionObservation {
  if (!isRecord(value)) throw invalidResponse();
  const args = value.arguments;
  if (
    value.status !== 'read_observation' ||
    !boundedString(value.question, 1_024) ||
    value.tool_name !== 'workspace.metadata_read' ||
    !isRecord(args) ||
    !isUuid(args.workspace_id) ||
    !isUuid(args.version_id) ||
    !Array.isArray(args.include) ||
    args.include.length !== 1 ||
    args.include[0] !== 'metadata' ||
    !boundedString(value.idempotency_key, 200) ||
    !isRecord(value.workspace)
  ) {
    throw invalidResponse();
  }
  const workspace = parseHostedBrowserWorkspaceReadProjection(value.workspace);
  if (workspace.workspace.id !== args.workspace_id || workspace.version?.id !== args.version_id) {
    throw invalidResponse();
  }
  return {
    status: 'read_observation',
    question: value.question,
    tool_name: 'workspace.metadata_read',
    arguments: {
      workspace_id: args.workspace_id,
      version_id: args.version_id,
      include: ['metadata'],
    },
    idempotency_key: value.idempotency_key,
    workspace,
  };
}

function errorFromResponse(status: number, value: unknown): HostedBrowserQuestionError {
  const code = isRecord(value) && typeof value.error === 'string' ? value.error : 'UNAVAILABLE';
  if (status === 401) {
    return new HostedBrowserQuestionError(
      status,
      code,
      'Sign in again before asking a browser workspace question.'
    );
  }
  if (status === 404) {
    return new HostedBrowserQuestionError(status, code, 'The hosted workspace is unavailable.');
  }
  if (status === 413) {
    return new HostedBrowserQuestionError(
      status,
      code,
      'This workspace is too large for a bounded browser question.'
    );
  }
  return new HostedBrowserQuestionError(
    status,
    code,
    'The browser question service is unavailable.'
  );
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > CONTROL_RESPONSE_MAX_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new HostedBrowserQuestionError(
      502,
      'OVERSIZED_RESPONSE',
      'The browser question response was too large.'
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > CONTROL_RESPONSE_MAX_BYTES) {
    throw new HostedBrowserQuestionError(
      502,
      'OVERSIZED_RESPONSE',
      'The browser question response was too large.'
    );
  }
  if (bytes.byteLength === 0) return {};
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw invalidResponse();
  }
}

export async function askHostedBrowserQuestion(args: {
  readonly workspaceId: string;
  readonly versionId: string;
  readonly question: string;
  readonly idempotencyKey: string;
}): Promise<HostedBrowserQuestionObservation> {
  if (
    !isUuid(args.workspaceId) ||
    !isUuid(args.versionId) ||
    !boundedString(args.question, 1_024) ||
    !boundedString(args.idempotencyKey, 200)
  ) {
    throw invalidRequest('The browser question request is invalid.');
  }
  let response: Response;
  try {
    response = await fetch('/v1/hosted/browser/question', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspace_id: args.workspaceId,
        version_id: args.versionId,
        question: args.question,
        tool_name: 'workspace.metadata_read',
        arguments: {
          workspace_id: args.workspaceId,
          version_id: args.versionId,
          include: ['metadata'],
        },
        idempotency_key: args.idempotencyKey,
      }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new HostedBrowserQuestionError(
      503,
      'UNAVAILABLE',
      'The browser question service is unavailable.'
    );
  }
  const body = await readJsonResponse(response);
  if (!response.ok) throw errorFromResponse(response.status, body);
  return parseObservation(body);
}

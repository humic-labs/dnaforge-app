const CONTROL_RESPONSE_MAX_BYTES = 256 * 1024;
const MAX_FILES = 200;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface HostedBrowserWorkspaceReadProjection {
  readonly workspace: {
    readonly id: string;
    readonly display_name: string;
    readonly owner_kind: 'personal' | 'org';
  };
  readonly version: {
    readonly id: string;
    readonly version_number: number;
    readonly content_sha256: string;
    readonly size_bytes: number;
    readonly file_count: number;
    readonly created_at: string;
  } | null;
  readonly files: readonly {
    readonly path: string;
    readonly resource_id: string;
    readonly content_sha256: string;
    readonly size_bytes: number;
    readonly content_type: string;
  }[];
}

export class HostedBrowserWorkspaceReadError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'HostedBrowserWorkspaceReadError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function parseHostedBrowserWorkspaceReadProjection(
  value: unknown
): HostedBrowserWorkspaceReadProjection {
  if (!isRecord(value)) throw invalidResponse();
  const workspace = value.workspace;
  if (
    !isRecord(workspace) ||
    !isUuid(workspace.id) ||
    !boundedString(workspace.display_name, 256) ||
    (workspace.owner_kind !== 'personal' && workspace.owner_kind !== 'org')
  ) {
    throw invalidResponse();
  }

  const versionValue = value.version;
  let version: HostedBrowserWorkspaceReadProjection['version'] = null;
  if (versionValue !== null) {
    if (
      !isRecord(versionValue) ||
      !isUuid(versionValue.id) ||
      !isNonNegativeSafeInteger(versionValue.version_number) ||
      !isSha256(versionValue.content_sha256) ||
      !isNonNegativeSafeInteger(versionValue.size_bytes) ||
      !isNonNegativeSafeInteger(versionValue.file_count) ||
      !boundedString(versionValue.created_at, 64)
    ) {
      throw invalidResponse();
    }
    version = {
      id: versionValue.id,
      version_number: versionValue.version_number,
      content_sha256: versionValue.content_sha256,
      size_bytes: versionValue.size_bytes,
      file_count: versionValue.file_count,
      created_at: versionValue.created_at,
    };
  }

  if (!Array.isArray(value.files) || value.files.length > MAX_FILES) throw invalidResponse();
  const files = value.files.map((file): HostedBrowserWorkspaceReadProjection['files'][number] => {
    if (
      !isRecord(file) ||
      !boundedString(file.path, 1024) ||
      !isUuid(file.resource_id) ||
      !isSha256(file.content_sha256) ||
      !isNonNegativeSafeInteger(file.size_bytes) ||
      !boundedString(file.content_type, 128)
    ) {
      throw invalidResponse();
    }
    return {
      path: file.path,
      resource_id: file.resource_id,
      content_sha256: file.content_sha256,
      size_bytes: file.size_bytes,
      content_type: file.content_type,
    };
  });

  return {
    workspace: {
      id: workspace.id,
      display_name: workspace.display_name,
      owner_kind: workspace.owner_kind,
    },
    version,
    files,
  };
}

function invalidResponse(): HostedBrowserWorkspaceReadError {
  return new HostedBrowserWorkspaceReadError(
    502,
    'BAD_RESPONSE',
    'The browser workspace projection was invalid.'
  );
}

function errorFromResponse(status: number, value: unknown): HostedBrowserWorkspaceReadError {
  const code = isRecord(value) && typeof value.error === 'string' ? value.error : 'UNAVAILABLE';
  if (status === 401) {
    return new HostedBrowserWorkspaceReadError(
      status,
      code,
      'Sign in again to inspect the hosted workspace.'
    );
  }
  if (status === 404) {
    return new HostedBrowserWorkspaceReadError(
      status,
      code,
      'The hosted workspace is unavailable.'
    );
  }
  if (status === 413) {
    return new HostedBrowserWorkspaceReadError(
      status,
      code,
      'This workspace is too large for a bounded browser read.'
    );
  }
  return new HostedBrowserWorkspaceReadError(
    status,
    code,
    'The browser-safe workspace read is unavailable.'
  );
}

export async function loadHostedBrowserWorkspaceRead(args: {
  readonly workspaceId: string;
  readonly versionId?: string | null;
}): Promise<HostedBrowserWorkspaceReadProjection> {
  if (
    !isUuid(args.workspaceId) ||
    (args.versionId !== undefined && args.versionId !== null && !isUuid(args.versionId))
  ) {
    throw new HostedBrowserWorkspaceReadError(
      400,
      'INVALID_REQUEST',
      'The hosted workspace identifier is invalid.'
    );
  }
  const query = new URLSearchParams({ workspace_id: args.workspaceId });
  if (args.versionId) query.set('version_id', args.versionId);
  let response: Response;
  try {
    response = await fetch(`/v1/hosted/browser/workspace?${query.toString()}`, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new HostedBrowserWorkspaceReadError(
      503,
      'UNAVAILABLE',
      'The browser-safe workspace read is unavailable.'
    );
  }

  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > CONTROL_RESPONSE_MAX_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new HostedBrowserWorkspaceReadError(
      502,
      'OVERSIZED_RESPONSE',
      'The browser workspace projection was too large.'
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > CONTROL_RESPONSE_MAX_BYTES) {
    throw new HostedBrowserWorkspaceReadError(
      502,
      'OVERSIZED_RESPONSE',
      'The browser workspace projection was too large.'
    );
  }
  let body: unknown;
  try {
    body = bytes.byteLength === 0 ? {} : JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw invalidResponse();
  }
  if (!response.ok) throw errorFromResponse(response.status, body);
  return parseHostedBrowserWorkspaceReadProjection(body);
}

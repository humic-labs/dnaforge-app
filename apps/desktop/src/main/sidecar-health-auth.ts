const SESSION_NOT_CONFIGURED = 'MCP_SESSION_NOT_CONFIGURED';

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function readSidecarSessionErrorCode(body: unknown): string | null {
  const envelope = record(body);
  if (!envelope) return null;

  for (const key of ['error', 'detail'] as const) {
    const candidate = record(envelope[key]);
    if (candidate && typeof candidate.code === 'string') return candidate.code;
  }

  return typeof envelope.code === 'string' ? envelope.code : null;
}

export function isSidecarOwnershipMismatch(status: number, body: unknown): boolean {
  if (status === 401) return true;
  return status === 500 && readSidecarSessionErrorCode(body) === SESSION_NOT_CONFIGURED;
}

export type RendererToolError = {
  code: string;
  domain: 'structure-mcp' | 'sequence-mcp';
  message: string;
  retriable: boolean;
  details?: Record<string, unknown>;
};

export function throwStructureError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  retriable = code === 'VIEWER_NOT_FOUND'
): never {
  throw {
    code,
    domain: 'structure-mcp',
    message,
    retriable,
    ...(details ? { details } : {}),
  } satisfies RendererToolError;
}

export function throwSequenceError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  retriable = false
): never {
  throw {
    code,
    domain: 'sequence-mcp',
    message,
    retriable,
    ...(details ? { details } : {}),
  } satisfies RendererToolError;
}

export function isRendererToolError(error: unknown): error is RendererToolError {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as Partial<RendererToolError>;
  return (
    typeof candidate.code === 'string' &&
    typeof candidate.message === 'string' &&
    typeof candidate.retriable === 'boolean'
  );
}

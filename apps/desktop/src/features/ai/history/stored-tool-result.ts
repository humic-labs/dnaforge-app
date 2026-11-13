export interface StoredToolResult {
  input?: unknown;
  output?: unknown;
  isError?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isRecordedToolResultSuccessful(result: StoredToolResult): boolean {
  if (result.isError) return false;
  if (!isRecord(result.output)) return true;
  if (result.output.ok === false) return false;
  if (typeof result.output.error === 'string' && result.output.error.trim().length > 0) {
    return false;
  }
  if ('tabId' in result.output && result.output.tabId === '') return false;
  return true;
}

export interface WorkspaceTextFileAtomicWriteInput {
  workspaceRoot: string;
  path: string;
  content: string;
  mode: 'create' | 'replace';
  mutationToken?: string;
  expectedContentHash?: string;
  artifactNoun?: string;
}

export interface WorkspaceTextFileAtomicWriteResult {
  path: string;
  contentHash: string;
  cleanupWarning?: string;
}

export const MAX_WORKSPACE_BINARY_WRITE_BYTES = 25 * 1024 * 1024;

export interface WorkspaceBinaryFileAtomicWriteInput {
  workspaceRoot: string;
  path: string;
  content: Uint8Array;
  mutationToken?: string;
  artifactNoun?: string;
}

export interface WorkspaceTextFileAtomicPartialEffect {
  kind: 'temporary-workspace-file';
  path: string;
  cleanupError: string;
}

export type WorkspaceTextFileAtomicWriteResponse =
  | {
      ok: true;
      result: WorkspaceTextFileAtomicWriteResult;
    }
  | {
      ok: false;
      error: {
        name: string;
        message: string;
        code?: string;
        retriable?: true;
        partialEffects: WorkspaceTextFileAtomicPartialEffect[];
      };
    };

function atomicPartialEffects(error: unknown): WorkspaceTextFileAtomicPartialEffect[] {
  if (!error || typeof error !== 'object') return [];
  const candidate = (error as { partialEffects?: unknown }).partialEffects;
  if (!Array.isArray(candidate)) return [];
  return candidate.filter(
    (effect): effect is WorkspaceTextFileAtomicPartialEffect =>
      effect !== null &&
      typeof effect === 'object' &&
      !Array.isArray(effect) &&
      (effect as { kind?: unknown }).kind === 'temporary-workspace-file' &&
      typeof (effect as { path?: unknown }).path === 'string' &&
      typeof (effect as { cleanupError?: unknown }).cleanupError === 'string'
  );
}

export function serializeWorkspaceTextFileAtomicWriteFailure(
  error: unknown
): WorkspaceTextFileAtomicWriteResponse {
  const candidate = error && typeof error === 'object' ? error : null;
  const code =
    candidate && typeof (candidate as { code?: unknown }).code === 'string'
      ? (candidate as { code: string }).code
      : undefined;
  const retriable =
    candidate && (candidate as { retriable?: unknown }).retriable === true ? true : undefined;
  return {
    ok: false,
    error: {
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
      ...(code ? { code } : {}),
      ...(retriable ? { retriable } : {}),
      partialEffects: atomicPartialEffects(error),
    },
  };
}

export function unwrapWorkspaceTextFileAtomicWriteResponse(
  response: WorkspaceTextFileAtomicWriteResponse
): WorkspaceTextFileAtomicWriteResult {
  if (response.ok) return response.result;
  const reconstructed = new Error(response.error.message) as Error & {
    code?: string;
    retriable?: true;
    partialEffects: WorkspaceTextFileAtomicPartialEffect[];
  };
  reconstructed.name = response.error.name;
  if (response.error.code) reconstructed.code = response.error.code;
  if (response.error.retriable) reconstructed.retriable = true;
  reconstructed.partialEffects = response.error.partialEffects;
  throw reconstructed;
}

export interface WorkspacePathValidationInput {
  workspaceRoot: string;
  path: string;
  allowMissing?: boolean;
  artifactNoun?: string;
}

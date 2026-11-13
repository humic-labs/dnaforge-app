export type CodexAuthMode = 'chatgpt' | 'apikey' | null;

export const CODEX_MODELS_UNSUPPORTED_WITH_CHATGPT = new Set(['gpt-5-codex', 'gpt-5', 'o3']);

export function isCodexModelSupportedForAuth(
  model: string,
  authMode: CodexAuthMode | undefined
): boolean {
  return !(authMode === 'chatgpt' && CODEX_MODELS_UNSUPPORTED_WITH_CHATGPT.has(model.trim()));
}

const ENV_VAR_MAP: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
  xai: 'XAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
};

function looksLikeRealKey(key: string): boolean {
  if (key.length < 10) return false;
  const lower = key.toLowerCase();
  return !lower.includes('your-') && !lower.includes('paste-') && !lower.includes('-here');
}

export function getTestApiKey(provider: string): string | null {
  const envVar = ENV_VAR_MAP[provider];
  if (!envVar) return null;

  const value = process.env[envVar];
  if (!value || !looksLikeRealKey(value)) return null;
  return value;
}

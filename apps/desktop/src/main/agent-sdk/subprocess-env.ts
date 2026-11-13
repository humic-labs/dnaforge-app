// @vendor-credential-boundary: scrub
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export type SubprocessTarget = 'claude' | 'codex' | 'grok' | 'sidecar';

export type ConstructedEnv = Record<string, string>;

export type ClaudeCliEnv = ConstructedEnv;

export function resolveAmbientGrokAuthPath(input: {
  userHome: string;
  ambientGrokHome?: string;
  ambientAuthPath?: string;
}): string {
  const grokHome = input.ambientGrokHome?.trim() || join(input.userHome, '.grok');
  return input.ambientAuthPath?.trim() || join(grokHome, 'auth.json');
}

const STRIPPED_CLAUDE_CODE_ENV = new Set([
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_SESSION_ACCESS_TOKEN',
  'CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR',
  'CLAUDE_CODE_REMOTE',
  'CLAUDE_SESSION_INGRESS_TOKEN_FILE',
]);

function isClaudeAmbientAuth(upper: string): boolean {
  if (upper.startsWith('ANTHROPIC_')) return true;
  if (STRIPPED_CLAUDE_CODE_ENV.has(upper)) return true;
  if (upper.startsWith('CLAUDE_CODE_USE_')) return true;
  if (upper.startsWith('CLAUDE_CODE_REMOTE_')) return true;
  if (upper.startsWith('CLAUDE_CODE_OAUTH_')) return true;
  return false;
}

const PRESERVED_CODEX_ENV = new Set(['CODEX_HOME']);

function isCodexAmbientAuth(upper: string): boolean {
  if (PRESERVED_CODEX_ENV.has(upper)) return false;
  if (upper.startsWith('OPENAI_')) return true;
  if (upper.startsWith('CODEX_')) return true;
  return false;
}

function isOtherProviderAuth(upper: string): boolean {
  if (upper === 'GOOGLE_API_KEY') return true;
  if (upper.startsWith('XAI_')) return true;
  if (upper.startsWith('DEEPSEEK_')) return true;
  return false;
}

export const COMPUTE_PROVIDER_ENV_PREFIXES: readonly string[] = [
  'TAMARIND_',
  'BOLTZ_',
  'NVIDIA_API_KEY',
  'NVAPI_',
  'REPLICATE_',
  'RUNPOD_',
  'HF_TOKEN',
  'HUGGINGFACE_',
  'HUGGING_FACE_',
  'BASETEN_',
  'BIOHUB_',
  'SUBSEQ_',
];

function isComputeProviderAuth(upper: string): boolean {
  return COMPUTE_PROVIDER_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

function isGrokAmbientAuth(upper: string): boolean {
  if (upper.startsWith('XAI_')) return true;
  if (upper.startsWith('GROK_')) return true;
  return false;
}

function isSidecarHostOwnedTelemetry(upper: string): boolean {
  return upper.startsWith('SENTRY_');
}

function isSidecarHostOwnedSession(upper: string): boolean {
  return (
    upper === 'DNAFORGE_MCP_SESSION_TOKEN' ||
    upper === 'DNAFORGE_HUMAN_OPERATION_TOKEN' ||
    upper === 'DNAFORGE_NATIVE_DOCUMENT_TOKEN' ||
    upper === 'DNAFORGE_NATIVE_DOCUMENT_OWNER_ID' ||
    upper === 'DNAFORGE_SIDECAR_SESSION_GENERATION' ||
    upper === 'DNAFORGE_SIDECAR_OWNER_PID'
  );
}

function shouldStrip(target: SubprocessTarget, name: string): boolean {
  const upper = name.toUpperCase();
  if (upper.startsWith('TYPESAFE_') || upper.startsWith('JEV_')) return true;
  if (isSidecarHostOwnedSession(upper)) return true;
  if (isComputeProviderAuth(upper)) return true;
  switch (target) {
    case 'claude':
      return isClaudeAmbientAuth(upper);
    case 'codex':
      return isCodexAmbientAuth(upper);
    case 'grok':
      return isGrokAmbientAuth(upper);
    case 'sidecar':
      return (
        isClaudeAmbientAuth(upper) ||
        isCodexAmbientAuth(upper) ||
        isOtherProviderAuth(upper) ||
        isSidecarHostOwnedTelemetry(upper)
      );
  }
}

function bundledToolsDirectory(): string | null {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (!resourcesPath) return null;
  const directory = join(resourcesPath, 'binaries');
  return existsSync(directory) ? directory : null;
}

export function withBundledToolsOnPath(
  env: ConstructedEnv,
  toolsDirectory: string | null = bundledToolsDirectory()
): ConstructedEnv {
  if (!toolsDirectory) return env;
  const pathKey = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
  const current = env[pathKey] ?? '';
  if (current.split(delimiter).includes(toolsDirectory)) return env;
  return {
    ...env,
    [pathKey]: current ? `${toolsDirectory}${delimiter}${current}` : toolsDirectory,
  };
}

export function subprocessEnv(
  target: SubprocessTarget,
  base: NodeJS.ProcessEnv = process.env
): ConstructedEnv {
  const env: ConstructedEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (typeof value !== 'string') continue;
    if (shouldStrip(target, name)) continue;
    env[name] = value;
  }
  return target === 'sidecar' ? env : withBundledToolsOnPath(env);
}

export function claudeCliEnv(base: NodeJS.ProcessEnv = process.env): ConstructedEnv {
  return subprocessEnv('claude', base);
}

export function codexCliEnv(base: NodeJS.ProcessEnv = process.env): ConstructedEnv {
  return subprocessEnv('codex', base);
}

export function grokCliEnv(base: NodeJS.ProcessEnv = process.env): ConstructedEnv {
  return subprocessEnv('grok', base);
}

export function sidecarEnv(base: NodeJS.ProcessEnv = process.env): ConstructedEnv {
  return subprocessEnv('sidecar', base);
}

import { existsSync } from 'node:fs';

export const LIVE_MODELS = {
  text: process.env.HOSTED_LIVE_MODEL_NAME ?? 'gpt-5.6-luna',
  tools: process.env.HOSTED_LIVE_TOOL_MODEL ?? 'gpt-5.3-codex',
} as const;

export function liveApiKey(): string {
  return process.env.WAYPOINT_DEV_OPENAI_API_KEY ?? '';
}

export function canRunLive(): boolean {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return false;
  if (liveApiKey() === '') return false;
  return process.env.HOSTED_LIVE_MODEL === '1';
}

export function binaryPresent(candidatePath: string): boolean {
  return existsSync(candidatePath);
}

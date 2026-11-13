import { isCodexAccountModelRejection } from '../../shared/cli-assistant-text';

export interface AgentSessionFailureRecord {
  at: number;
  sessionId: string;
  provider: string;
  authorityProfileId: string;
  cwd: string;
  model: string | null;
  versions: unknown;
  error: string;
  traceDetail: string | null;
  durationMs: number;
  stopState: string;
}

const TRACE_DETAIL_CAP = 8_192;

export async function logAgentSessionFailure(record: AgentSessionFailureRecord): Promise<void> {
  try {
    const { app } = await import('electron');
    const { mkdir, appendFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const dir = join(app.getPath('userData'), 'logs');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await appendFile(join(dir, 'agent-session-failures.jsonl'), `${JSON.stringify(record)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  } catch {}
}

export function pickUserFacingCliError(rawError: string, traceDetail: string | null): string {
  const raw = (rawError ?? '').trim();
  const detail = (traceDetail ?? '').trim();
  if ([raw, detail].some(isCodexAccountModelRejection)) {
    return 'This Codex model is unavailable with your current account. Choose an available model or the provider default, then try again. Your request remains in this conversation.';
  }
  if (!detail) return rawError;
  if (!raw) return detail;
  if (raw.length <= 24 || /^(exit\s*\d+|failed|error|\d+)$/i.test(raw)) {
    return detail;
  }
  return rawError;
}

function failedTraceText(event: unknown, field: 'diagnostic' | 'display'): string | null {
  if (event === null || typeof event !== 'object') return null;
  const e = event as { terminal?: unknown; diagnostic?: unknown; display?: { text?: unknown } };
  if (e.terminal !== 'failed') return null;
  const text = field === 'diagnostic' ? e.diagnostic : e.display?.text;
  if (typeof text !== 'string' || text.trim().length === 0) return null;
  return text.slice(0, TRACE_DETAIL_CAP);
}

export function extractTraceFailureDetail(event: unknown): string | null {
  return failedTraceText(event, 'diagnostic') ?? failedTraceText(event, 'display');
}

export function extractTraceFailureMessage(event: unknown): string | null {
  return failedTraceText(event, 'display');
}

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import type { Readable } from 'node:stream';
import { nodeAwareSpawn } from './cli-layout';
import { subprocessEnv } from './subprocess-env';
import type { AgentSdkDetection } from './detect';
import { detectAgentSdk } from './detect';

export type AgentAuthTransport = 'claude-agent-sdk' | 'codex-sdk' | 'grok-acp';
export type AgentAuthStatus = 'completed' | 'failed' | 'not_installed' | 'timed_out';
export type AgentAuthStream = 'stdout' | 'stderr' | 'system';

export type AgentAuthFailureKind =
  | 'not_installed'
  | 'spawn_error'
  | 'exit_nonzero'
  | 'auth_not_detected'
  | 'timed_out'
  | 'invalid_transport'
  | 'handler_error';

export interface AgentAuthOptions {
  authId?: string;
  binaryPathOverride?: string;
}

export interface AgentAuthEvent {
  authId: string;
  transport: AgentAuthTransport;
  stream: AgentAuthStream;
  text: string;
  receivedAt: string;
}

export interface AgentAuthResult {
  authId: string;
  transport: AgentAuthTransport;
  ok: boolean;
  status: AgentAuthStatus;
  command: string[];
  output: string;
  error?: string;
  durationMs: number;
  detection?: AgentSdkDetection;
  failureKind?: AgentAuthFailureKind;
  spawnErrorCode?: string;
}

export interface ProcessRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type AuthTraceSink = (event: AgentAuthEvent) => void;
export type AuthProcessRunner = (
  command: string,
  args: string[],
  options: {
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
    onOutput: (stream: 'stdout' | 'stderr', text: string) => void;
  }
) => Promise<ProcessRunResult>;

export interface AgentAuthDeps {
  detect?: () => Promise<AgentSdkDetection>;
  runProcess?: AuthProcessRunner;
  makeAuthId?: () => string;
}

const AUTH_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_CAPTURED_OUTPUT_CHARS = 16_000;

function appendLimited(current: string, next: string): string {
  const combined = current + next;
  if (combined.length <= MAX_CAPTURED_OUTPUT_CHARS) return combined;
  return combined.slice(combined.length - MAX_CAPTURED_OUTPUT_CHARS);
}

function redactAuthOutput(value: string): string {
  return value
    .replace(
      /(access_token|refresh_token|id_token|api[_-]?key)(["'=:\s]+)[^\s"',}]+/gi,
      '$1$2[redacted]'
    )
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, '[redacted-openai-key]')
    .replace(/\b(anthropic-[A-Za-z0-9_-]{12,})\b/g, '[redacted-anthropic-key]')
    .replace(/\b(dna_key_[A-Za-z0-9_-]{12,})\b/g, '[redacted-dnaforge-key]');
}

function emit(
  sink: AuthTraceSink | undefined,
  authId: string,
  transport: AgentAuthTransport,
  stream: AgentAuthStream,
  text: string
): void {
  sink?.({
    authId,
    transport,
    stream,
    text: redactAuthOutput(text),
    receivedAt: new Date().toISOString(),
  });
}

function commandForTransport(
  transport: AgentAuthTransport,
  detection: AgentSdkDetection
): { command: string; args: string[] } | null {
  if (transport === 'codex-sdk') {
    const command = detection.codex.path;
    return command ? { command, args: ['login'] } : null;
  }
  if (transport === 'grok-acp') {
    const command = detection.grok.path;
    return command ? { command, args: ['login', '--oauth'] } : null;
  }
  const command = detection.claudeCode.path;
  return command ? { command, args: ['auth', 'login', '--claudeai'] } : null;
}

function isAuthenticatedAfterRun(
  transport: AgentAuthTransport,
  detection: AgentSdkDetection
): boolean {
  if (transport === 'codex-sdk') return detection.codex.auth === 'authenticated';
  if (transport === 'grok-acp') return detection.grok.auth === 'authenticated';
  return detection.claudeCode.auth === 'authenticated';
}

export async function runChildProcess(
  command: string,
  args: string[],
  options: {
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
    onOutput: (stream: 'stdout' | 'stderr', text: string) => void;
  }
): Promise<ProcessRunResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let stdout = '';
    let stderr = '';
    const spawnable = nodeAwareSpawn(command, args, options.env ?? process.env);
    const child: ChildProcessByStdio<null, Readable, Readable> = spawn(
      spawnable.file,
      spawnable.args,
      {
        cwd: homedir(),
        env: spawnable.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    const finish = (result: ProcessRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!settled) {
          child.kill('SIGKILL');
          finish({ code: null, stdout, stderr, timedOut: true });
        }
      }, 2000).unref();
    }, options.timeoutMs);
    timer.unref();

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdout = appendLimited(stdout, text);
      options.onOutput('stdout', text);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderr = appendLimited(stderr, text);
      options.onOutput('stderr', text);
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      finish({ code, stdout, stderr, timedOut });
    });
  });
}

export async function authenticateAgentCli(
  transport: AgentAuthTransport,
  options: AgentAuthOptions = {},
  sink?: AuthTraceSink,
  deps: AgentAuthDeps = {}
): Promise<AgentAuthResult> {
  const startedAt = Date.now();
  const authId = options.authId ?? deps.makeAuthId?.() ?? randomUUID();
  const detect =
    deps.detect ??
    (() =>
      detectAgentSdk(
        options.binaryPathOverride ? { [transport]: options.binaryPathOverride } : undefined
      ));
  const runProcess = deps.runProcess ?? runChildProcess;
  const initialDetection = await detect();
  const command = commandForTransport(transport, initialDetection);

  if (!command) {
    const commandLabel =
      transport === 'codex-sdk'
        ? ['codex', 'login']
        : transport === 'grok-acp'
          ? ['grok', 'login', '--oauth']
          : ['claude', 'auth', 'login', '--claudeai'];
    const error =
      transport === 'codex-sdk'
        ? 'Codex CLI is not installed.'
        : transport === 'grok-acp'
          ? 'Grok Build is not installed.'
          : 'Claude Code CLI is not installed.';
    emit(sink, authId, transport, 'system', `${error}\n`);
    return {
      authId,
      transport,
      ok: false,
      status: 'not_installed',
      failureKind: 'not_installed',
      command: commandLabel,
      output: '',
      error,
      durationMs: Date.now() - startedAt,
      detection: initialDetection,
    };
  }

  const commandLabel = [command.command, ...command.args];
  emit(sink, authId, transport, 'system', `Starting ${commandLabel.join(' ')}\n`);

  try {
    let capturedOutput = '';
    const result = await runProcess(command.command, command.args, {
      timeoutMs: AUTH_TIMEOUT_MS,
      env: subprocessEnv(
        transport === 'codex-sdk' ? 'codex' : transport === 'grok-acp' ? 'grok' : 'claude'
      ),
      onOutput: (stream, rawText) => {
        const text = redactAuthOutput(rawText);
        capturedOutput = appendLimited(capturedOutput, text);
        emit(sink, authId, transport, stream, text);
      },
    });
    const output = redactAuthOutput(`${result.stdout}${result.stderr}`.trim());

    if (result.timedOut) {
      const error = 'Sign-in timed out before the CLI reported completion.';
      emit(sink, authId, transport, 'system', `${error}\n`);
      return {
        authId,
        transport,
        ok: false,
        status: 'timed_out',
        failureKind: 'timed_out',
        command: commandLabel,
        output: output || capturedOutput.trim(),
        error,
        durationMs: Date.now() - startedAt,
        detection: await detect(),
      };
    }

    const detection = await detect();
    if (result.code === 0 && isAuthenticatedAfterRun(transport, detection)) {
      emit(sink, authId, transport, 'system', 'Sign-in completed.\n');
      return {
        authId,
        transport,
        ok: true,
        status: 'completed',
        command: commandLabel,
        output: output || capturedOutput.trim(),
        durationMs: Date.now() - startedAt,
        detection,
      };
    }

    const error =
      result.code === 0
        ? 'The sign-in command completed, but the CLI still reports that it is not signed in.'
        : `The sign-in command exited with code ${result.code ?? 'unknown'}.`;
    emit(sink, authId, transport, 'system', `${error}\n`);
    return {
      authId,
      transport,
      ok: false,
      status: 'failed',
      failureKind: result.code === 0 ? 'auth_not_detected' : 'exit_nonzero',
      command: commandLabel,
      output: output || capturedOutput.trim(),
      error,
      durationMs: Date.now() - startedAt,
      detection,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const spawnErrorCode = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
    emit(sink, authId, transport, 'system', `Sign-in failed: ${error}\n`);
    return {
      authId,
      transport,
      ok: false,
      status: 'failed',
      failureKind: 'spawn_error',
      ...(spawnErrorCode ? { spawnErrorCode } : {}),
      command: commandLabel,
      output: '',
      error,
      durationMs: Date.now() - startedAt,
      detection: await detect(),
    };
  }
}

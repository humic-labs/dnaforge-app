import { spawn } from 'child_process';
import { DNAFORGE_MCP_CLIENT_PROTOCOL_VERSION, type CliMcpServerLaunch } from './cli-mcp';

const MAX_STDOUT_LINE_CHARS = 8 * 1024 * 1024;

function jsonRpcErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'number' && Number.isFinite(code) ? ` (code=${code})` : '';
}

export type McpLivenessFailureReason =
  | 'spawn-failed'
  | 'aborted'
  | 'companion-exited'
  | 'handshake-timeout'
  | 'protocol-error'
  | 'empty-tool-list'
  | 'tool-surface-mismatch'
  | 'missing-required-tools'
  | 'probe-tool-missing'
  | 'probe-tool-call-failed';

export interface McpLivenessReceipt {
  ok: true;
  toolNames: string[];
  requiredToolNames: string[];
  probeToolName: string;
  provedAtMs: number;
}

export interface McpLivenessFailure {
  ok: false;
  reason: McpLivenessFailureReason;
  detail: string;
  missingToolNames?: string[];
  unexpectedToolNames?: string[];
}

export type McpLivenessResult = McpLivenessReceipt | McpLivenessFailure;

export interface ProveCliMcpToolsOptions {
  requiredToolNames: readonly string[];
  expectedToolNames?: readonly string[];
  probeToolName?: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 20_000;

export async function proveCliMcpToolsReachable(
  launch: CliMcpServerLaunch,
  options: ProveCliMcpToolsOptions
): Promise<McpLivenessResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const required = [...new Set(options.requiredToolNames)];
  const expected = options.expectedToolNames
    ? [...new Set(options.expectedToolNames)].sort()
    : null;
  const probeToolName = options.probeToolName ?? 'get_workspace';

  if (options.abortSignal?.aborted) {
    return {
      ok: false,
      reason: 'aborted',
      detail: 'The DNAForge MCP liveness proof was stopped before launch.',
    };
  }

  let child: ReturnType<typeof spawn>;
  try {
    const childEnv = { ...process.env, ...launch.env };
    delete childEnv.DNAFORGE_MCP_TURN_ID;
    launch.assertCurrent?.();
    child = spawn(launch.command, launch.args, {
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    return {
      ok: false,
      reason: 'spawn-failed',
      detail: `Could not start the DNAForge MCP companion (${launch.command}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  let stderrChars = 0;
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrChars += chunk.toString('utf8').length;
  });

  const withheldStderrSummary = (): string =>
    stderrChars > 0 ? ` Companion stderr was withheld (${stderrChars} characters).` : '';

  const cleanup = () => {
    try {
      child.kill('SIGTERM');
    } catch {}
  };

  try {
    return await new Promise<McpLivenessResult>((resolve) => {
      let settled = false;
      let buffer = '';
      let listedToolNames: string[] | null = null;
      const onAbort = () => {
        finish({
          ok: false,
          reason: 'aborted',
          detail: 'The DNAForge MCP liveness proof was stopped.',
        });
      };
      const finish = (result: McpLivenessResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.abortSignal?.removeEventListener('abort', onAbort);
        resolve(result);
      };

      const timer = setTimeout(() => {
        finish({
          ok: false,
          reason: 'handshake-timeout',
          detail:
            `The DNAForge MCP companion did not complete its handshake and probe within ${timeoutMs}ms.` +
            withheldStderrSummary(),
        });
      }, timeoutMs);
      timer.unref?.();
      options.abortSignal?.addEventListener('abort', onAbort, { once: true });

      child.on('error', (err) => {
        clearTimeout(timer);
        finish({
          ok: false,
          reason: 'spawn-failed',
          detail: `DNAForge MCP companion error: ${err.message}`,
        });
      });

      child.on('close', (code, signal) => {
        clearTimeout(timer);
        finish({
          ok: false,
          reason: 'companion-exited',
          detail:
            `The DNAForge MCP companion exited (code=${code}, signal=${signal}) before ` +
            `completing its liveness proof.` +
            withheldStderrSummary(),
        });
      });

      child.stdin?.on('error', () => {});

      const send = (message: unknown) => {
        child.stdin?.write(`${JSON.stringify(message)}\n`);
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
          if (!line) continue;
          if (line.length > MAX_STDOUT_LINE_CHARS) {
            finish({
              ok: false,
              reason: 'protocol-error',
              detail: `The DNAForge MCP companion emitted a JSON-RPC line longer than ${MAX_STDOUT_LINE_CHARS} characters.`,
            });
            return;
          }

          let message: { id?: unknown; result?: unknown; error?: unknown };
          try {
            message = JSON.parse(line);
          } catch {
            clearTimeout(timer);
            finish({
              ok: false,
              reason: 'protocol-error',
              detail:
                'The DNAForge MCP companion emitted a non-JSON-RPC stdout line; its content was withheld.',
            });
            return;
          }

          if (message.id === 1) {
            if (message.error) {
              clearTimeout(timer);
              finish({
                ok: false,
                reason: 'protocol-error',
                detail: `The DNAForge MCP companion rejected initialize${jsonRpcErrorCode(message.error)}; response content was withheld.`,
              });
              return;
            }
            send({ jsonrpc: '2.0', method: 'notifications/initialized' });
            send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
            continue;
          }

          if (message.id === 2) {
            if (message.error) {
              clearTimeout(timer);
              finish({
                ok: false,
                reason: 'protocol-error',
                detail: `The DNAForge MCP companion rejected tools/list${jsonRpcErrorCode(message.error)}; response content was withheld.`,
              });
              return;
            }
            const rawTools = (message.result as { tools?: unknown })?.tools;
            const toolNames = (Array.isArray(rawTools) ? rawTools : [])
              .map((tool) => (tool as { name?: unknown })?.name)
              .filter((name): name is string => typeof name === 'string' && name.trim().length > 0);

            if (toolNames.length === 0) {
              clearTimeout(timer);
              finish({
                ok: false,
                reason: 'empty-tool-list',
                detail:
                  'The DNAForge MCP companion started but reported zero tools. The agent ' +
                  'would have had no way to reach the workspace.',
              });
              return;
            }

            const visible = new Set(toolNames);
            if (expected) {
              const missing = expected.filter((name) => !visible.has(name));
              const expectedSet = new Set(expected);
              const unexpected = [...visible].filter((name) => !expectedSet.has(name)).sort();
              if (missing.length > 0 || unexpected.length > 0) {
                clearTimeout(timer);
                finish({
                  ok: false,
                  reason: 'tool-surface-mismatch',
                  detail:
                    'The DNAForge MCP companion tool catalog does not match authenticated ' +
                    `discovery (missing=${missing.length}, unexpected=${unexpected.length}).`,
                  missingToolNames: missing,
                  unexpectedToolNames: unexpected,
                });
                return;
              }
            }
            const missing = required.filter((name) => !visible.has(name));
            if (missing.length > 0) {
              clearTimeout(timer);
              finish({
                ok: false,
                reason: 'missing-required-tools',
                detail:
                  `The DNAForge MCP companion is missing ${missing.length} workspace tool(s) ` +
                  `the agent needs to answer questions about the workspace.`,
                missingToolNames: missing,
              });
              return;
            }

            if (!visible.has(probeToolName)) {
              clearTimeout(timer);
              finish({
                ok: false,
                reason: 'probe-tool-missing',
                detail:
                  `The DNAForge MCP companion did not expose the liveness probe tool ` +
                  `"${probeToolName}".`,
                missingToolNames: [probeToolName],
              });
              return;
            }

            listedToolNames = toolNames;
            send({
              jsonrpc: '2.0',
              id: 3,
              method: 'tools/call',
              params: { name: probeToolName, arguments: {} },
            });
            continue;
          }

          if (message.id === 3) {
            clearTimeout(timer);
            const callResult = message.result as
              | { isError?: unknown; content?: unknown }
              | null
              | undefined;
            const validCallResult =
              callResult !== null &&
              typeof callResult === 'object' &&
              Array.isArray(callResult.content);
            if (
              message.error ||
              !validCallResult ||
              callResult.isError === true ||
              !listedToolNames
            ) {
              const failureKind = message.error
                ? `a JSON-RPC error${jsonRpcErrorCode(message.error)}`
                : !validCallResult
                  ? 'a malformed result'
                  : callResult.isError === true
                    ? 'an MCP tool error result'
                    : 'an incomplete catalog state';
              finish({
                ok: false,
                reason: 'probe-tool-call-failed',
                detail: `The DNAForge MCP companion exposed "${probeToolName}" but its real call returned ${failureKind}; response content was withheld.`,
              });
              return;
            }

            finish({
              ok: true,
              toolNames: listedToolNames,
              requiredToolNames: required,
              probeToolName,
              provedAtMs: Date.now(),
            });
            return;
          }
        }
        if (buffer.length > MAX_STDOUT_LINE_CHARS) {
          finish({
            ok: false,
            reason: 'protocol-error',
            detail: `The DNAForge MCP companion emitted more than ${MAX_STDOUT_LINE_CHARS} characters without a JSON-RPC newline.`,
          });
        }
      });

      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: DNAFORGE_MCP_CLIENT_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'dnaforge-desktop-liveness-proof', version: '1' },
        },
      });
    });
  } finally {
    cleanup();
  }
}

export function livenessFailureMessage(failure: McpLivenessFailure): string {
  const lead = 'I could not reach this project, so I cannot answer questions about what is in it.';
  const because = {
    'spawn-failed': 'The DNAForge tool server would not start.',
    aborted: 'The DNAForge tool check was stopped.',
    'companion-exited': 'The DNAForge tool server stopped before it was ready.',
    'handshake-timeout': 'The DNAForge tool server did not respond in time.',
    'protocol-error': 'The DNAForge tool server responded in a way this app did not understand.',
    'empty-tool-list': 'The DNAForge tool server started but offered no tools.',
    'tool-surface-mismatch':
      'The DNAForge tool server did not expose the complete authorized tool catalog.',
    'missing-required-tools': 'The DNAForge tool server is missing the project tools.',
    'probe-tool-missing': 'The DNAForge tool server is missing its project probe.',
    'probe-tool-call-failed': 'The DNAForge tool server listed tools but could not call one.',
  }[failure.reason];
  return `${lead} ${because} Restart the app to rebuild the tool session; if it keeps happening, this is a bug worth reporting.`;
}

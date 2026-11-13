import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConstructedEnv } from './subprocess-env';
import type { PreToolUseHookOutput } from './destructive-file-guard';

type PreToolUse = (input: unknown) => Promise<PreToolUseHookOutput>;

export interface CodexPermissionHookBridge {
  codexPath: string;
  hookCommand: string;
  env: ConstructedEnv;
  config: {
    features: { hooks: true };
    hooks: {
      state: Record<string, { trusted_hash: string }>;
      PreToolUse: Array<{
        matcher: string;
        hooks: Array<{
          type: 'command';
          command: string;
          timeout: number;
          statusMessage: string;
        }>;
      }>;
    };
  };
  close(): Promise<void>;
}

export interface CreateCodexPermissionHookBridgeInput {
  codexPath: string;
  baseEnv: ConstructedEnv;
  preToolUse: PreToolUse;
}

const MAX_HOOK_INPUT_BYTES = 256 * 1024;

function shellQuote(value: string): string {
  if (process.platform === 'win32') return `"${value.replace(/"/g, '""')}"`;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function denyOutput(reason: string): PreToolUseHookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Codex permission hook bridge did not acquire a loopback port.');
  }
  return address.port;
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

const HOOK_RUNNER_SOURCE = String.raw`const http = require('node:http');
const chunks = [];
let size = 0;
process.stdin.on('data', (chunk) => {
  size += chunk.length;
  if (size > 262144) process.exit(2);
  chunks.push(chunk);
});
process.stdin.on('end', () => {
  const body = Buffer.concat(chunks);
  const url = new URL(process.env.DNAFORGE_AGENT_PERMISSION_URL);
  const req = http.request({
    hostname: url.hostname,
    port: url.port,
    path: url.pathname,
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + process.env.DNAFORGE_AGENT_PERMISSION_TOKEN,
      'content-type': 'application/json',
      'content-length': body.length,
    },
  }, (res) => {
    const response = [];
    res.on('data', (chunk) => response.push(chunk));
    res.on('end', () => process.stdout.write(Buffer.concat(response)));
  });
  req.on('error', () => process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'DNAForge shell supervision was unavailable.',
    },
  })));
  req.end(body);
});
`;

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, canonicalizeJson((value as Record<string, unknown>)[key])])
  );
}

function codexHookTrustState(hookCommand: string): Record<string, { trusted_hash: string }> {
  const normalizedHook = {
    event_name: 'pre_tool_use',
    matcher: '^Bash$',
    hooks: [
      {
        type: 'command',
        command: hookCommand,
        timeout: 95,
        async: false,
        statusMessage: 'Checking shell supervision',
      },
    ],
  };
  const fingerprint = `sha256:${createHash('sha256')
    .update(JSON.stringify(canonicalizeJson(normalizedHook)))
    .digest('hex')}`;
  const sourcePath =
    process.platform === 'win32'
      ? 'C:\\<session-flags>\\config.toml'
      : '/<session-flags>/config.toml';
  const stateKey = `${sourcePath}:pre_tool_use:0:0`;
  return { [JSON.stringify(stateKey)]: { trusted_hash: fingerprint } };
}

export async function createCodexPermissionHookBridge({
  codexPath,
  baseEnv,
  preToolUse,
}: CreateCodexPermissionHookBridgeInput): Promise<CodexPermissionHookBridge> {
  const token = randomBytes(32).toString('hex');
  const server = createServer((request, response) => {
    void (async () => {
      if (
        request.method !== 'POST' ||
        request.url !== '/pre-tool-use' ||
        request.headers.authorization !== `Bearer ${token}`
      ) {
        response.writeHead(403, { 'content-type': 'application/json' });
        response.end(JSON.stringify(denyOutput('DNAForge rejected an unauthenticated hook.')));
        return;
      }

      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > MAX_HOOK_INPUT_BYTES) {
          response.writeHead(413, { 'content-type': 'application/json' });
          response.end(JSON.stringify(denyOutput('The shell command request was too large.')));
          return;
        }
        chunks.push(buffer);
      }

      let output: PreToolUseHookOutput;
      try {
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
        output = await preToolUse(input);
      } catch {
        output = denyOutput('DNAForge could not evaluate this shell command safely.');
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(output));
    })();
  });

  let tempRoot = '';
  try {
    const port = await listen(server);
    tempRoot = await mkdtemp(join(tmpdir(), 'dnaforge-codex-hook-'));
    const hookPath = join(tempRoot, 'pre-tool-use.cjs');
    await writeFile(hookPath, HOOK_RUNNER_SOURCE, { encoding: 'utf8', mode: 0o600 });

    const env: ConstructedEnv = {
      ...baseEnv,
      ELECTRON_RUN_AS_NODE: '1',
      DNAFORGE_AGENT_PERMISSION_URL: `http://127.0.0.1:${port}/pre-tool-use`,
      DNAFORGE_AGENT_PERMISSION_TOKEN: token,
    };

    const hookCommand = `${shellQuote(process.execPath)} ${shellQuote(hookPath)}`;
    const hookTrustState = codexHookTrustState(hookCommand);

    let closed = false;
    return {
      codexPath,
      hookCommand,
      env,
      config: {
        features: { hooks: true },
        hooks: {
          state: hookTrustState,
          PreToolUse: [
            {
              matcher: '^Bash$',
              hooks: [
                {
                  type: 'command',
                  command: hookCommand,
                  timeout: 95,
                  statusMessage: 'Checking shell supervision',
                },
              ],
            },
          ],
        },
      },
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        await closeServer(server);
        await rm(tempRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await closeServer(server);
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

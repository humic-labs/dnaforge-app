import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveCodexAppServerBinary } from './app-server-binary';
import { ALLOWED_REQUEST_FIELDS } from './responses-wire';
import { launchAppServer, type LaunchedAppServer } from './app-server-launcher';
import { buildHostedProviderConfig, HOSTED_API_KEY_ENV } from './hosted-provider-config';
import { createSupervisorDriver } from './supervisor-driver';

const IS_DARWIN_ARM64 = process.platform === 'darwin' && process.arch === 'arm64';

describe.skipIf(!IS_DARWIN_ARM64)('the request a real child sends', () => {
  let launched: LaunchedAppServer | null = null;
  let server: Server | null = null;
  let root = '';

  afterEach(async () => {
    launched?.dispose();
    launched = null;
    const open = server;
    server = null;
    if (open) await new Promise<void>((resolve) => open.close(() => resolve()));
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  async function captureRequest(): Promise<Record<string, unknown>> {
    let body = '';
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        if (body === '') body = Buffer.concat(chunks).toString('utf8');
        response
          .writeHead(401, { 'content-type': 'application/json' })
          .end('{"error":{"message":"capture"}}');
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };

    root = mkdtempSync(path.join(os.tmpdir(), 'hosted-live-'));
    launched = await launchAppServer({
      binary: resolveCodexAppServerBinary(),
      rootDir: root,
      runId: 'live-request',
      handshakeTimeoutMs: 30_000,
      requestTimeoutMs: 30_000,
      configToml: buildHostedProviderConfig({
        baseUrl: `http://127.0.0.1:${port}`,
        model: 'gpt-5-codex',
      }),
      injectedEnv: { [HOSTED_API_KEY_ENV]: 'live-bearer-token' },
    });
    const driver = createSupervisorDriver({ supervisor: launched.supervisor });
    driver.onServerRequest((request) => request.refuse('not under test'));
    await driver.send('say hello');
    await new Promise((resolve) => setTimeout(resolve, 8_000));

    expect(body, 'the child sent no request to the gateway').not.toBe('');
    return JSON.parse(body) as Record<string, unknown>;
  }

  it('carries only fields the wire models', async () => {
    const request = await captureRequest();
    const unmodelled = Object.keys(request)
      .filter((field) => !ALLOWED_REQUEST_FIELDS.has(field))
      .sort();

    expect(unmodelled).toEqual([]);
  }, 120_000);

  it('declares its own tools rather than the catalog the gateway builds', async () => {
    const request = await captureRequest();
    const tools = (request.tools ?? []) as { name?: string; type?: string }[];

    expect(tools.map((tool) => tool.name ?? `<${tool.type}>`)).toEqual([
      'exec_command',
      'write_stdin',
      'update_plan',
      'request_user_input',
      'view_image',
      'multi_agent_v1',
      'get_goal',
      'create_goal',
      'update_goal',
      '<web_search>',
    ]);
  }, 120_000);
});

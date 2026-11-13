import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildCliMcpServerLaunch } from '../cli-mcp';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const API_DIR = resolve(TEST_DIR, '../../../../../api');
const COMPANION_PYTHON = resolve(API_DIR, '.venv/bin/python3');
const RUN_SERVER_PATH = resolve(API_DIR, 'run_server.py');
const COMPANION_RUNTIME_AVAILABLE = existsSync(COMPANION_PYTHON) && existsSync(RUN_SERVER_PATH);
const MANIFEST_PATH = resolve(
  TEST_DIR,
  '../../../../../../packages/core/agent-tools/renderer-tool-manifest.json'
);

const SELECTION_URI_TEMPLATE = 'waypoint://selection/{refId}';

const REQUIRED_SELECTION_TOOLS = [
  'selection_translate',
  'selection_reverse_complement',
  'selection_restriction_sites',
  'selection_gc_profile',
  'selection_find_orfs',
  'get_selection_bases',
  'highlight_range',
  'highlight_residues',
] as const;

interface ManifestTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

let manifestTools: ManifestTool[] = [];

beforeAll(() => {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as { tools?: ManifestTool[] };
  manifestTools = Array.isArray(manifest.tools) ? manifest.tools : [];
  expect(manifestTools.length, 'renderer-tool-manifest.json has tools').toBeGreaterThan(0);
});

interface Captured {
  headers?: IncomingMessage['headers'];
  body?: unknown;
}

interface MockSidecar {
  url: string;
  toolsCall: Captured;
  resourceRead: Captured;
  close: () => Promise<void>;
}

const RESOURCE_DESCRIPTOR = {
  schemaVersion: 2,
  kind: 'sequence_region',
  label: 'pUC19.gb 21–161 (141 bp)',
  coordinateSystem: '1-indexed-inclusive',
  measured: { start: 21, end: 161, length: 141, topology: 'circular' },
};
const RESOURCE_DESCRIPTOR_TEXT = JSON.stringify(RESOURCE_DESCRIPTOR);

const servers: Server[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill('SIGKILL');
  }
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((res) => {
          server.close(() => res());
        })
    )
  );
});

async function startMockSidecar(): Promise<MockSidecar> {
  const mock: MockSidecar = {
    url: '',
    toolsCall: {},
    resourceRead: {},
    close: async () => undefined,
  };

  const server = createServer((req, res) => {
    void handle(req, res, mock).catch(() => writeJson(res, {}, 500));
  });
  servers.push(server);

  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Mock sidecar did not bind TCP.');
  mock.url = `http://127.0.0.1:${address.port}`;
  return mock;
}

async function handle(req: IncomingMessage, res: ServerResponse, mock: MockSidecar): Promise<void> {
  if (req.method === 'POST' && req.url === '/mcp/discover') {
    writeJson(res, {
      ok: true,
      caller: {
        agentIdentityId: 'local-in-app-chat',
        requestedCapabilities: ['read-sequences', 'modify-tabs'],
        grantedCapabilities: ['read-sequences', 'modify-tabs'],
        effectiveCapabilities: ['read-sequences', 'modify-tabs'],
      },
      tools: manifestTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
        annotations: {},
      })),
      resources: [],
      resourceTemplates: [
        {
          uriTemplate: SELECTION_URI_TEMPLATE,
          name: 'DNAForge selection reference',
          mimeType: 'application/json',
        },
      ],
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/mcp/resources/read') {
    mock.resourceRead.headers = req.headers;
    mock.resourceRead.body = JSON.parse(await readBody(req));
    const uri =
      (mock.resourceRead.body as { uri?: string } | undefined)?.uri ??
      'waypoint://selection/unknown';
    writeJson(res, {
      ok: true,
      contents: [{ uri, mimeType: 'application/json', text: RESOURCE_DESCRIPTOR_TEXT }],
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/mcp/call') {
    mock.toolsCall.headers = req.headers;
    mock.toolsCall.body = JSON.parse(await readBody(req));
    writeJson(res, { ok: true, status: 'completed', result: { ok: true, windows: [] } });
    return;
  }

  writeJson(res, {}, 404);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function writeJson(res: ServerResponse, body: unknown, status = 200): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': String(payload.length),
  });
  res.end(payload);
}

interface JsonRpcResponse {
  jsonrpc: string;
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

class RawStdioMcpClient {
  private child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<
    number,
    {
      resolve: (msg: JsonRpcResponse) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private stderr = '';
  private protocolError: Error | null = null;

  constructor(command: string, args: string[], env: NodeJS.ProcessEnv) {
    this.child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(this.child);
    this.child.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk));
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderr += chunk.toString('utf8');
    });
  }

  private onStdout(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(line) as JsonRpcResponse;
      } catch {
        this.protocolError = new Error(`Companion contaminated stdout with non-JSON: ${line}`);
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(this.protocolError);
        }
        this.pending.clear();
        return;
      }
      const pending = this.pending.get(msg.id);
      if (pending) {
        this.pending.delete(msg.id);
        clearTimeout(pending.timer);
        pending.resolve(msg);
      }
    }
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const payload = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
    return new Promise<JsonRpcResponse>((resolvePromise, rejectPromise) => {
      if (this.protocolError) {
        rejectPromise(this.protocolError);
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(
          new Error(`Companion did not answer "${method}" in time. stderr:\n${this.stderr}`)
        );
      }, 10_000);
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
      this.child.stdin.write(payload);
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async close(): Promise<void> {
    this.child.kill('SIGTERM');
    if (this.protocolError) throw this.protocolError;
  }
}

describe.skipIf(!COMPANION_RUNTIME_AVAILABLE)(
  ' spawned MCP companion — raw stdio protocol (every CLI seam)',
  () => {
    const SESSION_TOKEN = 'spawn-session-token';
    const AGENT_IDENTITY = 'local-in-app-chat';
    const CAPABILITIES = ['read-sequences', 'modify-tabs'];

    async function launchCompanion(apiUrl: string): Promise<RawStdioMcpClient> {
      const launch = buildCliMcpServerLaunch({
        apiUrl,
        sessionToken: SESSION_TOKEN,
        agentIdentityId: AGENT_IDENTITY,
        capabilities: CAPABILITIES,
        command: COMPANION_PYTHON,
        commandArgs: [RUN_SERVER_PATH, '--mcp-stdio'],
      });
      const client = new RawStdioMcpClient(launch.command, launch.args, {
        ...process.env,
        ...launch.env,
      });
      const init = await client.request('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'p2-spawn-test', version: '0.0.0' },
      });
      expect(init.error, JSON.stringify(init.error)).toBeUndefined();
      expect(init.result?.protocolVersion).toBe('2025-11-25');
      expect(init.result?.capabilities).toHaveProperty('resources');
      expect(init.result?.capabilities).toHaveProperty('tools');
      client.notify('notifications/initialized');
      return client;
    }

    it('tools/list forwards all 7  selection tools from the real manifest', async () => {
      const mock = await startMockSidecar();
      const client = await launchCompanion(mock.url);
      try {
        const res = await client.request('tools/list', {});
        expect(res.error, JSON.stringify(res.error)).toBeUndefined();
        const tools = (res.result?.tools ?? []) as Array<{ name?: string }>;
        const names = tools.map((tool) => tool.name).filter(Boolean);
        for (const required of REQUIRED_SELECTION_TOOLS) {
          expect(names, `${required} present in tools/list`).toContain(required);
        }
      } finally {
        await client.close();
      }
    });

    it('resources/templates/list advertises waypoint://selection/{refId}', async () => {
      const mock = await startMockSidecar();
      const client = await launchCompanion(mock.url);
      try {
        const res = await client.request('resources/templates/list', {});
        expect(res.error, JSON.stringify(res.error)).toBeUndefined();
        const templates = (res.result?.resourceTemplates ?? []) as Array<{
          uriTemplate?: string;
          mimeType?: string;
        }>;
        const selection = templates.find((tpl) => tpl.uriTemplate === SELECTION_URI_TEMPLATE);
        expect(selection, `${SELECTION_URI_TEMPLATE} advertised`).toBeDefined();
        expect(selection?.mimeType).toBe('application/json');
      } finally {
        await client.close();
      }
    });

    it('resources/read forwards the uri + auth headers and returns the descriptor as contents', async () => {
      const mock = await startMockSidecar();
      const client = await launchCompanion(mock.url);
      try {
        const uri = 'waypoint://selection/ref-abc123';
        const res = await client.request('resources/read', { uri });
        expect(res.error, JSON.stringify(res.error)).toBeUndefined();

        expect(mock.resourceRead.body).toEqual({ uri });
        expect(mock.resourceRead.headers?.['x-dnaforge-session']).toBe(SESSION_TOKEN);
        expect(mock.resourceRead.headers?.['x-dnaforge-agent-identity']).toBe(AGENT_IDENTITY);
        expect(mock.resourceRead.headers?.['x-dnaforge-agent-capabilities']).toBe(
          JSON.stringify([...CAPABILITIES].sort())
        );

        expect(res.result?.contents).toEqual([
          { uri, mimeType: 'application/json', text: RESOURCE_DESCRIPTOR_TEXT },
        ]);
        const contents = res.result?.contents as Array<{ text: string }>;
        const descriptor = JSON.parse(contents[0].text) as typeof RESOURCE_DESCRIPTOR;
        expect(descriptor.measured.start).toBe(21);
        expect(descriptor.measured.end).toBe(161);
      } finally {
        await client.close();
      }
    });

    it('tools/call forwards auth headers to POST /mcp/call', async () => {
      const mock = await startMockSidecar();
      const client = await launchCompanion(mock.url);
      try {
        const res = await client.request('tools/call', {
          name: 'selection_gc_profile',
          arguments: { refId: 'ref-abc123' },
        });
        expect(res.error, JSON.stringify(res.error)).toBeUndefined();
        expect(res.result?.isError).toBe(false);

        expect(mock.toolsCall.headers?.['x-dnaforge-session']).toBe(SESSION_TOKEN);
        expect(mock.toolsCall.headers?.['x-dnaforge-agent-identity']).toBe(AGENT_IDENTITY);
        expect(mock.toolsCall.headers?.['x-dnaforge-agent-capabilities']).toBe(
          JSON.stringify([...CAPABILITIES].sort())
        );
        expect(mock.toolsCall.body).toMatchObject({
          params: { name: 'selection_gc_profile', arguments: { refId: 'ref-abc123' } },
        });
      } finally {
        await client.close();
      }
    });
  }
);

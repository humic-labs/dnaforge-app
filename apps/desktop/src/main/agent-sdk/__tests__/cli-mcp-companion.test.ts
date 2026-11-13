import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

const apiDir = resolve(process.cwd(), '../api');
const companionPython = resolve(apiDir, '.venv/bin/python3');
const runServerPath = resolve(apiDir, 'run_server.py');
const companionRuntimeAvailable = existsSync(companionPython) && existsSync(runServerPath);

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe.skipIf(!companionRuntimeAvailable)('agent MCP stdio companion', () => {
  it('speaks official newline-delimited legacy MCP and preserves schema compatibility', async () => {
    const fake = await startFakeSidecar((req, res) => {
      if (req.method === 'POST' && req.url === '/mcp/discover') {
        writeDiscovery(res, {
          tools: [
            {
              name: 'observe_app_state',
              description: 'Observe app state.',
              inputSchema: { type: 'object', properties: {}, additionalProperties: false },
              annotations: { readOnlyHint: true },
            },
            {
              name: 'import_sequence',
              description: 'Import sequence.',
              inputSchema: {
                type: 'object',
                properties: {
                  source: { type: 'object' },
                  sourcePath: { type: 'string' },
                },
                oneOf: [{ required: ['source'] }, { required: ['sourcePath'] }],
                additionalProperties: false,
              },
              annotations: {},
            },
          ],
        });
        return;
      }
      writeJson(res, {}, 404);
    });

    const { client, close } = await connectCompanion(fake.url);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        'import_sequence',
        'observe_app_state',
      ]);
      const importTool = listed.tools.find((tool) => tool.name === 'import_sequence');
      expect(importTool?.inputSchema).not.toHaveProperty('oneOf');
      expect(importTool?.inputSchema).toMatchObject({
        type: 'object',
        properties: {
          source: { type: 'object' },
          sourcePath: { type: 'string' },
        },
        description: 'Use one valid input form; do not mix fields from multiple alternatives.',
      });
      expect(importTool?.description).toContain(
        'provide the fields for exactly one supported input form'
      );
    } finally {
      await close();
    }
  });

  it('forwards MCP tool calls to the sidecar with the sidecar session and grant headers', async () => {
    const captured: {
      headers?: IncomingMessage['headers'];
      body?: unknown;
    } = {};
    const fake = await startFakeSidecar(async (req, res) => {
      if (req.method === 'POST' && req.url === '/mcp/discover') {
        writeDiscovery(res, {
          tools: [
            {
              name: 'observe_app_state',
              description: 'Observe app state.',
              inputSchema: { type: 'object', properties: {}, additionalProperties: false },
              annotations: { readOnlyHint: true },
            },
          ],
        });
        return;
      }
      if (req.method === 'POST' && req.url === '/mcp/call') {
        captured.headers = req.headers;
        captured.body = JSON.parse(await readBody(req));
        writeJson(res, {
          ok: true,
          status: 'completed',
          result: { ok: true, panelCount: 2 },
        });
        return;
      }
      writeJson(res, {}, 404);
    });

    const { client, close } = await connectCompanion(fake.url, {
      sessionToken: 'sidecar-session-token',
      identity: 'local-in-app-chat',
      capabilities: ['read-workspace', 'modify-tabs'],
      turnId: 'turn-stdio-1',
    });
    try {
      const result = await client.callTool({
        name: 'observe_app_state',
        arguments: {},
      });

      expect(result.isError).toBe(false);
      expect(result.structuredContent).toMatchObject({
        ok: true,
        panelCount: 2,
      });
      expect(captured.headers?.['x-dnaforge-session']).toBe('sidecar-session-token');
      expect(captured.headers?.['x-dnaforge-agent-identity']).toBe('local-in-app-chat');
      expect(captured.headers?.['x-dnaforge-agent-capabilities']).toBe(
        JSON.stringify(['modify-tabs', 'read-workspace'])
      );
      expect(captured.headers?.['x-dnaforge-turn-id']).toBe('turn-stdio-1');
      expect(captured.body).toMatchObject({
        params: { name: 'observe_app_state', arguments: {} },
      });
    } finally {
      await close();
    }
  });

  it('marks a canonical failed sidecar job as an MCP tool error', async () => {
    const fake = await startFakeSidecar(async (req, res) => {
      if (req.method === 'POST' && req.url === '/mcp/call') {
        writeJson(res, {
          ok: false,
          jobId: 'job-domain-failure',
          status: 'failed',
          error: { code: 'NO_ACTIVE_SELECTION', message: 'No residues are selected.' },
        });
        return;
      }
      writeJson(res, {}, 404);
    });

    const { client, close } = await connectCompanion(fake.url);
    try {
      const result = await client.callTool({
        name: 'save_active_residue_selection',
        arguments: { structureRef: 'structure:1ABC', name: 'Pocket' },
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      const errorContent = CallToolResultSchema.parse(result).content.find(
        (block) => block.type === 'text'
      );
      expect(errorContent?.type).toBe('text');
      const errorEnvelope = JSON.parse(
        errorContent && errorContent.type === 'text' ? errorContent.text : '{}'
      ) as Record<string, unknown>;
      expect(errorEnvelope).toMatchObject({
        ok: false,
        status: 'failed',
        error: { code: 'NO_ACTIVE_SELECTION' },
      });
    } finally {
      await close();
    }
  });

  it('advertises the waypoint://selection/{refId} resource template', async () => {
    const fake = await startFakeSidecar((req, res) => {
      if (req.method === 'POST' && req.url === '/mcp/discover') {
        writeDiscovery(res);
        return;
      }
      writeJson(res, {}, 404);
    });

    const { client, close } = await connectCompanion(fake.url);
    try {
      const listed = await client.listResourceTemplates();
      const selectionTemplate = listed.resourceTemplates.find(
        (template) => template.uriTemplate === 'waypoint://selection/{refId}'
      );
      expect(selectionTemplate).toBeDefined();
      expect(selectionTemplate?.mimeType).toBe('application/json');
    } finally {
      await close();
    }
  });

  it('reads a selection resource by forwarding uri + auth headers to the sidecar', async () => {
    const captured: {
      headers?: IncomingMessage['headers'];
      body?: unknown;
    } = {};
    const descriptorText = JSON.stringify({
      kind: 'sequence_region',
      measured: { lengthBp: 334 },
    });
    const fake = await startFakeSidecar(async (req, res) => {
      if (req.method === 'POST' && req.url === '/mcp/resources/read') {
        captured.headers = req.headers;
        captured.body = JSON.parse(await readBody(req));
        writeJson(res, {
          ok: true,
          contents: [
            {
              uri: 'waypoint://selection/ref-123',
              mimeType: 'application/json',
              text: descriptorText,
            },
          ],
        });
        return;
      }
      if (req.method === 'POST' && req.url === '/mcp/discover') {
        writeDiscovery(res);
        return;
      }
      writeJson(res, {}, 404);
    });

    const { client, close } = await connectCompanion(fake.url, {
      sessionToken: 'sidecar-session-token',
      identity: 'local-in-app-chat',
      capabilities: ['read-workspace'],
    });
    try {
      const result = await client.readResource({ uri: 'waypoint://selection/ref-123' });

      expect(result.contents).toEqual([
        {
          uri: 'waypoint://selection/ref-123',
          mimeType: 'application/json',
          text: descriptorText,
        },
      ]);
      expect(captured.body).toEqual({ uri: 'waypoint://selection/ref-123' });
      expect(captured.headers?.['x-dnaforge-session']).toBe('sidecar-session-token');
      expect(captured.headers?.['x-dnaforge-agent-identity']).toBe('local-in-app-chat');
      expect(captured.headers?.['x-dnaforge-agent-capabilities']).toBe(
        JSON.stringify(['read-workspace'])
      );
    } finally {
      await close();
    }
  });

  it('surfaces an unknown/not-found selection as a clean JSON-RPC error (no crash)', async () => {
    const fake = await startFakeSidecar(async (req, res) => {
      if (req.method === 'POST' && req.url === '/mcp/resources/read') {
        writeJson(
          res,
          {
            ok: false,
            error: {
              code: 'SELECTION_NOT_FOUND',
              message: 'No selection reference found for id: missing',
              retriable: false,
            },
          },
          404
        );
        return;
      }
      if (req.method === 'POST' && req.url === '/mcp/discover') {
        writeDiscovery(res);
        return;
      }
      writeJson(res, {}, 404);
    });

    const { client, close } = await connectCompanion(fake.url);
    try {
      await expect(client.readResource({ uri: 'waypoint://selection/missing' })).rejects.toThrow(
        /No selection reference found/
      );
      const listed = await client.listResourceTemplates();
      expect(listed.resourceTemplates.length).toBeGreaterThan(0);
    } finally {
      await close();
    }
  });
});

async function connectCompanion(
  apiUrl: string,
  options: {
    sessionToken?: string;
    identity?: string;
    capabilities?: string[];
    turnId?: string;
  } = {}
): Promise<{ client: Client; close: () => Promise<void> }> {
  const transport = new StdioClientTransport({
    command: companionPython,
    args: [runServerPath, '--mcp-stdio'],
    env: {
      ...stringEnvironment(),
      DNAFORGE_API_URL: apiUrl,
      DNAFORGE_MCP_SESSION_TOKEN: options.sessionToken ?? 'session',
      DNAFORGE_MCP_AGENT_IDENTITY: options.identity ?? 'agent',
      DNAFORGE_MCP_GRANT_CAPABILITIES: JSON.stringify(options.capabilities ?? []),
      ...(options.turnId ? { DNAFORGE_MCP_TURN_ID: options.turnId } : {}),
    },
  });
  const client = new Client({ name: 'dnaforge-companion-test', version: '0.0.0' });
  await client.connect(transport);
  return {
    client,
    close: async () => {
      await client.close();
    },
  };
}

async function startFakeSidecar(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch((error) => {
      writeJson(res, { error: String(error) }, 500);
    });
  });
  await new Promise<void>((resolveListen) => {
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fake sidecar did not bind TCP.');
  const fake = {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error) rejectClose(error);
          else resolveClose();
        });
      }),
  };
  servers.push(fake);
  return fake;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
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

function writeDiscovery(
  res: ServerResponse,
  overrides: {
    tools?: unknown[];
    resources?: unknown[];
    resourceTemplates?: unknown[];
  } = {}
): void {
  writeJson(res, {
    ok: true,
    caller: {
      agentIdentityId: 'test-agent',
      requestedCapabilities: [],
      grantedCapabilities: [],
      effectiveCapabilities: [],
    },
    tools: overrides.tools ?? [],
    resources: overrides.resources ?? [],
    resourceTemplates: overrides.resourceTemplates ?? [
      {
        uriTemplate: 'waypoint://selection/{refId}',
        name: 'DNAForge selection reference',
        mimeType: 'application/json',
      },
    ],
  });
}

function stringEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => {
      return typeof entry[1] === 'string';
    })
  );
}

import { connect, createServer, type AddressInfo, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_MCP_HTTP_PORT } from '../shared/mcp-http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  McpHttpListener,
  mcpHttpInternalPort,
  setMcpHttpInternalPort,
  readMcpHttpSettings,
  writeAllowedHostsFile,
  writeMcpHttpSettings,
} from './mcp-http-listener';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function listenOn(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
  return (server.address() as AddressInfo).port;
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function roundTrip(port: number, message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ port, host: '127.0.0.1' }, () => socket.end(message));
    let received = '';
    socket.on('data', (chunk) => (received += chunk.toString()));
    socket.on('close', () => resolve(received));
    socket.on('error', reject);
  });
}

function listener(options: { allowed: boolean; sidecarPort: () => number | null }) {
  const created = new McpHttpListener(options);
  cleanups.push(() => created.stop());
  return created;
}

describe('McpHttpListener', () => {
  it('pipes a connection on the fixed port to the sidecar current port', async () => {
    const sidecar = createServer((socket) => socket.pipe(socket));
    let sidecarPort: number | null = await listenOn(sidecar);
    const fixed = listener({ allowed: true, sidecarPort: () => sidecarPort });
    const port = await freePort();

    const status = await fixed.apply({ enabled: true, port, allowedHosts: [] });

    expect(status).toEqual({
      enabled: true,
      port,
      allowedHosts: [],
      state: 'listening',
      url: `http://127.0.0.1:${port}/mcp`,
    });
    expect(await roundTrip(port, 'POST /mcp')).toBe('POST /mcp');

    const restarted = createServer((socket) => socket.resume().end('restarted'));
    sidecarPort = await listenOn(restarted);
    expect(await roundTrip(port, 'x')).toBe('restarted');
  });

  it('reports a port that another program holds', async () => {
    const taken = await listenOn(createServer());
    const fixed = listener({ allowed: true, sidecarPort: () => null });

    const status = await fixed.apply({ enabled: true, port: taken, allowedHosts: [] });

    expect(status.state).toBe('port-in-use');
    expect(status.url).toBeNull();
    expect(status.message).toContain(String(taken));
  });

  it('stops listening when switched off', async () => {
    const fixed = listener({ allowed: true, sidecarPort: () => null });
    const port = await freePort();
    await fixed.apply({ enabled: true, port, allowedHosts: [] });

    const status = await fixed.apply({ enabled: false, port, allowedHosts: [] });

    expect(status).toEqual({ enabled: false, port, allowedHosts: [], state: 'off', url: null });
    await expect(roundTrip(port, 'x')).rejects.toThrow(/ECONNREFUSED/);
  });

  it('never claims the address outside the installed app', async () => {
    const fixed = listener({ allowed: false, sidecarPort: () => null });
    const port = await freePort();

    const status = await fixed.apply({ enabled: true, port, allowedHosts: [] });

    expect(status.state).toBe('unavailable');
    await expect(roundTrip(port, 'x')).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe('McpHttpListener changes', () => {
  it('applies overlapping changes in order and leaves only the last port open', async () => {
    const fixed = listener({ allowed: true, sidecarPort: () => null });
    const first = await freePort();
    const second = await freePort();

    const [a, b] = await Promise.all([
      fixed.apply({ enabled: true, port: first, allowedHosts: [] }),
      fixed.apply({ enabled: true, port: second, allowedHosts: [] }),
    ]);

    expect(a.state).toBe('listening');
    expect(b).toMatchObject({ state: 'listening', port: second });
    await expect(roundTrip(first, 'x')).rejects.toThrow(/ECONNREFUSED/);
    await fixed.apply({ enabled: false, port: second, allowedHosts: [] });
    await expect(roundTrip(second, 'x')).rejects.toThrow(/ECONNREFUSED/);
  });

  it('keeps connected clients when only the host names change', async () => {
    const sidecar = createServer((socket) => socket.pipe(socket));
    const sidecarPort = await listenOn(sidecar);
    const fixed = listener({ allowed: true, sidecarPort: () => sidecarPort });
    const port = await freePort();
    await fixed.apply({ enabled: true, port, allowedHosts: [] });
    const client = connect({ port, host: '127.0.0.1' });
    await new Promise<void>((resolve) => client.once('connect', () => resolve()));
    let closed = false;
    client.once('close', () => (closed = true));

    const status = await fixed.apply({ enabled: true, port, allowedHosts: ['relay.example'] });

    expect(status.allowedHosts).toEqual(['relay.example']);
    const echoed = await new Promise<string>((resolve) => {
      client.once('data', (chunk) => resolve(chunk.toString()));
      client.write('still here');
    });
    expect(echoed).toBe('still here');
    expect(closed).toBe(false);
    client.destroy();
  });
});

describe('MCP HTTP settings', () => {
  function memoryDb() {
    const rows = new Map<string, string>();
    return {
      rows,
      prepare(sql: string) {
        return {
          get: (key: unknown) => {
            const value = rows.get(String(key));
            return value === undefined ? undefined : { value };
          },
          run: (key: unknown, value: unknown) => {
            if (sql.startsWith('INSERT')) rows.set(String(key), String(value));
          },
        };
      },
    };
  }

  it('defaults to off on the default port and round-trips a saved choice', () => {
    const db = memoryDb();
    expect(readMcpHttpSettings(db)).toEqual({
      enabled: false,
      port: DEFAULT_MCP_HTTP_PORT,
      allowedHosts: [],
    });

    writeMcpHttpSettings(db, {
      enabled: true,
      port: 31000,
      allowedHosts: ['mylaptop.tailnet.ts.net'],
    });

    expect(readMcpHttpSettings(db)).toEqual({
      enabled: true,
      port: 31000,
      allowedHosts: ['mylaptop.tailnet.ts.net'],
    });
  });

  it('falls back to the default port when the stored one is invalid', () => {
    const db = memoryDb();
    db.rows.set('mcp_http_port', '80');
    expect(readMcpHttpSettings(db).port).toBe(DEFAULT_MCP_HTTP_PORT);
  });

  it('drops stored host names the sidecar would ignore', () => {
    const db = memoryDb();
    db.rows.set(
      'mcp_http_allowed_hosts',
      JSON.stringify(['Relay.Example:443', 'relay.example:443', 'bad host!', 7])
    );
    expect(readMcpHttpSettings(db).allowedHosts).toEqual(['relay.example:443']);
  });

  it('writes the list where the sidecar reads it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-http-hosts-'));
    cleanups.push(async () => rmSync(dir, { recursive: true }));
    const path = join(dir, 'nested', 'hosts.json');

    writeAllowedHostsFile(path, ['mylaptop.tailnet.ts.net']);

    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(['mylaptop.tailnet.ts.net']);
  });
});

describe('private MCP port ownership', () => {
  it('follows the authenticated sidecar port and clears stale or invalid targets', () => {
    setMcpHttpInternalPort(35769);
    expect(mcpHttpInternalPort()).toBe(35769);
    setMcpHttpInternalPort(35770);
    expect(mcpHttpInternalPort()).toBe(35770);
    for (const value of [null, undefined, 0, -1, 65536, 1.5, '35769']) {
      setMcpHttpInternalPort(value);
      expect(mcpHttpInternalPort()).toBeNull();
    }
  });
});

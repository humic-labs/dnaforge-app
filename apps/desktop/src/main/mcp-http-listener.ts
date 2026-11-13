import { mkdirSync, writeFileSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { app } from 'electron';
import { handleGroup } from '../shared/ipc-contract';
import type { McpHttpSettings, McpHttpStatus } from '../shared/mcp-http';
import {
  DEFAULT_MCP_HTTP_PORT,
  MAX_MCP_HTTP_ALLOWED_HOSTS,
  isValidPort,
  normalizeAllowedHost,
} from '../shared/mcp-http';
import { agentSdkMcpHttpListenerContract } from '../shared/ipc/agent-sdk-mcp-http-listener.contract';

interface SettingsDatabase {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
  };
}

const ENABLED_KEY = 'mcp_http_enabled';
const PORT_KEY = 'mcp_http_port';
const ALLOWED_HOSTS_KEY = 'mcp_http_allowed_hosts';

export function readMcpHttpSettings(db: SettingsDatabase): McpHttpSettings {
  const read = (key: string): string | undefined => {
    try {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
        | { value: string }
        | undefined;
      return row?.value;
    } catch {
      return undefined;
    }
  };
  const port = Number(read(PORT_KEY));
  let hosts: unknown = [];
  try {
    hosts = JSON.parse(read(ALLOWED_HOSTS_KEY) ?? '[]');
  } catch {
    hosts = [];
  }
  return {
    enabled: read(ENABLED_KEY) === 'true',
    port: isValidPort(port) ? port : DEFAULT_MCP_HTTP_PORT,
    allowedHosts: Array.isArray(hosts) ? parseAllowedHosts(hosts) : [],
  };
}

export function writeMcpHttpSettings(db: SettingsDatabase, settings: McpHttpSettings): void {
  const statement = db.prepare(
    'INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)'
  );
  const updatedAt = Date.now();
  statement.run(ENABLED_KEY, String(settings.enabled), updatedAt);
  statement.run(PORT_KEY, String(settings.port), updatedAt);
  statement.run(ALLOWED_HOSTS_KEY, JSON.stringify(settings.allowedHosts), updatedAt);
}

export function writeAllowedHostsFile(path: string, allowedHosts: readonly string[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(allowedHosts), { mode: 0o600 });
}

function parseAllowedHosts(entries: readonly unknown[]): string[] {
  const hosts = entries
    .map((entry) => (typeof entry === 'string' ? normalizeAllowedHost(entry) : null))
    .filter((entry): entry is string => entry !== null);
  return [...new Set(hosts)].slice(0, MAX_MCP_HTTP_ALLOWED_HOSTS);
}

export class McpHttpListener {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  private current: McpHttpStatus;

  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly options: {
      allowed: boolean;

      sidecarPort: () => number | null;
    }
  ) {
    this.current = { ...offStatus(DEFAULT_MCP_HTTP_PORT, options.allowed), allowedHosts: [] };
  }

  status(): McpHttpStatus {
    return this.current;
  }

  apply(settings: McpHttpSettings): Promise<McpHttpStatus> {
    const next = this.queue.then(() => this.applyNow(settings));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async applyNow(settings: McpHttpSettings): Promise<McpHttpStatus> {
    const { allowedHosts } = settings;

    if (
      this.server &&
      settings.enabled &&
      this.current.enabled &&
      this.current.port === settings.port
    ) {
      this.current = { ...this.current, allowedHosts };
      return this.current;
    }
    await this.stop();
    if (!this.options.allowed || !settings.enabled) {
      this.current = { ...offStatus(settings.port, this.options.allowed), allowedHosts };
      return this.current;
    }
    this.current = { ...(await this.listen(settings.port)), allowedHosts };
    return this.current;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private listen(port: number): Promise<Omit<McpHttpStatus, 'allowedHosts'>> {
    const server = createServer({ allowHalfOpen: true }, (client) => this.pipe(client));
    return new Promise((resolve) => {
      server.once('error', (error: NodeJS.ErrnoException) => {
        resolve({
          enabled: true,
          port,
          state: error.code === 'EADDRINUSE' ? 'port-in-use' : 'error',
          url: null,
          message:
            error.code === 'EADDRINUSE'
              ? `Another program is using port ${port}. Choose a different port.`
              : error.message,
        });
      });
      server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
        this.server = server;
        resolve({ enabled: true, port, state: 'listening', url: `http://127.0.0.1:${port}/mcp` });
      });
    });
  }

  private pipe(client: Socket): void {
    const target = this.options.sidecarPort();
    if (target === null) {
      client.destroy();
      return;
    }
    const upstream = connect({ port: target, host: '127.0.0.1', allowHalfOpen: true });
    for (const socket of [client, upstream]) {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    }
    const closeBoth = () => {
      client.destroy();
      upstream.destroy();
    };
    client.once('error', closeBoth);
    upstream.once('error', closeBoth);
    client.pipe(upstream).pipe(client);
  }
}

function offStatus(port: number, allowed: boolean): Omit<McpHttpStatus, 'allowedHosts'> {
  return allowed
    ? { enabled: false, port, state: 'off', url: null }
    : { enabled: false, port, state: 'unavailable', url: null };
}

export function startMcpHttpListener(deps: {
  allowed: boolean;
  database: () => SettingsDatabase;
  sidecarPort: () => number | null;
  allowedHostsFile: string;
}): void {
  const listener = new McpHttpListener({
    allowed: deps.allowed,
    sidecarPort: deps.sidecarPort,
  });
  handleGroup(agentSdkMcpHttpListenerContract, {
    getMcpHttpStatus: async () => listener.status(),
    setMcpHttp: async (_event, settings: unknown) => {
      const parsed = parseSettings(settings);
      writeMcpHttpSettings(deps.database(), parsed);
      writeAllowedHostsFile(deps.allowedHostsFile, parsed.allowedHosts);
      return listener.apply(parsed);
    },
  });
  const saved = readMcpHttpSettings(deps.database());
  writeAllowedHostsFile(deps.allowedHostsFile, saved.allowedHosts);
  void listener.apply(saved).then((status) => {
    if (status.state === 'port-in-use' || status.state === 'error') {
      console.warn(`[ExternalMCP] HTTP address unavailable: ${status.message ?? status.state}`);
    }
  });
}

function parseSettings(value: unknown): McpHttpSettings {
  const candidate = value as Partial<McpHttpSettings> | null;
  if (
    !candidate ||
    typeof candidate.enabled !== 'boolean' ||
    !isValidPort(candidate.port) ||
    !Array.isArray(candidate.allowedHosts)
  ) {
    throw new Error(
      'MCP HTTP settings need enabled (boolean), a port from 1024 to 65535, and allowedHosts.'
    );
  }
  const invalid = candidate.allowedHosts.filter(
    (entry) => typeof entry !== 'string' || normalizeAllowedHost(entry) === null
  );
  if (invalid.length > 0) {
    throw new Error(`Not a valid host name: ${invalid.map(String).join(', ')}`);
  }
  if (candidate.allowedHosts.length > MAX_MCP_HTTP_ALLOWED_HOSTS) {
    throw new Error(`At most ${MAX_MCP_HTTP_ALLOWED_HOSTS} host names are accepted.`);
  }
  return {
    enabled: candidate.enabled,
    port: candidate.port,
    allowedHosts: parseAllowedHosts(candidate.allowedHosts),
  };
}

export function mcpHttpAllowedHostsFile(): string {
  return join(app.getPath('userData'), 'mcp-http-allowed-hosts.json');
}

let internalPort: number | null = null;

export function setMcpHttpInternalPort(port: unknown): void {
  internalPort = isValidPort(port) ? port : null;
}

export function mcpHttpInternalPort(): number | null {
  return internalPort;
}

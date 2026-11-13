export const DEFAULT_MCP_HTTP_PORT = 29183;

export const MAX_MCP_HTTP_ALLOWED_HOSTS = 16;

export interface McpHttpSettings {
  enabled: boolean;
  port: number;
  allowedHosts: string[];
}

export interface McpHttpStatus extends McpHttpSettings {
  state: 'off' | 'listening' | 'port-in-use' | 'error' | 'unavailable';
  url: string | null;
  message?: string;
}

export function isValidPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port >= 1024 && port <= 65535;
}

export function launcherPlatform(launcher: string): 'win32' | 'posix' {
  return launcher.toLowerCase().endsWith('.cmd') ? 'win32' : 'posix';
}

const HOST_ENTRY =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::[0-9]{1,5})?$/;

export function normalizeAllowedHost(entry: string): string | null {
  const host = entry.trim().toLowerCase();
  return HOST_ENTRY.test(host) ? host : null;
}

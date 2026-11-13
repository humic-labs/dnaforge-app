export type ExternalMcpRegistrationStatus =
  | 'current'
  | 'registered'
  | 'repaired'
  | 'name-conflict'
  | 'failed'
  | 'not-installed';

export interface ExternalMcpRegistrationResult {
  client: 'Claude Code' | 'Codex' | 'Grok Build' | 'Claude Desktop' | 'Cursor';
  status: ExternalMcpRegistrationStatus;
}

export interface ExternalMcpRegistrationSnapshot {
  state: 'pending' | 'complete' | 'failed' | 'development-build';
  launcher: string | null;
  clients: ExternalMcpRegistrationResult[];
  error?: string;
}

export function externalMcpStdioConfig(
  launcher: string,
  platform: string
): { command: string; args: string[] } {
  return platform === 'win32'
    ? { command: 'cmd', args: ['/c', launcher, 'mcp'] }
    : { command: launcher, args: ['mcp'] };
}

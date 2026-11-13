export const DNAFORGE_MCP_SERVER_NAME = 'dnaforge';

export interface CliMcpServerLaunch {
  serverName: typeof DNAFORGE_MCP_SERVER_NAME;
  command: string;
  args: string[];
  env: Record<string, string>;
  assertCurrent?: () => void;
}

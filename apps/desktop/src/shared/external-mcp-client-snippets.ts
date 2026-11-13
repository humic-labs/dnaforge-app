import { externalMcpStdioConfig } from './external-mcp-registration';

export interface ExternalMcpClientSnippet {
  id: string;
  client: string;
  where: string;
  kind: 'command' | 'json';
  text: string;
}

const SERVER_NAME = 'dnaforge';

export function externalMcpClientSnippets(
  launcher: string,
  platform: string
): ExternalMcpClientSnippet[] {
  const windows = platform === 'win32';
  const stdio = externalMcpStdioConfig(launcher, platform);
  const shellCommand = windows
    ? `cmd /c ${quoteForShell(launcher)} mcp`
    : `${quoteForShell(launcher)} mcp`;
  const json = (value: unknown) => JSON.stringify(value, null, 2);
  const claudeDesktopFile = windows
    ? '%APPDATA%\\Claude\\claude_desktop_config.json'
    : '~/Library/Application Support/Claude/claude_desktop_config.json';
  const zedFile = windows ? '%APPDATA%\\Zed\\settings.json' : '~/.config/zed/settings.json';

  return [
    {
      id: 'claude-code',
      client: 'Claude Code',
      where: 'Run in a terminal',
      kind: 'command',
      text: `claude mcp add --scope user ${SERVER_NAME} -- ${shellCommand}`,
    },
    {
      id: 'codex',
      client: 'Codex',
      where: 'Run in a terminal',
      kind: 'command',
      text: `codex mcp add ${SERVER_NAME} -- ${shellCommand}`,
    },
    {
      id: 'claude-desktop',
      client: 'Claude Desktop',
      where: `Add to ${claudeDesktopFile}`,
      kind: 'json',
      text: json({ mcpServers: { [SERVER_NAME]: stdio } }),
    },
    {
      id: 'cursor',
      client: 'Cursor',
      where: 'Add to ~/.cursor/mcp.json',
      kind: 'json',
      text: json({ mcpServers: { [SERVER_NAME]: stdio } }),
    },
    {
      id: 'vscode',
      client: 'VS Code',
      where: 'Add to mcp.json (Command Palette: "MCP: Open User Configuration")',
      kind: 'json',
      text: json({ servers: { [SERVER_NAME]: { type: 'stdio', ...stdio } } }),
    },
    {
      id: 'windsurf',
      client: 'Windsurf',
      where: "Add to Windsurf's mcp_config.json",
      kind: 'json',
      text: json({ mcpServers: { [SERVER_NAME]: stdio } }),
    },
    {
      id: 'zed',
      client: 'Zed',
      where: `Add to ${zedFile}`,
      kind: 'json',
      text: json({ context_servers: { [SERVER_NAME]: { ...stdio, env: {} } } }),
    },
    {
      id: 'gemini-cli',
      client: 'Gemini CLI',
      where: 'Run in a terminal',
      kind: 'command',
      text: `gemini mcp add -s user ${SERVER_NAME} ${shellCommand}`,
    },
    {
      id: 'other',
      client: 'Any other MCP client',
      where: 'Configure a stdio server with this command and arguments',
      kind: 'json',
      text: json(stdio),
    },
  ];
}

function quoteForShell(path: string): string {
  return /^[\w./\\:-]+$/u.test(path) ? path : `"${path}"`;
}

export const API_KEY_PLACEHOLDER = '<your DNAForge API key>';
export const API_KEY_ENV_VAR = 'DNAFORGE_API_KEY';

export function externalMcpHttpSnippets(url: string): ExternalMcpClientSnippet[] {
  const bearer = `Bearer ${API_KEY_PLACEHOLDER}`;
  const json = (value: unknown) => JSON.stringify(value, null, 2);
  return [
    {
      id: 'claude-code',
      client: 'Claude Code',
      where: 'Run in a terminal',
      kind: 'command',
      text: `claude mcp add --transport http ${SERVER_NAME} ${url} --header "Authorization: ${bearer}"`,
    },
    {
      id: 'codex',
      client: 'Codex',
      where: `Run in a terminal, then set ${API_KEY_ENV_VAR} to your key in the environment Codex starts from`,
      kind: 'command',
      text: `codex mcp add ${SERVER_NAME} --url ${url} --bearer-token-env-var ${API_KEY_ENV_VAR}`,
    },
    {
      id: 'cursor',
      client: 'Cursor',
      where: 'Add to ~/.cursor/mcp.json',
      kind: 'json',
      text: json({ mcpServers: { [SERVER_NAME]: { url, headers: { Authorization: bearer } } } }),
    },
    {
      id: 'vscode',
      client: 'VS Code',
      where: 'Add to mcp.json (Command Palette: "MCP: Open User Configuration")',
      kind: 'json',
      text: json({
        servers: { [SERVER_NAME]: { type: 'http', url, headers: { Authorization: bearer } } },
      }),
    },
    {
      id: 'windsurf',
      client: 'Windsurf',
      where: "Add to Windsurf's mcp_config.json",
      kind: 'json',
      text: json({
        mcpServers: { [SERVER_NAME]: { serverUrl: url, headers: { Authorization: bearer } } },
      }),
    },
    {
      id: 'zed',
      client: 'Zed',
      where: "Add to Zed's settings.json",
      kind: 'json',
      text: json({
        context_servers: { [SERVER_NAME]: { url, headers: { Authorization: bearer } } },
      }),
    },
    {
      id: 'gemini-cli',
      client: 'Gemini CLI',
      where: 'Run in a terminal',
      kind: 'command',
      text: `gemini mcp add -s user --transport http --header "Authorization: ${bearer}" ${SERVER_NAME} ${url}`,
    },
  ];
}

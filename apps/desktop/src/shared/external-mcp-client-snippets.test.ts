// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { externalMcpClientSnippets, externalMcpHttpSnippets } from './external-mcp-client-snippets';

const MAC_LAUNCHER = '/Applications/DNAForge.app/Contents/Resources/cli/dnaforge';
const WINDOWS_LAUNCHER = 'C:\\Program Files\\DNAForge\\resources\\cli\\dnaforge.cmd';

describe('external MCP client snippets', () => {
  it('uses each client documented config key and the bundled launcher', () => {
    const snippets = externalMcpClientSnippets(MAC_LAUNCHER, 'darwin');
    const parsed = Object.fromEntries(
      snippets
        .filter((snippet) => snippet.kind === 'json')
        .map((snippet) => [snippet.id, JSON.parse(snippet.text) as Record<string, unknown>])
    );
    const stdio = { command: MAC_LAUNCHER, args: ['mcp'] };

    expect(parsed['claude-desktop']).toEqual({ mcpServers: { dnaforge: stdio } });
    expect(parsed.cursor).toEqual({ mcpServers: { dnaforge: stdio } });
    expect(parsed.windsurf).toEqual({ mcpServers: { dnaforge: stdio } });
    expect(parsed.vscode).toEqual({ servers: { dnaforge: { type: 'stdio', ...stdio } } });
    expect(parsed.zed).toEqual({ context_servers: { dnaforge: { ...stdio, env: {} } } });
    expect(parsed.other).toEqual(stdio);
    expect(snippets.find((snippet) => snippet.id === 'claude-code')?.text).toBe(
      `claude mcp add --scope user dnaforge -- ${MAC_LAUNCHER} mcp`
    );
    expect(snippets.find((snippet) => snippet.id === 'claude-desktop')?.where).toContain(
      'Library/Application Support/Claude/claude_desktop_config.json'
    );
  });

  it('runs the Windows launcher through cmd /c and keeps its path exact', () => {
    const snippets = externalMcpClientSnippets(WINDOWS_LAUNCHER, 'win32');
    const byId = new Map(snippets.map((snippet) => [snippet.id, snippet]));

    expect(byId.get('codex')?.text).toBe(
      `codex mcp add dnaforge -- cmd /c "${WINDOWS_LAUNCHER}" mcp`
    );
    expect(byId.get('gemini-cli')?.text).toBe(
      `gemini mcp add -s user dnaforge cmd /c "${WINDOWS_LAUNCHER}" mcp`
    );
    expect(JSON.parse(byId.get('cursor')?.text ?? '{}')).toEqual({
      mcpServers: { dnaforge: { command: 'cmd', args: ['/c', WINDOWS_LAUNCHER, 'mcp'] } },
    });
    expect(byId.get('claude-desktop')?.where).toContain('%APPDATA%\\Claude');
  });

  it('never embeds a port, key, or token', () => {
    const text = externalMcpClientSnippets(MAC_LAUNCHER, 'darwin')
      .map((snippet) => snippet.text)
      .join('\n');
    expect(text).not.toMatch(/127\.0\.0\.1|localhost|dna_key_|token|Bearer/i);
  });

  it('gives URL clients the address and a Bearer key header in each documented shape', () => {
    const url = 'http://127.0.0.1:29183/mcp';
    const byId = new Map(externalMcpHttpSnippets(url).map((snippet) => [snippet.id, snippet]));
    const header = { Authorization: 'Bearer <your DNAForge API key>' };

    expect(byId.get('claude-code')?.text).toBe(
      `claude mcp add --transport http dnaforge ${url} --header "Authorization: Bearer <your DNAForge API key>"`
    );
    expect(byId.get('codex')?.text).toBe(
      `codex mcp add dnaforge --url ${url} --bearer-token-env-var DNAFORGE_API_KEY`
    );
    expect(JSON.parse(byId.get('vscode')?.text ?? '{}')).toEqual({
      servers: { dnaforge: { type: 'http', url, headers: header } },
    });
    expect(JSON.parse(byId.get('windsurf')?.text ?? '{}')).toEqual({
      mcpServers: { dnaforge: { serverUrl: url, headers: header } },
    });
    expect(JSON.parse(byId.get('zed')?.text ?? '{}')).toEqual({
      context_servers: { dnaforge: { url, headers: header } },
    });
    expect(byId.has('claude-desktop')).toBe(false);
  });
});

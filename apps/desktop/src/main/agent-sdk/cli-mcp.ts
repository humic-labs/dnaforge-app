import type { McpStdioServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerStdio } from '@agentclientprotocol/sdk';
import {
  createApiClient,
  discoverMcpSurfaceWithContextMcpDiscoverPost,
  isApiError,
} from '@waypoint/api-client';
import { createSidecarFetch } from '../sidecar-request-auth';
import type { GrokUserInputHandoff } from './grok-user-input-bridge';

import { DNAFORGE_MCP_SERVER_NAME, type CliMcpServerLaunch } from './cli-mcp-launch';
export { DNAFORGE_MCP_SERVER_NAME, type CliMcpServerLaunch } from './cli-mcp-launch';
export const DNAFORGE_MCP_TOOL_PREFIX = `mcp__${DNAFORGE_MCP_SERVER_NAME}__`;
export const DNAFORGE_MCP_CLIENT_PROTOCOL_VERSION = '2025-11-25';

export interface CliMcpBridgeConfig {
  apiUrl: string;
  sessionToken: string;
  sessionAuthority?: { path: string; ownerId: string };
  agentIdentityId: string;
  capabilities: string[];
  command: string;
  commandArgs: string[];
  turnId?: string;
  assertCurrent?: () => void;
}

export function buildCliMcpServerLaunch(config: CliMcpBridgeConfig): CliMcpServerLaunch {
  config.assertCurrent?.();
  const capabilities = JSON.stringify(config.capabilities);
  return {
    serverName: DNAFORGE_MCP_SERVER_NAME,
    command: config.command,
    args: [...config.commandArgs],
    ...(config.assertCurrent ? { assertCurrent: config.assertCurrent } : {}),
    env: {
      DNAFORGE_API_URL: config.apiUrl,
      DNAFORGE_MCP_SESSION_TOKEN: config.sessionToken,
      DNAFORGE_MCP_SESSION_AUTHORITY_PATH: config.sessionAuthority?.path ?? '',
      DNAFORGE_MCP_SESSION_AUTHORITY_OWNER: config.sessionAuthority?.ownerId ?? '',
      DNAFORGE_MCP_API_KEY: '',
      DNAFORGE_MCP_AGENT_IDENTITY: config.agentIdentityId,
      DNAFORGE_MCP_CLIENT_SURFACE: 'dnaforge-chat',
      DNAFORGE_MCP_GRANT_CAPABILITIES: capabilities,
      ...(config.turnId ? { DNAFORGE_MCP_TURN_ID: config.turnId } : {}),
    },
  };
}

export function buildClaudeMcpServers(
  launch: CliMcpServerLaunch
): Record<string, McpStdioServerConfig> {
  launch.assertCurrent?.();
  return {
    [launch.serverName]: {
      type: 'stdio',
      command: launch.command,
      args: launch.args,
      env: launch.env,
      timeout: 120_000,
      alwaysLoad: true,
    },
  };
}

export {
  buildCodexMcpConfig,
  buildCodexMcpIsolationConfig,
  CODEX_APP_MCP_FEATURES,
} from './codex-mcp-session-config';

export function buildGrokMcpServer(
  launch: CliMcpServerLaunch,
  handoff?: GrokUserInputHandoff
): McpServerStdio {
  launch.assertCurrent?.();
  return {
    name: launch.serverName,
    command: launch.command,
    args: launch.args,
    env: [
      ...Object.entries(launch.env).map(([name, value]) => ({ name, value })),
      { name: 'DNAFORGE_MCP_EXPOSE_AGENT_USER_INPUT', value: '1' },
      ...(handoff
        ? [
            { name: 'DNAFORGE_MCP_AGENT_USER_INPUT_HANDOFF_PATH', value: handoff.path },
            { name: 'DNAFORGE_MCP_AGENT_USER_INPUT_HANDOFF_TOKEN', value: handoff.token },
          ]
        : []),
    ],
  };
}

export async function listDnaForgeMcpToolNames(
  config: Pick<
    CliMcpBridgeConfig,
    'apiUrl' | 'sessionToken' | 'agentIdentityId' | 'capabilities' | 'assertCurrent'
  >,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<string[]> {
  const clientInfo = {
    name: 'dnaforge-desktop-catalog-parity',
    version: '1',
  };
  const timeoutMs = options.timeoutMs ?? 20_000;
  const requestController = new AbortController();
  const forwardAbort = (): void => requestController.abort(options.signal?.reason);
  if (options.signal?.aborted) forwardAbort();
  else options.signal?.addEventListener('abort', forwardAbort, { once: true });
  const timeout = setTimeout(() => requestController.abort(), timeoutMs);
  timeout.unref?.();
  const authenticatedFetch = createSidecarFetch({
    getBaseUrl: () => config.apiUrl,
    getCurrentToken: () => {
      config.assertCurrent?.();
      return config.sessionToken;
    },
  });
  const apiClient = createApiClient({
    baseUrl: config.apiUrl,
    fetch: authenticatedFetch,
  });
  try {
    let body: { tools?: Array<{ name?: unknown }> };
    try {
      body = (
        await discoverMcpSurfaceWithContextMcpDiscoverPost(
          { clientInfo },
          apiClient.options({
            signal: requestController.signal,
            headers: {
              'X-DNAForge-Agent-Identity': config.agentIdentityId,
              'X-DNAForge-Agent-Capabilities': JSON.stringify(config.capabilities),
            },
          })
        )
      ).data as typeof body;
    } catch (error) {
      if (isApiError(error)) {
        throw new Error(`DNAForge tool discovery failed with HTTP ${error.status}.`);
      }
      throw error;
    }
    const toolNames = new Set<string>();
    for (const tool of Array.isArray(body.tools) ? body.tools : []) {
      const name = tool.name;
      if (typeof name === 'string' && name.trim()) {
        toolNames.add(name);
      }
    }
    return [...toolNames].sort();
  } catch (error) {
    if (!options.signal?.aborted && requestController.signal.aborted) {
      throw new Error(`DNAForge tool discovery timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', forwardAbort);
  }
}

export async function listClaudeAllowedDnaForgeMcpTools(
  config: Pick<
    CliMcpBridgeConfig,
    'apiUrl' | 'sessionToken' | 'agentIdentityId' | 'capabilities' | 'assertCurrent'
  >
): Promise<string[]> {
  const toolNames = await listDnaForgeMcpToolNames(config);
  return toolNames.map((name) => `${DNAFORGE_MCP_TOOL_PREFIX}${name}`);
}

export function isDnaForgeMcpTool(toolName: string): boolean {
  return toolName.startsWith(DNAFORGE_MCP_TOOL_PREFIX);
}

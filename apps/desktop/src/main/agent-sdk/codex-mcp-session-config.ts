import type { CodexAppServerProtocol } from '@waypoint/codex-app-server-contract';
import type { CliMcpServerLaunch } from './cli-mcp-launch';

export const CODEX_APP_MCP_FEATURES = { plugins: false, apps: false } as const;

export function buildCodexMcpIsolationConfig(
  inheritedServerNames: readonly string[],
  appServerName?: string
) {
  const disabledServers = Object.fromEntries(
    [...new Set(inheritedServerNames)]
      .filter((name) => name !== appServerName)
      .map((name) => [name, { enabled: false as const }] as const)
  );
  return {
    ...(Object.keys(disabledServers).length > 0 ? { mcp_servers: disabledServers } : {}),
    features: CODEX_APP_MCP_FEATURES,
  };
}

export function buildCodexMcpConfig(
  launch: CliMcpServerLaunch,
  inheritedServerNames: readonly string[] = []
) {
  launch.assertCurrent?.();
  const isolation = buildCodexMcpIsolationConfig(inheritedServerNames, launch.serverName);
  return {
    ...isolation,
    mcp_servers: {
      ...isolation.mcp_servers,
      [launch.serverName]: {
        enabled: true,
        command: launch.command,
        args: launch.args,
        env: launch.env,
        startup_timeout_sec: 120,

        required: true,
        default_tools_approval_mode: 'approve',
      },
    },
  } satisfies NonNullable<CodexAppServerProtocol.v2.ThreadStartParams['config']>;
}

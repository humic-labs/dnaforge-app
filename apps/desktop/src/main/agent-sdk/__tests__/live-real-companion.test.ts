import { describe, expect, it } from 'vitest';
import { proveCliMcpToolsReachable } from '../cli-mcp-liveness';
import { listDnaForgeMcpToolNames } from '../cli-mcp';
import { requiredWorkspaceToolNames } from '../required-workspace-tools';

const ENABLED = process.env.DNAFORGE_LIVE_COMPANION_CHECK === '1';

describe.skipIf(!ENABLED)('live real companion', () => {
  it('reports the true state of the installed companion', async () => {
    const bridge = {
      apiUrl: process.env.DNAFORGE_API_URL!,
      sessionToken: process.env.DNAFORGE_MCP_SESSION_TOKEN!,
      agentIdentityId: process.env.DNAFORGE_MCP_AGENT_IDENTITY!,
      capabilities: JSON.parse(process.env.DNAFORGE_MCP_GRANT_CAPABILITIES!) as string[],
    };
    const expectedToolNames = await listDnaForgeMcpToolNames(bridge);
    const result = await proveCliMcpToolsReachable(
      {
        serverName: 'dnaforge',
        command: process.env.LIVE_COMPANION_CMD!,
        args: JSON.parse(process.env.LIVE_COMPANION_ARGS!),
        env: {
          DNAFORGE_API_URL: process.env.DNAFORGE_API_URL!,
          DNAFORGE_MCP_SESSION_TOKEN: process.env.DNAFORGE_MCP_SESSION_TOKEN!,
          DNAFORGE_MCP_AGENT_IDENTITY: process.env.DNAFORGE_MCP_AGENT_IDENTITY!,
          DNAFORGE_MCP_GRANT_CAPABILITIES: process.env.DNAFORGE_MCP_GRANT_CAPABILITIES!,
        },
      },
      {
        requiredToolNames: requiredWorkspaceToolNames(),
        expectedToolNames,
        timeoutMs: 25_000,
      }
    );
    // eslint-disable-next-line no-console
    console.log('LIVE GATE VERDICT:', result.ok ? 'PASS' : `REFUSE (${result.reason})`);
    if (!result.ok) {
      console.log('detail:', result.detail.slice(0, 300));
      if (result.missingToolNames) console.log('MISSING:', result.missingToolNames.join(', '));
    }
    if (result.ok)
      console.log('SERVED EXACT AUTHORIZED CATALOG:', result.toolNames.length, 'tools');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.probeToolName).toBe('get_workspace');
  });
});

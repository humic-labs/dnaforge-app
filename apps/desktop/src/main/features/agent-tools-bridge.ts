import { app, type BrowserWindow } from 'electron';
import { join } from 'node:path';
import {
  createApprovalMemory,
  createJsonAlwaysAllowStore,
  setDefaultApprovalMemory,
} from '../agent-sdk/approval-memory';
import {
  confirmDestructiveFileWithRenderer,
  requestAgentUserInputWithRenderer,
} from '../agent-confirm';
import {
  setAgentSdkConfirmDestructiveFileProvider,
  setAgentSdkRequestUserInputProvider,
} from '../agent-sdk';
import {
  setAgentSessionConfirmDestructiveFileProvider,
  setAgentSessionRequestUserInputProvider,
} from '../agent-session';
import { startAgentToolsBridge, type AgentToolsBridgeServer } from '../agent-tools-bridge';
import { resolveMcpCompanionExecutable } from '../sidecar-binary';
import { sidecarSessionAuthority } from '../sidecar-session-runtime';
import { testRendererBridgeOptions } from './test-hooks';

export interface AgentToolsSidecarConnection {
  readonly url: string;
  readonly sessionToken: string;
}

export function createAgentToolsBridge() {
  let bridge: AgentToolsBridgeServer | null = null;

  async function start(mainWindow: BrowserWindow): Promise<void> {
    try {
      bridge = await startAgentToolsBridge(mainWindow, {
        ...testRendererBridgeOptions(),
        observationSessionToken: () => {
          const current = sidecarSessionAuthority.snapshot();
          return current.state === 'ready' ? current.token : null;
        },
      });
      console.log(
        `[AgentToolsBridge] Listening on ${bridge.url} (identity=${bridge.agentIdentityId})`
      );
      if (!process.env.DNAFORGE_MCP_AGENT_IDENTITY) {
        process.env.DNAFORGE_MCP_AGENT_IDENTITY = bridge.agentIdentityId;
      }
      if (!process.env.DNAFORGE_MCP_GRANT_CAPABILITIES) {
        process.env.DNAFORGE_MCP_GRANT_CAPABILITIES = JSON.stringify(bridge.capabilities);
      }
    } catch (err) {
      console.error('[AgentToolsBridge] Failed to start renderer bridge:', err);
    }
  }

  function installRendererPrompts(mainWindow: BrowserWindow): void {
    setDefaultApprovalMemory(
      createApprovalMemory(
        createJsonAlwaysAllowStore(join(app.getPath('userData'), 'agent-always-allow.json'))
      )
    );
    setAgentSdkConfirmDestructiveFileProvider(
      () => (request) => confirmDestructiveFileWithRenderer(mainWindow, request)
    );
    setAgentSdkRequestUserInputProvider(
      () => (request, signal) =>
        requestAgentUserInputWithRenderer(mainWindow, request, undefined, signal)
    );
    setAgentSessionConfirmDestructiveFileProvider(
      () => (request, signal) =>
        confirmDestructiveFileWithRenderer(mainWindow, request, undefined, signal)
    );
    setAgentSessionRequestUserInputProvider(
      () => (request, signal) =>
        requestAgentUserInputWithRenderer(mainWindow, request, undefined, signal)
    );
  }

  function requireReady(): void {
    if (!bridge) {
      throw new Error('The molecular agent tool bridge is unavailable. Restart the app and retry.');
    }
    sidecarSessionAuthority.currentToken();
    resolveMcpCompanionExecutable({
      isPackaged: app.isPackaged,
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
    });
  }

  function sidecarConnection(): AgentToolsSidecarConnection | undefined {
    return bridge ? { url: bridge.url, sessionToken: bridge.sessionToken } : undefined;
  }

  function close(): void {
    const bridgeToClose = bridge;
    bridge = null;
    void bridgeToClose?.close().catch((err) => {
      console.error('[AgentToolsBridge] Failed to close renderer bridge:', err);
    });
  }

  return {
    start,
    current: (): AgentToolsBridgeServer | null => bridge,
    installRendererPrompts,
    requireReady,
    sidecarConnection,
    close,
  };
}

export const agentToolsBridge = createAgentToolsBridge();

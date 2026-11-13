import { join } from 'node:path';
import type { MainFeature } from './main-feature';

export const externalAgentToolsFeature: MainFeature = {
  id: 'external-agent-tools',
  startAgentTools: async ({ authority, getApiUrl, getBridge, startBridge }) => {
    const { app } = await import('electron');
    const { bindExternalAccessObservationSink } = await import('../external-access-observation');
    const { trackAllowedEvent } = await import('../analytics');
    const { createCliMcpAuthorityReceipt } = await import('../agent-sdk/cli-mcp-authority');
    const { createReadyCliMcpBridgeProvider } = await import('../agent-sdk/cli-mcp-provider');
    const { setAgentSdkCliMcpBridgeProvider } = await import('../agent-sdk');
    const { setAgentSessionCliMcpBridgeProvider } = await import('../agent-session');
    const { resolveMcpCompanionExecutable } = await import('../sidecar-binary');
    bindExternalAccessObservationSink(
      (observation) => trackAllowedEvent('external_access_lifecycle_observed', observation),
      (observation) => trackAllowedEvent('loop_suppressed', observation)
    );
    await startBridge();
    const receipt = createCliMcpAuthorityReceipt({
      directory: join(app.getPath('userData'), 'cli-mcp-authority'),
      authority,
      getApiUrl,
    });
    app.once('will-quit', receipt.dispose);
    const provider = createReadyCliMcpBridgeProvider(authority, (snapshot) => {
      const bridge = getBridge();
      if (!bridge) {
        throw new Error(
          'The DNAForge agent tools bridge is unavailable. Restart the app, then retry.'
        );
      }
      const companion = resolveMcpCompanionExecutable({
        isPackaged: app.isPackaged,
        appPath: app.getAppPath(),
        resourcesPath: process.resourcesPath,
      });
      return {
        apiUrl: getApiUrl(),
        sessionToken: snapshot.token,
        sessionAuthority: { path: receipt.path, ownerId: receipt.ownerId },
        agentIdentityId: bridge.agentIdentityId,
        capabilities: [...bridge.capabilities],
        command: companion.command,
        commandArgs: companion.args,
      };
    });
    setAgentSdkCliMcpBridgeProvider(provider);
    setAgentSessionCliMcpBridgeProvider(provider);
  },
};

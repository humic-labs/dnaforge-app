import { userMessage } from '@waypoint/user-messages';
import type { PlatformBridge } from '../platform/types';
import { DEFAULT_MCP_HTTP_PORT } from '../shared/mcp-http';
import { BUILT_IN_AGENT_PERMISSION_CATALOG } from '../shared/agent-permissions';

export function createHostedAgentCapabilities(): PlatformBridge['agentCapabilities'] {
  const unavailable = (error: string) => ({ ok: false as const, error });
  return {
    discover: async (request) => ({
      schemaVersion: 1,
      snapshotId: `hosted-browser-${request.provider}`,
      provider: request.provider,
      providerVersion: null,
      accountFingerprint: null,
      workspaceFingerprint: null,
      capturedAt: Date.now(),
      controls: [],
    }),
    resolve: async () => ({ ok: false, reason: 'stale-snapshot' as const }),
    inspectSkill: async () => unavailable(userMessage('hosted.agentUnavailable')),
    forkConversation: async () => unavailable(userMessage('hosted.agentUnavailable')),
    listManaged: async () => ({ commands: [], skills: [], memory: [] }),
    saveCommand: async () => unavailable(userMessage('hosted.agentUnavailable')),
    saveSkill: async () => unavailable(userMessage('hosted.agentUnavailable')),
    importSkill: async () => unavailable(userMessage('hosted.agentUnavailable')),
    setSkillEnabled: async () => unavailable(userMessage('hosted.agentUnavailable')),
    setProviderSkillEnabled: async () => unavailable(userMessage('hosted.agentUnavailable')),
    listSkillPacks: async () => [],
    browseSkillPack: async () => unavailable(userMessage('hosted.agentUnavailable')),
    reviewCatalogSkill: async () => unavailable(userMessage('hosted.agentUnavailable')),
    installCatalogSkill: async () => unavailable(userMessage('hosted.agentUnavailable')),
    removeSkill: async () => unavailable(userMessage('hosted.agentUnavailable')),
    removeCommand: async () => unavailable(userMessage('hosted.agentUnavailable')),
    saveMemory: async () => unavailable(userMessage('hosted.agentUnavailable')),
    removeMemory: async () => unavailable(userMessage('hosted.agentUnavailable')),
    resetProviderMemory: async () => unavailable(userMessage('hosted.agentUnavailable')),
    inspectProviderPlugin: async () => unavailable(userMessage('hosted.agentUnavailable')),
    installProviderPlugin: async () => unavailable(userMessage('hosted.agentUnavailable')),
    removeProviderPlugin: async () => unavailable(userMessage('hosted.agentUnavailable')),
  };
}

export function createHostedAgentSdk(): PlatformBridge['agentSdk'] {
  const missing = {
    cli: 'missing' as const,
    path: null,
    auth: 'unauthenticated' as const,
    defaultModel: null,
  };
  return {
    detect: async () => ({
      claudeCode: { ...missing, keychainEntryPresent: null, credentialsFilePresent: null },
      codex: { ...missing, authMode: null, authFilePresent: false },
      grok: missing,
    }),
    getHelperLifecycleSnapshot: async () => ({
      active: 0,
      started: 0,
      settled: 0,
      peakActive: 0,
    }),
    getExternalMcpRegistration: async () => ({
      state: 'development-build' as const,
      launcher: null,
      clients: [],
    }),
    refreshExternalMcpRegistration: async () => ({
      state: 'development-build' as const,
      launcher: null,
      clients: [],
    }),
    getMcpHttpStatus: async () => ({
      enabled: false,
      port: DEFAULT_MCP_HTTP_PORT,
      allowedHosts: [],
      state: 'unavailable' as const,
      url: null,
    }),
    setMcpHttp: async (settings) => ({
      ...settings,
      state: 'unavailable' as const,
      url: null,
    }),
    probeMatrix: async () => [],
    onTraceEvent: () => () => undefined,
    onAuthEvent: () => () => undefined,
    cancelQuery: async () => ({ ok: true, cancelled: false }),
    authenticate: async (transport, options) => ({
      authId: options?.authId ?? 'hosted-browser-auth',
      transport,
      ok: false,
      status: 'not_installed' as const,
      command: [],
      output: '',
      error: userMessage('hosted.agentUnavailable'),
      durationMs: 0,
    }),
    query: async (transport) => ({
      transport,
      ok: false,
      text: '',
      error: userMessage('hosted.agentUnavailable'),
      durationMs: 0,
    }),
  };
}

export function createHostedAgentSession(): PlatformBridge['agentSession'] {
  return {
    onEvent: () => () => undefined,
    start: async (request) => ({
      sessionId: request.sessionId ?? crypto.randomUUID(),
      provider: request.provider,
      authorityProfileId: request.authorityProfileId,
      ok: false,
      text: '',
      error:
        'Local CLI agent sessions are not available in the browser. Use DNAForge AI after joining Hosted AI participation.',
      durationMs: 0,
      stopState: 'failed' as const,
      workspaceProvenance: {
        policy: request.workspaceGrounding,
        grounded: false,
        completedWorkspaceTools: [],
        completedWorkspaceResources: [],
      },
    }),
    cancel: async () => ({ ok: true, cancelled: false, state: 'not_found' as const }),
    get: async () => null,
    listSchedules: async () => [],
    cancelSchedule: async () => ({ ok: false, schedule: null }),
    listAlwaysAllowRules: async () => [],
    setAlwaysAllowRuleEnabled: async () => [],
    removeAlwaysAllowRule: async () => [],
    permissionCatalog: async () => BUILT_IN_AGENT_PERMISSION_CATALOG,
  };
}

export function createHostedAgentAttachments(): PlatformBridge['agentAttachments'] {
  return {
    capture: async () => ({
      ok: false,
      error: userMessage('hosted.agentUnavailable'),
    }),
    read: async () => ({
      ok: false,
      error: userMessage('hosted.agentUnavailable'),
    }),
  };
}

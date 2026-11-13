import type { AgentCapabilitySelection } from './agent-capability-controls';
import type { AgentShellSupervision } from './agent-permissions';

export type AgentCliStatus = 'installed' | 'missing';
export type AgentAuthStatus = 'authenticated' | 'unauthenticated' | 'unknown';
export type AgentTransport = 'claude-agent-sdk' | 'codex-sdk' | 'grok-acp';
export type AgentCliPathOverridesShape = Partial<Record<AgentTransport, string>>;
export type AgentCliPermissionMode = 'app-supervised' | 'native-cli';
export type AgentToolExposure = 'none' | 'auto' | 'required';
export type { AgentShellSupervision };
export type AgentCliModelReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'ultra';
export type AgentCliModelPersonality = string;
export interface AgentCliModelServiceTierShape {
  id: string;
  label: string;
  description?: string;
}
export interface AgentCliModelCapabilityShape {
  id: string;
  displayName: string;
  description?: string;
  reasoningEfforts: AgentCliModelReasoningEffort[];
  defaultReasoningEffort?: AgentCliModelReasoningEffort | null;
  inputModalities?: string[];
  supportsPersonality?: boolean;
  styles?: AgentCliModelServiceTierShape[];
  defaultStyle?: string | null;
  serviceTiers?: AgentCliModelServiceTierShape[];
  defaultServiceTier?: string | null;
  isDefault?: boolean;
}
export type AgentCliModelCatalogStatus = 'complete' | 'failed' | 'not_attempted';
export type AgentCliModelCatalogSource =
  | 'claude-sdk-initialization'
  | 'codex-app-server'
  | 'grok-acp-initialization';
export interface AgentCliModelCatalogDiscoveryShape {
  status: AgentCliModelCatalogStatus;
  source: AgentCliModelCatalogSource;
  executablePath: string | null;
  observedModelCount: number;
  error: string | null;
}
export type AgentQueryStopState = 'completed' | 'failed' | 'cancelled' | 'stop_requested';
export type AgentAuthFlowStatus = 'completed' | 'failed' | 'not_installed' | 'timed_out';
export type AgentAuthStream = 'stdout' | 'stderr' | 'system';
export type AgentProbeSupport = 'supported' | 'not_supported' | 'not_required' | 'unknown';
export type AgentProbeToolAccess = 'native_tools_enabled' | 'read_only' | 'none';
export type AgentProbePermissionMode =
  | 'interactive'
  | 'non_interactive'
  | 'unknown'
  | 'unsupported';
export type AgentProbeReleaseMode =
  | 'local_cli_with_consent'
  | 'read_only'
  | 'dev_only'
  | 'unsupported';
export type AgentProbeStopState = 'cancelled' | 'stop_requested' | 'unsupported';

export interface ClaudeCodeDetectionShape {
  cli: AgentCliStatus;
  path: string | null;
  auth: AgentAuthStatus;
  defaultModel: string | null;
  keychainEntryPresent: boolean | null;
  credentialsFilePresent: boolean | null;
  searchedDirs?: string[];
  models?: AgentCliModelCapabilityShape[];
  modelCatalog?: AgentCliModelCatalogDiscoveryShape;
}

export interface CodexDetectionShape {
  cli: AgentCliStatus;
  path: string | null;
  auth: AgentAuthStatus;
  defaultModel: string | null;
  configuredReasoningEffort?: string | null;
  authMode: 'chatgpt' | 'apikey' | null;
  authFilePresent: boolean;
  searchedDirs?: string[];
  models?: AgentCliModelCapabilityShape[];
  modelCatalog?: AgentCliModelCatalogDiscoveryShape;
}

export interface GrokDetectionShape {
  cli: AgentCliStatus;
  path: string | null;
  auth: AgentAuthStatus;
  defaultModel: string | null;
  availableModels?: string[];
  models?: AgentCliModelCapabilityShape[];
  searchedDirs?: string[];
  modelCatalog?: AgentCliModelCatalogDiscoveryShape;
}

export interface AgentSdkDetectionShape {
  claudeCode: ClaudeCodeDetectionShape;
  codex: CodexDetectionShape;
  grok: GrokDetectionShape;
}

export interface AgentQuerySuccessOrProviderFailureShape {
  transport: AgentTransport;
  ok: boolean;
  text: string;
  error?: string;
  durationMs: number;
  stopState?: AgentQueryStopState;
}

export interface AgentQueryBoundaryFailureShape {
  transport: string;
  ok: false;
  text: '';
  error: string;
  durationMs: 0;
}

export type AgentQueryResultShape =
  | AgentQuerySuccessOrProviderFailureShape
  | AgentQueryBoundaryFailureShape;

export interface AgentQueryOptionsShape {
  purpose?: 'probe' | 'chat';
  cwd?: string | null;
  queryId?: string;
  conversationId?: string | null;
  turnId?: string;
  emitTrace?: boolean;
  permissionMode?: AgentCliPermissionMode;
  shellSupervision?: AgentShellSupervision;
  model?: string | null;
  modelReasoningEffort?: AgentCliModelReasoningEffort | null;
  modelServiceTier?: string | null;
  modelPersonality?: AgentCliModelPersonality | null;
  toolExposure?: AgentToolExposure;
}

export interface AgentAuthOptionsShape {
  authId?: string;
  binaryPathOverride?: string;
}

export interface AgentAuthEventShape {
  authId: string;
  transport: AgentTransport;
  stream: AgentAuthStream;
  text: string;
  receivedAt: string;
}

export interface AgentAuthEnvelopeShape {
  authId: string;
  event: AgentAuthEventShape;
}

export type AgentAuthFailureKindShape =
  | 'not_installed'
  | 'spawn_error'
  | 'exit_nonzero'
  | 'auth_not_detected'
  | 'timed_out'
  | 'invalid_transport'
  | 'handler_error';

export interface AgentAuthProviderResultShape {
  authId: string;
  transport: AgentTransport;
  ok: boolean;
  status: AgentAuthFlowStatus;
  command: string[];
  output: string;
  error?: string;
  durationMs: number;
  detection?: AgentSdkDetectionShape;
  failureKind?: AgentAuthFailureKindShape;
  spawnErrorCode?: string;
}

export interface AgentAuthBoundaryFailureShape {
  authId: '';
  transport: string;
  ok: false;
  status: 'failed';
  command: string[];
  output: '';
  error: string;
  durationMs: 0;
  failureKind: 'invalid_transport';
}

export type AgentAuthResultShape = AgentAuthProviderResultShape | AgentAuthBoundaryFailureShape;

export interface AgentTraceDisplayShape {
  kind:
    | 'assistant_text'
    | 'command'
    | 'error'
    | 'file_change'
    | 'lifecycle'
    | 'notification'
    | 'permission_denial'
    | 'reasoning'
    | 'result'
    | 'todo'
    | 'tool'
    | 'unknown'
    | 'web_search';
  title: string;
  status?: string;
  text?: string;
  visibility?: 'chat' | 'diagnostic';
  toolNames?: readonly string[];
}

export interface AgentTraceToolCallShape {
  id: string;
  name: string;
  mcpServer?: string;
  status: 'requested' | 'running' | 'completed' | 'failed';
  input?: unknown;
  output?: unknown;
}

export interface AgentTraceEventShape {
  transport: AgentTransport;
  sequence: number;
  receivedAt: string;
  providerEventType: string;
  providerItemType?: string;
  providerItemId?: string;
  raw: unknown;
  display: AgentTraceDisplayShape;
  toolCalls?: AgentTraceToolCallShape[];
  versions: { sdkVersion: string | null; cliVersion: string | null };
  terminal?: 'completed' | 'failed';
}

export interface AgentTraceEnvelopeShape {
  queryId: string;
  event: AgentTraceEventShape;
}

export interface AgentAlwaysAllowRuleShape {
  catalogMessage?: import('@waypoint/user-messages').UserMessagePayload;
  key: string;
  label: string;
  enabled: boolean;
  createdAt: number;
}

export interface AgentSessionStartRequestShape {
  sessionId?: string;
  conversationId?: string | null;
  turnId?: string | null;
  provider: AgentTransport;
  binaryPathOverride?: string;
  authorityProfileId: string;
  prompt: string;
  continuationPrompt?: string;
  cwd: string | null;
  reachRoots?: import('./agent-chat-files').AgentReachRoot[];
  workspaceGrounding: 'required' | 'not-required';
  toolExposure?: AgentToolExposure;
  shellSupervision?: AgentShellSupervision;
  permissions?: import('./agent-permissions').AgentPermissions;
  additionalAgentInstructions?: string;
  model?: string | null;
  modelReasoningEffort?: AgentCliModelReasoningEffort | null;
  modelServiceTier?: string | null;
  modelPersonality?: AgentCliModelPersonality | null;
  capabilitySelection?: AgentCapabilitySelection;
  attachments?: import('./agent-attachments').AgentAttachmentManifest[];
}

export interface AgentSessionRunResultShape {
  sessionId: string;
  provider: AgentTransport;
  authorityProfileId: string;
  ok: boolean;
  text: string;
  error?: string;
  durationMs: number;
  lastTraceSequence?: number;
  stopState?: AgentQueryStopState;
  providerConversationId?: string;
  workspaceProvenance: {
    policy: 'required' | 'not-required';
    grounded: boolean;
    completedWorkspaceTools: string[];
    completedWorkspaceResources: string[];
  };
  structuredOutput?: import('./agent-structured-output').AgentStructuredOutputReceipt;
}

export interface AgentSessionEventEnvelopeShape {
  sessionId: string;
  provider: AgentTransport;
  type: 'trace';
  event: AgentTraceEventShape;
}

export interface AgentSessionRecordShape {
  id: string;
  conversationId: string | null;
  turnId: string | null;
  provider: AgentTransport;
  authorityProfileId: string;
  authorityClass: string;
  releaseMode: string;
  permissionModeLabel: string | null;
  status: string;
  cwd: string;
  outputRoot: string | null;
  providerConversationId: string | null;
  providerVersionsJson: string;
  authorityJson: string;
  terminalReason: string | null;
  telemetryHadWorkspaceContext: boolean;
  telemetryContinuation: boolean;
  startedAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface AgentScheduleRecordShape {
  id: string;
  nativeId: string;
  kind: 'cron' | 'wakeup';
  provider: 'claude-agent-sdk';
  sessionId: string;
  conversationId: string | null;
  providerConversationId: string | null;
  cwd: string;
  prompt: string;
  cron: string | null;
  humanSchedule: string;
  recurring: boolean;
  durable: boolean;
  scheduledFor: number | null;
  status: 'active' | 'cancelling' | 'cancelled';
  createdAt: number;
  updatedAt: number;
}

export interface AgentScheduleCancelResultShape {
  ok: boolean;
  schedule: AgentScheduleRecordShape | null;
  error?: string;
}

export interface AgentProviderProbeShape {
  transport: AgentTransport;
  cliInstalled: boolean;
  authenticated: boolean;
  sdkVersion: string | null;
  cliVersion: string | null;
  toolAccess: AgentProbeToolAccess;
  permission: {
    mode: AgentProbePermissionMode;
    promptSurface: AgentProbeSupport;
    nonInteractiveDenial: AgentProbeSupport;
  };
  releaseMode: AgentProbeReleaseMode;
  stop: {
    modelStream: AgentProbeSupport;
    providerTool: AgentProbeSupport;
    childProcessReaping: AgentProbeSupport;
    mechanisms: string[];
    userVisibleStopState: AgentProbeStopState;
  };
  warnings: string[];
}

export interface AgentMcpServerLaunchShape {
  serverName: 'dnaforge';
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface AgentCancelQueryResultShape {
  ok: boolean;
  cancelled: boolean;
  error?: string;
}

export interface AgentSessionCancelResultShape {
  ok: boolean;
  cancelled: boolean;
  state: 'stop_requested' | 'not_found';
  error?: string;
}

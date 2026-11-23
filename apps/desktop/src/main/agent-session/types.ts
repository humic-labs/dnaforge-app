import type { AgentSdkDetection } from '../agent-sdk/detect';
import type { ProviderProbeVersions } from '../agent-sdk/probe';
import type {
  AgentShellSupervision,
  AgentToolExposure,
  AgentTraceEventShape,
} from '../../shared/agent-runtime-ipc';
import type { AgentCapabilitySelection } from '../../shared/agent-capability-controls';

export type AgentProvider = 'codex-sdk' | 'claude-agent-sdk' | 'grok-acp';
export type AgentModelReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'ultra';
export type AgentModelPersonality = string;

export type ProviderAuthState = 'missing' | 'unauthenticated' | 'authenticated' | 'unknown';

export type CapabilitySupport = 'supported' | 'unsupported' | 'unknown';

export type CapabilityEvidence = 'declared' | 'static_probe' | 'live_probe' | 'unverified';

export interface SupportCapability {
  status: CapabilitySupport;
  evidence: CapabilityEvidence;
  notes: string[];
}

export interface BooleanCapability {
  supported: boolean;
  evidence: CapabilityEvidence;
  notes: string[];
}

export interface ProviderDetection {
  provider: AgentProvider;
  cliInstalled: boolean;
  auth: ProviderAuthState;
  binaryPath: string | null;
  raw: AgentSdkDetection;
}

export interface ProviderVersionStamp {
  sdkVersion: string | null;
  cliVersion: string | null;
  binaryPath: string | null;
}

export interface ProviderCapabilityReport {
  provider: AgentProvider;
  auth: ProviderAuthState;
  versions: ProviderVersionStamp;
  activity: {
    publicReasoningSummary: SupportCapability;
    commandEvents: SupportCapability;
    fileEvents: SupportCapability;
    permissionEvents: SupportCapability;
    unknownEventFallback: 'required';
  };
  cancellation: {
    modelStop: SupportCapability;
    activeToolStop: 'supported' | 'stop_requested_only' | 'unknown';
    childReaping: SupportCapability;
  };
  workspace: {
    cwd: BooleanCapability;
    additionalRoots: BooleanCapability;
    providerSandboxModes: string[];
  };
  mcp: {
    stdioServer: BooleanCapability;
    toolAllowlist: BooleanCapability;
    perTurnCorrelation: BooleanCapability;
  };
}

export type AuthorityClass =
  | 'app-supervised'
  | 'native-read-only'
  | 'native-workspace-write'
  | 'native-user-mediated'
  | 'disabled';

export type ProviderReleaseMode = 'dev_only' | 'native_write_beta' | 'read_only' | 'production';

export type ProviderControlCode =
  | 'approval.policy'
  | 'mcp.scope'
  | 'mcp.tool_allowlist'
  | 'network.access'
  | 'permission.mode'
  | 'release.gate'
  | 'sandbox.mode'
  | 'settings.sources'
  | 'tool.deny_non_dnaforge'
  | 'web_search.mode'
  | 'workspace.cwd';

export interface ProviderControl {
  code: ProviderControlCode;
  value: string | boolean | number | null;
  evidence: CapabilityEvidence;
  description: string;
}

export type ProviderClaimCode =
  | 'app_tools_only'
  | 'cwd_supported'
  | 'dnaforge_mcp_available'
  | 'local_cli_auth'
  | 'native_read_only'
  | 'native_workspace_write'
  | 'provider_permission_events'
  | 'reasoning_summary_available'
  | 'stop_model_stream_supported';

export interface ProviderClaim {
  code: ProviderClaimCode;
  description: string;
}

export type ProviderUnsupportedClaimCode =
  | 'app_controls_native_cli_permissions'
  | 'codex_permission_prompt_surface'
  | 'claude_native_write_parity'
  | 'native_shell_in_app_supervised'
  | 'private_chain_of_thought'
  | 'production_safe_child_reaping';

export interface ProviderUnsupportedClaim {
  code: ProviderUnsupportedClaimCode;
  description: string;
}

export type ProviderBlockerCode =
  | 'child_reaping_unproven'
  | 'cli_missing'
  | 'cli_unauthenticated'
  | 'native_write_unresolved'
  | 'permission_surface_unproven'
  | 'runtime_phase_required';

export interface ProviderBlocker {
  code: ProviderBlockerCode;
  description: string;
  blocksStart: boolean;
}

export interface ProviderAuthorityProfile {
  id: string;
  provider: AgentProvider;
  label: string;
  authorityClass: AuthorityClass;
  releaseMode: ProviderReleaseMode;
  effectiveControls: ProviderControl[];
  userVisibleClaims: ProviderClaim[];
  unsupportedClaims: ProviderUnsupportedClaim[];
  blockers: ProviderBlocker[];
}

export interface ProviderAuthorityProfileInput {
  provider: AgentProvider;
  authorityProfileId?: string;
  permissionMode?: 'app-supervised' | 'native-cli';
}

export type RuntimeReleaseChannel = 'development' | 'production' | 'packaged';

export interface AuthorityStartPolicyInput {
  profile: ProviderAuthorityProfile;
  releaseChannel: RuntimeReleaseChannel;
  allowNativeWriteBeta?: boolean;
}

export interface AuthorityStartPolicyResult {
  ok: boolean;
  reason: string | null;
}

export interface ProviderTerminalInput {
  abortRequested: boolean;
  providerStopState?: 'completed' | 'failed' | 'cancelled' | 'stop_requested';
  activeToolRunning?: boolean;
  childReaping: SupportCapability;
}

export type ProviderTerminalState = 'completed' | 'failed' | 'cancelled' | 'stop_requested';

export interface AgentProviderDescriptor {
  readonly provider: AgentProvider;
  detect(): Promise<ProviderDetection>;
  describeCapabilities(): Promise<ProviderCapabilityReport>;
  listAuthorityProfiles(): Promise<ProviderAuthorityProfile[]>;
  validateAuthorityProfile(input: ProviderAuthorityProfileInput): ProviderAuthorityProfile;
  classifyTerminalState(input: ProviderTerminalInput): ProviderTerminalState;
}

export interface ProviderSessionSpec extends ProviderSessionStartSpec {
  sessionId: string;
  prompt: string;
}

export interface ProviderSessionEvent {
  provider: AgentProvider;
  sessionId: string;
  sequence: number;
  type: 'status' | 'trace' | 'terminal';
  payload: unknown;
  terminal?: ProviderTerminalState;
}

export interface ProviderStopRequestResult {
  ok: boolean;
  state: 'stop_requested' | 'not_found';
  reason?: string;
}

export interface AgentRuntimeProvider extends AgentProviderDescriptor {
  startSession(spec: ProviderSessionSpec): AsyncIterable<ProviderSessionEvent>;
  requestStop(sessionId: string): Promise<ProviderStopRequestResult>;
}

export interface ProviderDescriptorDependencies {
  detectAgentSdk: () => Promise<AgentSdkDetection>;
  getProviderProbeVersions: (detection: AgentSdkDetection) => Promise<ProviderProbeVersions>;
}

export interface ProviderSessionStartSpec {
  provider: AgentProvider;
  authorityProfileId: string;
  cwd: string;
  releaseChannel: RuntimeReleaseChannel;
}

export type AgentSessionActiveStatus = 'starting' | 'running' | 'stopping';

export type AgentSessionTerminalStatus =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'stop_unconfirmed'
  | 'interrupted';

export type AgentSessionStatus = AgentSessionActiveStatus | AgentSessionTerminalStatus;

export type WorkspaceGroundingPolicy = 'required' | 'not-required';

export interface AgentSessionWorkspaceProvenance {
  policy: WorkspaceGroundingPolicy;
  grounded: boolean;
  completedWorkspaceTools: string[];
  completedWorkspaceResources: string[];
}

export interface AgentSessionStartRequest {
  sessionId?: string;
  conversationId?: string | null;
  turnId?: string | null;
  provider: AgentProvider;
  binaryPathOverride?: string;
  authorityProfileId: string;
  prompt: string;
  continuationPrompt?: string;
  cwd: string | null;
  reachRoots?: import('../../shared/agent-chat-files').AgentReachRoot[];
  workspaceGrounding: WorkspaceGroundingPolicy;
  toolExposure?: AgentToolExposure;
  shellSupervision?: AgentShellSupervision;
  permissions?: import('../../shared/agent-permissions').AgentPermissions;
  additionalAgentInstructions?: string;
  model?: string | null;
  modelReasoningEffort?: AgentModelReasoningEffort | null;
  modelServiceTier?: string | null;
  modelPersonality?: AgentModelPersonality | null;
  capabilitySelection?: AgentCapabilitySelection;
  attachments?: import('../../shared/agent-attachments').AgentAttachmentManifest[];
}

export interface AgentSessionRunResult {
  failure?: import('../../shared/native-turn-failure').NativeTurnFailure;
  sessionId: string;
  provider: AgentProvider;
  authorityProfileId: string;
  ok: boolean;
  text: string;
  error?: string;
  durationMs: number;
  lastTraceSequence?: number;
  stopState?: ProviderTerminalState;
  providerConversationId?: string;
  workspaceProvenance: AgentSessionWorkspaceProvenance;
  structuredOutput?: import('../../shared/agent-structured-output').AgentStructuredOutputReceipt;
}

export interface AgentSessionRecord {
  id: string;
  conversationId: string | null;
  turnId: string | null;
  provider: AgentProvider;
  authorityProfileId: string;
  authorityClass: AuthorityClass;
  releaseMode: ProviderReleaseMode;
  permissionModeLabel: string | null;
  status: AgentSessionStatus;
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

export interface AgentSessionTraceEnvelope {
  sessionId: string;
  provider: AgentProvider;
  type: 'trace';
  event: AgentTraceEventShape;
}

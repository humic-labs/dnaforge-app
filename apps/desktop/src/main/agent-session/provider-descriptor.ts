import { detectAgentSdk } from '../agent-sdk/detect';
import { getProviderProbeVersions } from '../agent-sdk/probe';
import {
  findAuthorityProfile,
  getProviderAuthorityProfiles,
  validateConcreteAuthorityProfileInput,
} from './authority-profile-policy';
import type {
  AgentProvider,
  AgentProviderDescriptor,
  CapabilityEvidence,
  CapabilitySupport,
  ProviderCapabilityReport,
  ProviderAuthorityProfileInput,
  ProviderDescriptorDependencies,
  ProviderDetection,
  ProviderTerminalInput,
  ProviderTerminalState,
  ProviderVersionStamp,
  SupportCapability,
  BooleanCapability,
} from './types';

const defaultDependencies: ProviderDescriptorDependencies = {
  detectAgentSdk,
  getProviderProbeVersions,
};

function support(
  status: CapabilitySupport,
  evidence: CapabilityEvidence,
  notes: string[] = []
): SupportCapability {
  return { status, evidence, notes };
}

function bool(
  supported: boolean,
  evidence: CapabilityEvidence,
  notes: string[] = []
): BooleanCapability {
  return { supported, evidence, notes };
}

function authFromProvider(
  provider: AgentProvider,
  detection: Awaited<ReturnType<typeof detectAgentSdk>>
): ProviderDetection {
  if (provider === 'codex-sdk') {
    return {
      provider,
      cliInstalled: detection.codex.cli === 'installed',
      auth: detection.codex.cli === 'missing' ? 'missing' : detection.codex.auth,
      binaryPath: detection.codex.path,
      raw: detection,
    };
  }
  if (provider === 'grok-acp') {
    return {
      provider,
      cliInstalled: detection.grok.cli === 'installed',
      auth: detection.grok.cli === 'missing' ? 'missing' : detection.grok.auth,
      binaryPath: detection.grok.path,
      raw: detection,
    };
  }

  return {
    provider,
    cliInstalled: detection.claudeCode.cli === 'installed',
    auth: detection.claudeCode.cli === 'missing' ? 'missing' : detection.claudeCode.auth,
    binaryPath: detection.claudeCode.path,
    raw: detection,
  };
}

function versionStamp(
  provider: AgentProvider,
  detection: Awaited<ReturnType<typeof detectAgentSdk>>,
  versions: Awaited<ReturnType<typeof getProviderProbeVersions>>
): ProviderVersionStamp {
  if (provider === 'codex-sdk') {
    return {
      sdkVersion: versions.codexSdkVersion,
      cliVersion: versions.codexCliVersion ?? null,
      binaryPath: detection.codex.path,
    };
  }
  if (provider === 'grok-acp') {
    return {
      sdkVersion: versions.grokAcpSdkVersion,
      cliVersion: versions.grokCliVersion ?? null,
      binaryPath: detection.grok.path,
    };
  }
  return {
    sdkVersion: versions.claudeSdkVersion,
    cliVersion: versions.claudeCliVersion ?? null,
    binaryPath: detection.claudeCode.path,
  };
}

function classifyStop(input: ProviderTerminalInput): ProviderTerminalState {
  if (input.providerStopState === 'failed') return 'failed';
  if (input.providerStopState === 'completed' && !input.abortRequested) return 'completed';
  if (input.providerStopState === 'cancelled' && !input.activeToolRunning) return 'cancelled';
  if (!input.abortRequested) return input.providerStopState ?? 'completed';
  if (input.activeToolRunning) return 'stop_requested';
  if (input.childReaping.status === 'supported') return 'cancelled';
  return 'stop_requested';
}

abstract class BaseProviderDescriptor implements AgentProviderDescriptor {
  constructor(
    public readonly provider: AgentProvider,
    protected readonly deps: ProviderDescriptorDependencies = defaultDependencies
  ) {}

  async detect(): Promise<ProviderDetection> {
    return authFromProvider(this.provider, await this.deps.detectAgentSdk());
  }

  abstract describeCapabilities(): Promise<ProviderCapabilityReport>;

  listAuthorityProfiles() {
    return Promise.resolve(getProviderAuthorityProfiles(this.provider));
  }

  validateAuthorityProfile(input: ProviderAuthorityProfileInput) {
    if (input.provider !== this.provider) {
      throw new Error(
        `Authority profile provider ${input.provider} does not match ${this.provider}.`
      );
    }
    return validateConcreteAuthorityProfileInput(input);
  }

  classifyTerminalState(input: ProviderTerminalInput): ProviderTerminalState {
    return classifyStop(input);
  }

  protected async baseCapabilityReport(): Promise<
    Pick<ProviderCapabilityReport, 'provider' | 'auth' | 'versions'>
  > {
    const detection = await this.deps.detectAgentSdk();
    const versions = await this.deps.getProviderProbeVersions(detection);
    const providerDetection = authFromProvider(this.provider, detection);
    return {
      provider: this.provider,
      auth: providerDetection.auth,
      versions: versionStamp(this.provider, detection, versions),
    };
  }
}

export class CodexProviderDescriptor extends BaseProviderDescriptor {
  constructor(deps: ProviderDescriptorDependencies = defaultDependencies) {
    super('codex-sdk', deps);
  }

  async describeCapabilities(): Promise<ProviderCapabilityReport> {
    const base = await this.baseCapabilityReport();
    return {
      ...base,
      activity: {
        publicReasoningSummary: support('supported', 'static_probe', [
          'Codex emits provider-native activity suitable for public summaries.',
        ]),
        commandEvents: support('supported', 'static_probe'),
        fileEvents: support('supported', 'static_probe'),
        permissionEvents: support('unknown', 'unverified', [
          'Permission prompt/denial surfacing is not proven in DNAForge.',
        ]),
        unknownEventFallback: 'required',
      },
      cancellation: {
        modelStop: support('supported', 'static_probe', ['AbortSignal stops the model stream.']),
        activeToolStop: 'stop_requested_only',
        childReaping: support('unsupported', 'static_probe', [
          'Live probes found child process reaping unproven/unsupported.',
        ]),
      },
      workspace: {
        cwd: bool(true, 'declared'),
        additionalRoots: bool(false, 'declared'),
        providerSandboxModes: ['read-only', 'workspace-write'],
      },
      mcp: {
        stdioServer: bool(true, 'declared'),
        toolAllowlist: bool(true, 'declared', [
          'The DNAForge companion limits the exposed MCP surface.',
        ]),
        perTurnCorrelation: bool(true, 'declared'),
      },
    };
  }
}

export class ClaudeProviderDescriptor extends BaseProviderDescriptor {
  constructor(deps: ProviderDescriptorDependencies = defaultDependencies) {
    super('claude-agent-sdk', deps);
  }

  async describeCapabilities(): Promise<ProviderCapabilityReport> {
    const base = await this.baseCapabilityReport();
    return {
      ...base,
      activity: {
        publicReasoningSummary: support('supported', 'static_probe', [
          'Claude thinking/tool messages can produce provider-approved public summaries.',
        ]),
        commandEvents: support('unknown', 'unverified', [
          'Command-style events are provider-message dependent.',
        ]),
        fileEvents: support('unknown', 'unverified', [
          'File event fidelity depends on the selected Claude tool posture.',
        ]),
        permissionEvents: support('supported', 'static_probe'),
        unknownEventFallback: 'required',
      },
      cancellation: {
        modelStop: support('supported', 'static_probe', [
          'Options.abortController stops the stream.',
        ]),
        activeToolStop: 'stop_requested_only',
        childReaping: support('unsupported', 'static_probe', [
          'Live probes found child process reaping unproven/unsupported.',
        ]),
      },
      workspace: {
        cwd: bool(true, 'declared'),
        additionalRoots: bool(false, 'unverified'),
        providerSandboxModes: ['default', 'dontAsk'],
      },
      mcp: {
        stdioServer: bool(true, 'declared'),
        toolAllowlist: bool(true, 'declared', [
          'Claude app-supervised mode uses allowedTools and canUseTool.',
        ]),
        perTurnCorrelation: bool(true, 'declared'),
      },
    };
  }
}

export class GrokProviderDescriptor extends BaseProviderDescriptor {
  constructor(deps: ProviderDescriptorDependencies = defaultDependencies) {
    super('grok-acp', deps);
  }

  async describeCapabilities(): Promise<ProviderCapabilityReport> {
    const base = await this.baseCapabilityReport();
    return {
      ...base,
      activity: {
        publicReasoningSummary: support('supported', 'declared'),
        commandEvents: support('supported', 'declared'),
        fileEvents: support('supported', 'declared'),
        permissionEvents: support('supported', 'declared', [
          'ACP permission and elicitation requests use the shared inline host.',
        ]),
        unknownEventFallback: 'required',
      },
      cancellation: {
        modelStop: support('supported', 'declared', ['ACP session/cancel is sent on Stop.']),
        activeToolStop: 'supported',
        childReaping: support('unknown', 'unverified', [
          'ACP cancellation is implemented; transitive child reaping needs live proof.',
        ]),
      },
      workspace: {
        cwd: bool(true, 'declared'),
        additionalRoots: bool(false, 'declared', [
          'The ACP session receives one selected workspace cwd and no additional roots.',
        ]),
        providerSandboxModes: ['dontAsk', 'default'],
      },
      mcp: {
        stdioServer: bool(true, 'declared'),
        toolAllowlist: bool(true, 'declared', [
          'The app supplies only the DNAForge MCP server in session/new and session/load.',
        ]),
        perTurnCorrelation: bool(true, 'declared'),
      },
    };
  }
}

export function createCodexProviderDescriptor(deps?: ProviderDescriptorDependencies) {
  return new CodexProviderDescriptor(deps);
}

export function createClaudeProviderDescriptor(deps?: ProviderDescriptorDependencies) {
  return new ClaudeProviderDescriptor(deps);
}

export function createGrokProviderDescriptor(deps?: ProviderDescriptorDependencies) {
  return new GrokProviderDescriptor(deps);
}

export function createProviderDescriptors(deps?: ProviderDescriptorDependencies) {
  return [
    createCodexProviderDescriptor(deps),
    createClaudeProviderDescriptor(deps),
    createGrokProviderDescriptor(deps),
  ] as const;
}

export function getDescriptorAuthorityProfile(
  descriptor: AgentProviderDescriptor,
  authorityProfileId: string
) {
  return findAuthorityProfile({ provider: descriptor.provider, authorityProfileId });
}

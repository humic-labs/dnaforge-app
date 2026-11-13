import { validateAuthorityProfileShape } from './authority-profile-policy';
import type {
  AgentProviderDescriptor,
  BooleanCapability,
  ProviderAuthorityProfile,
  ProviderCapabilityReport,
  SupportCapability,
} from './types';

export interface ProviderDescriptorContractSnapshot {
  provider: string;
  capabilities: ProviderCapabilityReport;
  profiles: ProviderAuthorityProfile[];
}

function checkSupportCapability(
  failures: string[],
  path: string,
  capability: SupportCapability
): void {
  if (!['supported', 'unsupported', 'unknown'].includes(capability.status)) {
    failures.push(`${path} has invalid status ${String(capability.status)}.`);
  }
  if (!['declared', 'static_probe', 'live_probe', 'unverified'].includes(capability.evidence)) {
    failures.push(`${path} has invalid evidence ${String(capability.evidence)}.`);
  }
  if (!Array.isArray(capability.notes)) {
    failures.push(`${path} notes must be an array.`);
  }
}

function checkBooleanCapability(
  failures: string[],
  path: string,
  capability: BooleanCapability
): void {
  if (typeof capability.supported !== 'boolean') {
    failures.push(`${path} must be boolean-supported.`);
  }
  if (!['declared', 'static_probe', 'live_probe', 'unverified'].includes(capability.evidence)) {
    failures.push(`${path} has invalid evidence ${String(capability.evidence)}.`);
  }
  if (!Array.isArray(capability.notes)) {
    failures.push(`${path} notes must be an array.`);
  }
}

export async function collectProviderDescriptorContract(
  descriptor: AgentProviderDescriptor
): Promise<ProviderDescriptorContractSnapshot> {
  const [capabilities, profiles] = await Promise.all([
    descriptor.describeCapabilities(),
    descriptor.listAuthorityProfiles(),
  ]);
  return {
    provider: descriptor.provider,
    capabilities,
    profiles,
  };
}

export function getProviderDescriptorContractFailures(
  snapshot: ProviderDescriptorContractSnapshot
): string[] {
  const failures: string[] = [];
  if (snapshot.capabilities.provider !== snapshot.provider) {
    failures.push(
      `Capability provider ${snapshot.capabilities.provider} does not match ${snapshot.provider}.`
    );
  }
  if (snapshot.capabilities.auth !== 'missing' && !snapshot.capabilities.versions.binaryPath) {
    failures.push(`${snapshot.provider} capability report must include binaryPath when installed.`);
  }
  if (snapshot.capabilities.activity.unknownEventFallback !== 'required') {
    failures.push(`${snapshot.provider} must require unknown-event fallback.`);
  }
  checkSupportCapability(
    failures,
    `${snapshot.provider}.activity.publicReasoningSummary`,
    snapshot.capabilities.activity.publicReasoningSummary
  );
  checkSupportCapability(
    failures,
    `${snapshot.provider}.activity.commandEvents`,
    snapshot.capabilities.activity.commandEvents
  );
  checkSupportCapability(
    failures,
    `${snapshot.provider}.activity.fileEvents`,
    snapshot.capabilities.activity.fileEvents
  );
  checkSupportCapability(
    failures,
    `${snapshot.provider}.activity.permissionEvents`,
    snapshot.capabilities.activity.permissionEvents
  );
  checkSupportCapability(
    failures,
    `${snapshot.provider}.cancellation.modelStop`,
    snapshot.capabilities.cancellation.modelStop
  );
  checkSupportCapability(
    failures,
    `${snapshot.provider}.cancellation.childReaping`,
    snapshot.capabilities.cancellation.childReaping
  );
  checkBooleanCapability(
    failures,
    `${snapshot.provider}.workspace.cwd`,
    snapshot.capabilities.workspace.cwd
  );
  checkBooleanCapability(
    failures,
    `${snapshot.provider}.workspace.additionalRoots`,
    snapshot.capabilities.workspace.additionalRoots
  );
  checkBooleanCapability(
    failures,
    `${snapshot.provider}.mcp.stdioServer`,
    snapshot.capabilities.mcp.stdioServer
  );
  checkBooleanCapability(
    failures,
    `${snapshot.provider}.mcp.toolAllowlist`,
    snapshot.capabilities.mcp.toolAllowlist
  );
  checkBooleanCapability(
    failures,
    `${snapshot.provider}.mcp.perTurnCorrelation`,
    snapshot.capabilities.mcp.perTurnCorrelation
  );

  if (snapshot.profiles.length === 0) {
    failures.push(`${snapshot.provider} must expose at least one authority profile.`);
  }
  for (const profile of snapshot.profiles) {
    if (profile.provider !== snapshot.provider) {
      failures.push(`Profile ${profile.id} provider mismatch: ${profile.provider}.`);
    }
    failures.push(...validateAuthorityProfileShape(profile));
  }
  return failures;
}

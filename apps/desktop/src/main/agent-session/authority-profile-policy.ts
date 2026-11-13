import {
  CLAUDE_APP_SUPERVISED_PROFILE_ID,
  CLAUDE_AUTHORITY_PROFILES,
  CLAUDE_NATIVE_WORKSPACE_WRITE_PROFILE_ID,
  CODEX_APP_SUPERVISED_PROFILE_ID,
  CODEX_AUTHORITY_PROFILES,
  CODEX_NATIVE_WORKSPACE_WRITE_PROFILE_ID,
  GROK_APP_SUPERVISED_PROFILE_ID,
  GROK_AUTHORITY_PROFILES,
  GROK_NATIVE_WORKSPACE_WRITE_PROFILE_ID,
} from './authority-profile';
import type {
  AgentProvider,
  AuthorityStartPolicyInput,
  AuthorityStartPolicyResult,
  ProviderAuthorityProfile,
  ProviderAuthorityProfileInput,
  ProviderBlockerCode,
  ProviderClaimCode,
  ProviderControlCode,
  ProviderSessionStartSpec,
  ProviderUnsupportedClaimCode,
} from './types';

const CONTROL_CODES: ReadonlySet<ProviderControlCode> = new Set([
  'approval.policy',
  'mcp.scope',
  'mcp.tool_allowlist',
  'network.access',
  'permission.mode',
  'release.gate',
  'sandbox.mode',
  'settings.sources',
  'tool.deny_non_dnaforge',
  'web_search.mode',
  'workspace.cwd',
]);

const CLAIM_CODES: ReadonlySet<ProviderClaimCode> = new Set([
  'app_tools_only',
  'cwd_supported',
  'dnaforge_mcp_available',
  'local_cli_auth',
  'native_read_only',
  'native_workspace_write',
  'provider_permission_events',
  'reasoning_summary_available',
  'stop_model_stream_supported',
]);

const UNSUPPORTED_CLAIM_CODES: ReadonlySet<ProviderUnsupportedClaimCode> = new Set([
  'app_controls_native_cli_permissions',
  'codex_permission_prompt_surface',
  'claude_native_write_parity',
  'native_shell_in_app_supervised',
  'private_chain_of_thought',
  'production_safe_child_reaping',
]);

const BLOCKER_CODES: ReadonlySet<ProviderBlockerCode> = new Set([
  'child_reaping_unproven',
  'cli_missing',
  'cli_unauthenticated',
  'native_write_unresolved',
  'permission_surface_unproven',
  'runtime_phase_required',
]);

const START_BLOCKER_CODES: ReadonlySet<ProviderBlockerCode> = new Set([
  'cli_missing',
  'cli_unauthenticated',
  'native_write_unresolved',
  'runtime_phase_required',
]);

export function getProviderAuthorityProfiles(provider: AgentProvider): ProviderAuthorityProfile[] {
  if (provider === 'codex-sdk') return [...CODEX_AUTHORITY_PROFILES];
  if (provider === 'grok-acp') return [...GROK_AUTHORITY_PROFILES];
  return [...CLAUDE_AUTHORITY_PROFILES];
}

export function getAllProviderAuthorityProfiles(): ProviderAuthorityProfile[] {
  return [...CODEX_AUTHORITY_PROFILES, ...CLAUDE_AUTHORITY_PROFILES, ...GROK_AUTHORITY_PROFILES];
}

export function validateAuthorityProfileShape(profile: ProviderAuthorityProfile): string[] {
  const failures: string[] = [];
  if (!profile.id.startsWith(`${profile.provider}:`)) {
    failures.push(`Profile ${profile.id} must be prefixed by provider ${profile.provider}.`);
  }
  if (profile.effectiveControls.length === 0) {
    failures.push(`Profile ${profile.id} must declare effective controls.`);
  }
  if (profile.userVisibleClaims.length === 0) {
    failures.push(`Profile ${profile.id} must declare visible claims.`);
  }
  if (profile.unsupportedClaims.length === 0) {
    failures.push(`Profile ${profile.id} must declare unsupported claims.`);
  }
  for (const control of profile.effectiveControls) {
    if (!CONTROL_CODES.has(control.code)) {
      failures.push(`Profile ${profile.id} has unknown control code ${control.code}.`);
    }
    if (control.description.trim().length === 0) {
      failures.push(`Profile ${profile.id} has an empty control description.`);
    }
  }
  for (const claim of profile.userVisibleClaims) {
    if (!CLAIM_CODES.has(claim.code)) {
      failures.push(`Profile ${profile.id} has unknown visible claim code ${claim.code}.`);
    }
    if (claim.description.trim().length === 0) {
      failures.push(`Profile ${profile.id} has an empty visible claim description.`);
    }
  }
  for (const unsupported of profile.unsupportedClaims) {
    if (!UNSUPPORTED_CLAIM_CODES.has(unsupported.code)) {
      failures.push(
        `Profile ${profile.id} has unknown unsupported claim code ${unsupported.code}.`
      );
    }
    if (unsupported.description.trim().length === 0) {
      failures.push(`Profile ${profile.id} has an empty unsupported claim description.`);
    }
  }
  for (const profileBlocker of profile.blockers) {
    if (!BLOCKER_CODES.has(profileBlocker.code)) {
      failures.push(`Profile ${profile.id} has unknown blocker code ${profileBlocker.code}.`);
    }
    if (profileBlocker.description.trim().length === 0) {
      failures.push(`Profile ${profile.id} has an empty blocker description.`);
    }
  }
  return failures;
}

export function findAuthorityProfile(input: {
  provider: AgentProvider;
  authorityProfileId: string;
}): ProviderAuthorityProfile {
  const profile = getProviderAuthorityProfiles(input.provider).find(
    (candidate) => candidate.id === input.authorityProfileId
  );
  if (!profile) {
    throw new Error(
      `Unknown authority profile ${input.authorityProfileId} for provider ${input.provider}.`
    );
  }
  return profile;
}

export function resolveLegacyAuthorityProfileId(input: {
  provider: AgentProvider;
  permissionMode: 'app-supervised' | 'native-cli';
}): string {
  if (input.provider === 'codex-sdk') {
    return input.permissionMode === 'app-supervised'
      ? CODEX_APP_SUPERVISED_PROFILE_ID
      : CODEX_NATIVE_WORKSPACE_WRITE_PROFILE_ID;
  }
  if (input.provider === 'grok-acp') {
    return input.permissionMode === 'app-supervised'
      ? GROK_APP_SUPERVISED_PROFILE_ID
      : GROK_NATIVE_WORKSPACE_WRITE_PROFILE_ID;
  }
  return input.permissionMode === 'app-supervised'
    ? CLAUDE_APP_SUPERVISED_PROFILE_ID
    : CLAUDE_NATIVE_WORKSPACE_WRITE_PROFILE_ID;
}

export function validateConcreteAuthorityProfileInput(
  input: ProviderAuthorityProfileInput
): ProviderAuthorityProfile {
  if (!input.authorityProfileId) {
    throw new Error(
      'A concrete provider authorityProfileId is required before starting an agent session.'
    );
  }
  return findAuthorityProfile({
    provider: input.provider,
    authorityProfileId: input.authorityProfileId,
  });
}

export function migrateLegacyAuthorityProfileInput(
  input: ProviderAuthorityProfileInput
): ProviderAuthorityProfileInput {
  if (input.authorityProfileId || !input.permissionMode) return input;
  return {
    provider: input.provider,
    authorityProfileId: resolveLegacyAuthorityProfileId({
      provider: input.provider,
      permissionMode: input.permissionMode,
    }),
  };
}

export function canStartAuthorityProfile(
  input: AuthorityStartPolicyInput
): AuthorityStartPolicyResult {
  const blockingStart = input.profile.blockers.find(
    (profileBlocker) => profileBlocker.blocksStart || START_BLOCKER_CODES.has(profileBlocker.code)
  );
  if (input.profile.authorityClass === 'disabled') {
    return { ok: false, reason: `${input.profile.id} is disabled.` };
  }
  if (blockingStart) {
    return { ok: false, reason: blockingStart.description };
  }
  if (input.profile.releaseMode === 'dev_only' && input.releaseChannel !== 'development') {
    return { ok: false, reason: `${input.profile.id} is development-only.` };
  }
  if (
    input.profile.releaseMode === 'native_write_beta' &&
    input.profile.authorityClass === 'native-workspace-write' &&
    input.releaseChannel === 'production' &&
    input.allowNativeWriteBeta !== true
  ) {
    return { ok: false, reason: `${input.profile.id} requires native-write beta enablement.` };
  }
  return { ok: true, reason: null };
}

export function validateProviderSessionStartSpec(
  spec: ProviderSessionStartSpec
): ProviderAuthorityProfile {
  if (spec.cwd.trim().length === 0) {
    throw new Error('A project folder is required before starting an agent session.');
  }
  const profile = validateConcreteAuthorityProfileInput({
    provider: spec.provider,
    authorityProfileId: spec.authorityProfileId,
  });
  const releasePolicy = canStartAuthorityProfile({
    profile,
    releaseChannel: spec.releaseChannel,
  });
  if (!releasePolicy.ok) {
    throw new Error(releasePolicy.reason ?? `Authority profile ${profile.id} cannot start.`);
  }
  return profile;
}

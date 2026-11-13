import type { ProviderAuthorityProfile, ProviderBlockerCode } from './types';
export {
  CLAUDE_APP_SUPERVISED_PROFILE_ID,
  CLAUDE_NATIVE_READ_ONLY_PROFILE_ID,
  CLAUDE_NATIVE_WORKSPACE_WRITE_PROFILE_ID,
  CLAUDE_NATIVE_WORKSPACE_WRITE_BLOCKED_PROFILE_ID,
  CODEX_APP_SUPERVISED_PROFILE_ID,
  CODEX_NATIVE_READ_ONLY_PROFILE_ID,
  CODEX_NATIVE_WORKSPACE_WRITE_PROFILE_ID,
  GROK_APP_SUPERVISED_PROFILE_ID,
  GROK_NATIVE_WORKSPACE_WRITE_PROFILE_ID,
} from '../../shared/agent-authority';
import {
  CLAUDE_APP_SUPERVISED_PROFILE_ID,
  CLAUDE_NATIVE_READ_ONLY_PROFILE_ID,
  CLAUDE_NATIVE_WORKSPACE_WRITE_PROFILE_ID,
  CLAUDE_NATIVE_WORKSPACE_WRITE_BLOCKED_PROFILE_ID,
  CODEX_APP_SUPERVISED_PROFILE_ID,
  CODEX_NATIVE_READ_ONLY_PROFILE_ID,
  CODEX_NATIVE_WORKSPACE_WRITE_PROFILE_ID,
  GROK_APP_SUPERVISED_PROFILE_ID,
  GROK_NATIVE_WORKSPACE_WRITE_PROFILE_ID,
} from '../../shared/agent-authority';

function blocker(code: ProviderBlockerCode, description: string, blocksStart = false) {
  return { code, description, blocksStart };
}

export const CODEX_AUTHORITY_PROFILES: readonly ProviderAuthorityProfile[] = [
  {
    id: CODEX_APP_SUPERVISED_PROFILE_ID,
    provider: 'codex-sdk',
    label: 'Codex app-supervised',
    authorityClass: 'app-supervised',
    releaseMode: 'read_only',
    effectiveControls: [
      {
        code: 'sandbox.mode',
        value: 'read-only',
        evidence: 'declared',
        description: 'Codex runs with the provider read-only sandbox.',
      },
      {
        code: 'approval.policy',
        value: 'never',
        evidence: 'declared',
        description: 'Provider-native approvals are disabled in app-supervised mode.',
      },
      {
        code: 'network.access',
        value: false,
        evidence: 'declared',
        description: 'Network access is disabled for the provider sandbox.',
      },
      {
        code: 'web_search.mode',
        value: 'disabled',
        evidence: 'declared',
        description: 'Provider web search is disabled.',
      },
      {
        code: 'mcp.scope',
        value: 'dnaforge-only',
        evidence: 'declared',
        description: 'Only the DNAForge MCP companion is attached.',
      },
    ],
    userVisibleClaims: [
      { code: 'local_cli_auth', description: 'Uses the local Codex CLI login.' },
      { code: 'app_tools_only', description: 'Can use DNAForge app tools only.' },
      {
        code: 'cwd_supported',
        description: "Runs from the chat's own folder; your projects are reachable from it.",
      },
      { code: 'dnaforge_mcp_available', description: 'DNAForge MCP tools can be attached.' },
    ],
    unsupportedClaims: [
      {
        code: 'native_shell_in_app_supervised',
        description: 'App-supervised mode does not expose arbitrary native shell authority.',
      },
      {
        code: 'private_chain_of_thought',
        description: 'Hidden private reasoning is not surfaced or persisted.',
      },
      {
        code: 'production_safe_child_reaping',
        description: 'Child process reaping is not proven for native provider tools.',
      },
    ],
    blockers: [blocker('child_reaping_unproven', 'Stop may only report stop_requested.')],
  },
  {
    id: CODEX_NATIVE_READ_ONLY_PROFILE_ID,
    provider: 'codex-sdk',
    label: 'Codex native read-only',
    authorityClass: 'native-read-only',
    releaseMode: 'read_only',
    effectiveControls: [
      {
        code: 'sandbox.mode',
        value: 'read-only',
        evidence: 'declared',
        description: 'Codex native mode is constrained to read-only filesystem access.',
      },
      {
        code: 'approval.policy',
        value: 'never',
        evidence: 'declared',
        description: 'Provider-native approval prompts are not surfaced in DNAForge.',
      },
      {
        code: 'workspace.cwd',
        value: 'required',
        evidence: 'declared',
        description: 'A working folder is required before start.',
      },
    ],
    userVisibleClaims: [
      { code: 'local_cli_auth', description: 'Uses the local Codex CLI login.' },
      { code: 'native_read_only', description: 'Provider can inspect files without writing.' },
      {
        code: 'cwd_supported',
        description: "Runs from the chat's own folder; your projects are reachable from it.",
      },
    ],
    unsupportedClaims: [
      {
        code: 'app_controls_native_cli_permissions',
        description: 'DNAForge grants do not govern provider-native CLI permissions.',
      },
      {
        code: 'production_safe_child_reaping',
        description: 'Child process reaping is not proven for native provider tools.',
      },
      {
        code: 'private_chain_of_thought',
        description: 'Hidden private reasoning is not surfaced or persisted.',
      },
    ],
    blockers: [
      blocker('child_reaping_unproven', 'Stop may only report stop_requested.'),
      blocker('permission_surface_unproven', 'Codex permission prompt surfacing is not proven.'),
    ],
  },
  {
    id: CODEX_NATIVE_WORKSPACE_WRITE_PROFILE_ID,
    provider: 'codex-sdk',
    label: 'Codex native project write',
    authorityClass: 'native-workspace-write',
    releaseMode: 'production',
    effectiveControls: [
      {
        code: 'sandbox.mode',
        value: 'per-chat',
        evidence: 'declared',
        description:
          "Follows the chat's permission mode; the session record states the sandbox that applied.",
      },
      {
        code: 'approval.policy',
        value: 'per-chat',
        evidence: 'declared',
        description:
          "Follows the chat's permission mode; the session record states the policy that applied.",
      },
      {
        code: 'workspace.cwd',
        value: 'required',
        evidence: 'declared',
        description: 'A working folder is required before start.',
      },
      {
        code: 'release.gate',
        value: 'production',
        evidence: 'declared',
        description:
          'Standard CLI mode is allowed; provider-native authority remains provider-owned.',
      },
    ],
    userVisibleClaims: [
      { code: 'local_cli_auth', description: 'Uses the local Codex CLI login.' },
      {
        code: 'native_workspace_write',
        description: "Writes as the chat's permission mode allows.",
      },
      {
        code: 'cwd_supported',
        description: "Runs from the chat's own folder; your projects are reachable from it.",
      },
    ],
    unsupportedClaims: [
      {
        code: 'codex_permission_prompt_surface',
        description: 'Codex permission prompt/denial events are not proven in DNAForge.',
      },
      {
        code: 'production_safe_child_reaping',
        description: 'Child process reaping is not proven for native provider tools.',
      },
      {
        code: 'private_chain_of_thought',
        description: 'Hidden private reasoning is not surfaced or persisted.',
      },
    ],
    blockers: [
      blocker('child_reaping_unproven', 'Stop may only report stop_requested.'),
      blocker('permission_surface_unproven', 'Codex permission prompt surfacing is not proven.'),
    ],
  },
] as const;

export const CLAUDE_AUTHORITY_PROFILES: readonly ProviderAuthorityProfile[] = [
  {
    id: CLAUDE_APP_SUPERVISED_PROFILE_ID,
    provider: 'claude-agent-sdk',
    label: 'Claude app-supervised',
    authorityClass: 'app-supervised',
    releaseMode: 'read_only',
    effectiveControls: [
      {
        code: 'permission.mode',
        value: 'dontAsk',
        evidence: 'declared',
        description: 'Claude native permission prompts are not surfaced in app-supervised mode.',
      },
      {
        code: 'settings.sources',
        value: 'none',
        evidence: 'declared',
        description: 'Project Claude settings are not loaded for app-supervised mode.',
      },
      {
        code: 'mcp.scope',
        value: 'dnaforge-only',
        evidence: 'declared',
        description: 'Only the DNAForge MCP companion is attached.',
      },
      {
        code: 'tool.deny_non_dnaforge',
        value: true,
        evidence: 'declared',
        description: 'Non-DNAForge tools are denied through the provider hook.',
      },
    ],
    userVisibleClaims: [
      { code: 'local_cli_auth', description: 'Uses the local Claude Code login.' },
      { code: 'app_tools_only', description: 'Can use DNAForge app tools only.' },
      {
        code: 'provider_permission_events',
        description: 'Provider permission denials can surface.',
      },
      { code: 'dnaforge_mcp_available', description: 'DNAForge MCP tools can be attached.' },
    ],
    unsupportedClaims: [
      {
        code: 'native_shell_in_app_supervised',
        description: 'App-supervised mode does not expose arbitrary native shell authority.',
      },
      {
        code: 'claude_native_write_parity',
        description: 'Claude native write parity is not proven.',
      },
      {
        code: 'private_chain_of_thought',
        description: 'Hidden private reasoning is not surfaced or persisted.',
      },
    ],
    blockers: [blocker('child_reaping_unproven', 'Stop may only report stop_requested.')],
  },
  {
    id: CLAUDE_NATIVE_READ_ONLY_PROFILE_ID,
    provider: 'claude-agent-sdk',
    label: 'Claude native read-only',
    authorityClass: 'native-read-only',
    releaseMode: 'dev_only',
    effectiveControls: [
      {
        code: 'permission.mode',
        value: 'default',
        evidence: 'declared',
        description: 'Claude Code native permissions remain provider-owned.',
      },
      {
        code: 'workspace.cwd',
        value: 'required',
        evidence: 'declared',
        description: 'A working folder is required before start.',
      },
      {
        code: 'release.gate',
        value: 'development-only',
        evidence: 'declared',
        description: 'Read-only equivalence still needs provider proof.',
      },
    ],
    userVisibleClaims: [
      { code: 'local_cli_auth', description: 'Uses the local Claude Code login.' },
      {
        code: 'cwd_supported',
        description: "Runs from the chat's own folder; your projects are reachable from it.",
      },
      {
        code: 'provider_permission_events',
        description: 'Provider permission events can surface.',
      },
    ],
    unsupportedClaims: [
      {
        code: 'app_controls_native_cli_permissions',
        description: 'DNAForge grants do not govern provider-native CLI permissions.',
      },
      {
        code: 'claude_native_write_parity',
        description: 'Claude native write parity is not proven.',
      },
      {
        code: 'production_safe_child_reaping',
        description: 'Child process reaping is not proven for native provider tools.',
      },
    ],
    blockers: [
      blocker('child_reaping_unproven', 'Stop may only report stop_requested.'),
      blocker('permission_surface_unproven', 'Read-only equivalence needs live proof.'),
    ],
  },
  {
    id: CLAUDE_NATIVE_WORKSPACE_WRITE_PROFILE_ID,
    provider: 'claude-agent-sdk',
    label: 'Claude native project write',
    authorityClass: 'native-workspace-write',
    releaseMode: 'production',
    effectiveControls: [
      {
        code: 'permission.mode',
        value: 'default',
        evidence: 'declared',
        description: 'Claude Code native permissions remain provider-owned.',
      },
      {
        code: 'settings.sources',
        value: 'provider-owned',
        evidence: 'declared',
        description: 'Claude Code may use its normal local settings and permission posture.',
      },
      {
        code: 'workspace.cwd',
        value: 'required',
        evidence: 'declared',
        description: 'A working folder is required before start.',
      },
      {
        code: 'mcp.scope',
        value: 'dnaforge-companion',
        evidence: 'declared',
        description: 'The DNAForge MCP companion is attached in addition to Claude Code tools.',
      },
      {
        code: 'release.gate',
        value: 'production',
        evidence: 'declared',
        description:
          'Standard CLI mode is allowed; provider-native authority remains provider-owned.',
      },
    ],
    userVisibleClaims: [
      { code: 'local_cli_auth', description: 'Uses the local Claude Code login.' },
      {
        code: 'native_workspace_write',
        description: 'Uses Claude Code native project authority.',
      },
      {
        code: 'cwd_supported',
        description: "Runs from the chat's own folder; your projects are reachable from it.",
      },
      { code: 'dnaforge_mcp_available', description: 'DNAForge MCP tools can be attached.' },
      {
        code: 'provider_permission_events',
        description: 'Provider permission events can surface.',
      },
    ],
    unsupportedClaims: [
      {
        code: 'app_controls_native_cli_permissions',
        description: 'DNAForge grants do not govern provider-native CLI permissions.',
      },
      {
        code: 'production_safe_child_reaping',
        description: 'Child process reaping is not proven for native provider tools.',
      },
      {
        code: 'private_chain_of_thought',
        description: 'Hidden private reasoning is not surfaced or persisted.',
      },
    ],
    blockers: [
      blocker('child_reaping_unproven', 'Stop may only report stop_requested.'),
      blocker(
        'permission_surface_unproven',
        'Claude Code permission event parity needs live proof.'
      ),
    ],
  },
  {
    id: CLAUDE_NATIVE_WORKSPACE_WRITE_BLOCKED_PROFILE_ID,
    provider: 'claude-agent-sdk',
    label: 'Claude native project write (blocked)',
    authorityClass: 'disabled',
    releaseMode: 'dev_only',
    effectiveControls: [
      {
        code: 'permission.mode',
        value: 'unresolved',
        evidence: 'declared',
        description: 'No Claude native write posture has been selected or proven.',
      },
      {
        code: 'release.gate',
        value: 'blocked',
        evidence: 'declared',
        description: 'This profile cannot start until native-write authority is resolved.',
      },
    ],
    userVisibleClaims: [
      { code: 'local_cli_auth', description: 'Uses the local Claude Code login.' },
      {
        code: 'provider_permission_events',
        description: 'Provider permission events can surface.',
      },
    ],
    unsupportedClaims: [
      {
        code: 'claude_native_write_parity',
        description: 'Claude native project write does not yet match Codex authority.',
      },
      {
        code: 'app_controls_native_cli_permissions',
        description: 'DNAForge grants do not govern provider-native CLI permissions.',
      },
      {
        code: 'production_safe_child_reaping',
        description: 'Child process reaping is not proven for native provider tools.',
      },
    ],
    blockers: [
      blocker(
        'native_write_unresolved',
        'Claude native-write posture has not been selected.',
        true
      ),
      blocker('child_reaping_unproven', 'Stop may only report stop_requested.'),
    ],
  },
] as const;

export const GROK_AUTHORITY_PROFILES: readonly ProviderAuthorityProfile[] = [
  {
    id: GROK_APP_SUPERVISED_PROFILE_ID,
    provider: 'grok-acp',
    label: 'Grok app-supervised (disabled)',
    authorityClass: 'disabled',
    releaseMode: 'production',
    effectiveControls: [
      {
        code: 'permission.mode',
        value: 'dontAsk',
        evidence: 'declared',
        description:
          'The app can request dontAsk, but that alone does not override explicit project permission rules.',
      },
      {
        code: 'mcp.scope',
        value: 'dnaforge-only',
        evidence: 'declared',
        description: 'The ACP session receives only the DNAForge MCP companion.',
      },
      {
        code: 'web_search.mode',
        value: 'provider-policy',
        evidence: 'declared',
        description: 'DNAForge does not independently override Grok web-search policy.',
      },
      {
        code: 'workspace.cwd',
        value: 'required',
        evidence: 'declared',
        description: 'The ACP session is fenced to the selected workspace cwd.',
      },
    ],
    userVisibleClaims: [
      { code: 'local_cli_auth', description: 'Uses the Grok Build stored login.' },
      { code: 'cwd_supported', description: 'Runs from the selected workspace cwd.' },
      {
        code: 'dnaforge_mcp_available',
        description: 'The DNAForge MCP server can attach over ACP.',
      },
      {
        code: 'provider_permission_events',
        description: 'ACP permission and elicitation requests appear in the shared inline card.',
      },
    ],
    unsupportedClaims: [
      {
        code: 'native_shell_in_app_supervised',
        description:
          'DNAForge cannot yet prove that every provider-native tool stays unavailable under project permission rules.',
      },
      {
        code: 'app_controls_native_cli_permissions',
        description:
          'The provider permission engine, including project rules, is not fully controlled by DNAForge.',
      },
      {
        code: 'private_chain_of_thought',
        description: 'Hidden private reasoning is not surfaced or persisted.',
      },
    ],
    blockers: [
      blocker(
        'native_write_unresolved',
        'Disabled until an installed-runtime probe proves that project rules cannot grant non-DNAForge tools.',
        true
      ),
    ],
  },
  {
    id: GROK_NATIVE_WORKSPACE_WRITE_PROFILE_ID,
    provider: 'grok-acp',
    label: 'Grok native workspace write',
    authorityClass: 'native-workspace-write',
    releaseMode: 'production',
    effectiveControls: [
      {
        code: 'permission.mode',
        value: 'default',
        evidence: 'declared',
        description: 'Grok requests native tool permission through ACP.',
      },
      {
        code: 'workspace.cwd',
        value: 'required',
        evidence: 'declared',
        description: 'Native tools are rooted in the selected workspace cwd.',
      },
      {
        code: 'mcp.scope',
        value: 'dnaforge-companion',
        evidence: 'declared',
        description: 'The app supplies the DNAForge MCP server in the ACP session request.',
      },
      {
        code: 'web_search.mode',
        value: 'provider-policy',
        evidence: 'declared',
        description:
          'Web search follows the installed Grok permission and configuration policy; DNAForge does not silently rewrite it.',
      },
    ],
    userVisibleClaims: [
      { code: 'local_cli_auth', description: 'Uses the Grok Build stored login.' },
      { code: 'native_workspace_write', description: 'Can request writes within the workspace.' },
      { code: 'cwd_supported', description: 'Runs from the selected workspace cwd.' },
      { code: 'dnaforge_mcp_available', description: 'DNAForge MCP tools are attached over ACP.' },
      {
        code: 'provider_permission_events',
        description: 'ACP permission and elicitation requests appear in the shared inline card.',
      },
    ],
    unsupportedClaims: [
      {
        code: 'production_safe_child_reaping',
        description: 'ACP cancellation is implemented; transitive child reaping needs live proof.',
      },
      {
        code: 'private_chain_of_thought',
        description: 'Hidden private reasoning is not surfaced or persisted.',
      },
    ],
    blockers: [blocker('child_reaping_unproven', 'Stop may only report stop_requested.')],
  },
] as const;

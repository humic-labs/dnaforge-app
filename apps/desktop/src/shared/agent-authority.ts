export type AgentTransport = 'claude-agent-sdk' | 'codex-sdk' | 'grok-acp';
export type CliPermissionMode = 'app-supervised' | 'native-cli';

export const CODEX_APP_SUPERVISED_PROFILE_ID = 'codex-sdk:app-supervised';
export const CODEX_NATIVE_READ_ONLY_PROFILE_ID = 'codex-sdk:native-read-only';
export const CODEX_NATIVE_WORKSPACE_WRITE_PROFILE_ID = 'codex-sdk:native-workspace-write-dev';

export const CLAUDE_APP_SUPERVISED_PROFILE_ID = 'claude-agent-sdk:app-supervised';
export const CLAUDE_NATIVE_READ_ONLY_PROFILE_ID = 'claude-agent-sdk:native-read-only-dev';
export const CLAUDE_NATIVE_WORKSPACE_WRITE_PROFILE_ID = 'claude-agent-sdk:native-workspace-write';
export const CLAUDE_NATIVE_WORKSPACE_WRITE_BLOCKED_PROFILE_ID =
  'claude-agent-sdk:native-workspace-write-blocked';

export const GROK_APP_SUPERVISED_PROFILE_ID = 'grok-acp:app-supervised';
export const GROK_NATIVE_WORKSPACE_WRITE_PROFILE_ID = 'grok-acp:native-workspace-write';

export function resolveCliAuthorityProfileId(input: {
  transport: AgentTransport;
  permissionMode: CliPermissionMode;
}): string {
  if (input.transport === 'codex-sdk') {
    return input.permissionMode === 'app-supervised'
      ? CODEX_APP_SUPERVISED_PROFILE_ID
      : CODEX_NATIVE_WORKSPACE_WRITE_PROFILE_ID;
  }
  if (input.transport === 'grok-acp') {
    return input.permissionMode === 'app-supervised'
      ? GROK_APP_SUPERVISED_PROFILE_ID
      : GROK_NATIVE_WORKSPACE_WRITE_PROFILE_ID;
  }

  return input.permissionMode === 'app-supervised'
    ? CLAUDE_APP_SUPERVISED_PROFILE_ID
    : CLAUDE_NATIVE_WORKSPACE_WRITE_PROFILE_ID;
}

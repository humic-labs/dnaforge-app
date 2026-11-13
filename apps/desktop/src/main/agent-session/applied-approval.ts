import {
  claudeSessionPermissionMode,
  codexSessionApprovalPolicy,
  dnaforgeSupervision,
  permissionFamilyForTransport,
  type ResolvedAgentPermissions,
} from '../../shared/agent-permissions';
import type { CliPermissionMode } from '../../shared/agent-authority';
import type { AgentProvider } from './types';

export interface AppliedApprovalInput {
  provider: AgentProvider;
  permissionMode: CliPermissionMode;
  permissions: ResolvedAgentPermissions;
  cwd: string;
  writableRoots: readonly string[];
  interactive: boolean;
  molecularTrialAuthor: boolean;
}

export function describeAppliedApproval(input: AppliedApprovalInput): Record<string, unknown> {
  const base = { cwd: input.cwd, writableRoots: [...input.writableRoots] };
  if (input.molecularTrialAuthor) {
    return { ...base, codex: { sandbox: 'read-only', approvalPolicy: 'never' } };
  }
  if (input.permissionMode === 'app-supervised') {
    return { ...base, tools: 'dnaforge-only' };
  }
  const family = permissionFamilyForTransport(input.provider);
  const dnaforgeConfirmations = !dnaforgeSupervision(family, input.permissions).skipConfirmations;
  if (family === 'codex') {
    return {
      ...base,
      codex: {
        permissions: input.permissions.codex,
        approvalPolicy:
          codexSessionApprovalPolicy(input.permissions.codexApproval, input.interactive) ??
          'codex-config',
        approvalsReviewer: input.permissions.codexReviewer ?? 'codex-config',
      },
      dnaforgeConfirmations,
    };
  }
  if (family === 'grok') {
    return { ...base, grok: { mode: input.permissions.grok }, dnaforgeConfirmations };
  }
  return {
    ...base,
    claude: {
      permissionMode: claudeSessionPermissionMode(input.permissions.claude, input.interactive),
    },
    dnaforgeConfirmations,
  };
}

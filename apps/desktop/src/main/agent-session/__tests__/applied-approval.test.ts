import { describe, expect, it } from 'vitest';
import { describeAppliedApproval, type AppliedApprovalInput } from '../applied-approval';
import { BUILT_IN_AGENT_PERMISSIONS } from '../../../shared/agent-permissions';

const base: AppliedApprovalInput = {
  provider: 'codex-sdk',
  permissionMode: 'native-cli',
  permissions: BUILT_IN_AGENT_PERMISSIONS,
  cwd: '/data/chats/conv-1',
  writableRoots: ['/data/chats/conv-1', '/data/projects/a'],
  interactive: true,
  molecularTrialAuthor: false,
};

describe('describeAppliedApproval', () => {
  it("records Codex's permission profile and any approval DNAForge set", () => {
    expect(describeAppliedApproval(base)).toEqual({
      cwd: '/data/chats/conv-1',
      writableRoots: ['/data/chats/conv-1', '/data/projects/a'],
      codex: {
        permissions: ':read-only',
        approvalPolicy: 'codex-config',
        approvalsReviewer: 'codex-config',
      },
      dnaforgeConfirmations: true,
    });
    expect(
      describeAppliedApproval({
        ...base,
        permissions: {
          ...BUILT_IN_AGENT_PERMISSIONS,
          codex: ':danger-full-access',
          codexApproval: 'never',
        },
      })
    ).toMatchObject({
      codex: { permissions: ':danger-full-access', approvalPolicy: 'never' },
      dnaforgeConfirmations: false,
    });
    expect(describeAppliedApproval({ ...base, interactive: false })).toMatchObject({
      codex: { permissions: ':read-only', approvalPolicy: 'never' },
    });
  });

  it('records the Claude permission mode and DNAForge prompts', () => {
    const claude = { ...base, provider: 'claude-agent-sdk' as const };
    expect(
      describeAppliedApproval({
        ...claude,
        permissions: { ...BUILT_IN_AGENT_PERMISSIONS, claude: 'bypassPermissions' },
      })
    ).toMatchObject({
      claude: { permissionMode: 'bypassPermissions' },
      dnaforgeConfirmations: false,
    });
    expect(
      describeAppliedApproval({
        ...claude,
        permissions: { ...BUILT_IN_AGENT_PERMISSIONS, claude: 'acceptEdits' },
      })
    ).toMatchObject({ claude: { permissionMode: 'acceptEdits' }, dnaforgeConfirmations: true });
    expect(describeAppliedApproval({ ...claude, interactive: false })).toMatchObject({
      claude: { permissionMode: 'dontAsk' },
    });
  });

  it('records the Grok mode and ignores the words for app-only sessions', () => {
    expect(
      describeAppliedApproval({
        ...base,
        provider: 'grok-acp',
        permissions: { ...BUILT_IN_AGENT_PERMISSIONS, grok: 'auto' },
      })
    ).toMatchObject({ grok: { mode: 'auto' }, dnaforgeConfirmations: true });
    expect(describeAppliedApproval({ ...base, permissionMode: 'app-supervised' })).toEqual({
      cwd: '/data/chats/conv-1',
      writableRoots: ['/data/chats/conv-1', '/data/projects/a'],
      tools: 'dnaforge-only',
    });
  });
});

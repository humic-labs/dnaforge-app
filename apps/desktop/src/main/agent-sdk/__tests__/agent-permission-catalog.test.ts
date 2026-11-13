import { describe, expect, it } from 'vitest';
import {
  codexAllowedProfiles,
  codexMenuChoices,
  currentCodexChoice,
  permissionModesFromHelp,
} from '../agent-permission-catalog';

const CLAUDE_HELP = `  --permission-mode <mode>              Permission mode to use for the session
                                        (choices: "acceptEdits", "auto",
                                        "bypassPermissions", "manual",
                                        "dontAsk", "plan")
  --plugin-dir <path>                   Load plugins from a directory (choices: "x")
`;

const GROK_HELP = `      --permission-mode <MODE>
          Permission mode [possible values: default, acceptEdits, auto, dontAsk, bypassPermissions, plan]
      --prompt-file <PATH>
          Single-turn prompt from a file [possible values: other]
`;

const PROFILES = codexAllowedProfiles([
  { id: ':read-only', description: null, allowed: true },
  { id: ':workspace', description: null, allowed: true },
  { id: ':danger-full-access', description: null, allowed: true },
  { id: 'lab', description: 'Lab folders only', allowed: true },
  { id: 'blocked', description: null, allowed: false },
]);

describe('permission words read from the installed CLIs', () => {
  it("reads Claude Code's choices", () => {
    expect(permissionModesFromHelp(CLAUDE_HELP)).toEqual([
      'acceptEdits',
      'auto',
      'bypassPermissions',
      'manual',
      'dontAsk',
      'plan',
    ]);
  });

  it("reads Grok Build's possible values", () => {
    expect(permissionModesFromHelp(GROK_HELP)).toEqual([
      'default',
      'acceptEdits',
      'auto',
      'dontAsk',
      'bypassPermissions',
      'plan',
    ]);
  });

  it("does not borrow another option's list", () => {
    expect(
      permissionModesFromHelp(`  --permission-mode <mode>  Mode\n  --other (choices: "x")\n`)
    ).toEqual([]);
    expect(permissionModesFromHelp('no such option')).toEqual([]);
  });

  it("builds Codex's /permissions menu from the profiles Codex offers", () => {
    expect(codexMenuChoices(PROFILES, true).map((choice) => choice.label)).toEqual([
      'Ask for approval',
      'Approve for me',
      'Full Access',
      'Read Only',
      'lab',
    ]);
    expect(codexMenuChoices(PROFILES, false).map((choice) => choice.label)).toEqual([
      'Ask for approval',
      'Full Access',
      'Read Only',
      'lab',
    ]);
  });

  it('picks the menu item that matches what Codex is currently using', () => {
    const choices = codexMenuChoices(PROFILES, true);
    const current = (profile: string, approvalPolicy: unknown, approvalsReviewer: unknown) =>
      currentCodexChoice(
        { activePermissionProfile: { id: profile }, approvalPolicy, approvalsReviewer },
        choices
      );
    expect(current(':danger-full-access', 'never', 'user')).toBe(':danger-full-access');
    expect(current(':workspace', 'on-request', 'user')).toBe(':ask-for-approval');
    expect(current(':workspace', 'on-request', 'guardian_subagent')).toBe(':approve-for-me');
    expect(current(':workspace', 'untrusted', 'user')).toBe(':ask-for-approval');
    expect(current('lab', 'never', 'user')).toBe('lab');
    expect(currentCodexChoice({ thread: { id: 'thread-1' } }, choices)).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_AGENT_PERMISSION_CATALOG as CATALOG,
  BUILT_IN_AGENT_PERMISSIONS,
  cliModeChoices,
  dnaforgeSupervision,
  launchAgentPermissions,
  parseAgentPermissions,
  resolveAgentPermissions,
} from './agent-permissions';

describe('agent permissions', () => {
  it('accepts any well-formed word, skips retired keys and rejects flags', () => {
    expect(
      parseAgentPermissions({ claude: 'manual', codex: ':workspace', codexSandbox: 'read-only' })
    ).toEqual({ claude: 'manual', codex: ':workspace' });
    expect(parseAgentPermissions({ claude: '--dangerously-skip-permissions' })).toBeNull();
    expect(parseAgentPermissions({ claude: 'two words' })).toBeNull();
  });

  it("shows each CLI's own names, hides words the CLI never shows, and keeps new words", () => {
    expect(
      cliModeChoices('grok', ['default', 'acceptEdits', 'auto', 'futureMode', 'plan']).map(
        (choice) => choice.label
      )
    ).toEqual(['Normal', 'Plan', 'Auto-review', 'futureMode']);
    expect(cliModeChoices('claude', ['bypassPermissions', 'manual'])).toEqual([
      { value: 'manual', label: 'Manual mode' },
      { value: 'bypassPermissions', label: 'Bypass permissions' },
    ]);
  });

  it('uses only words the installed CLI offers', () => {
    expect(resolveAgentPermissions(CATALOG, { claude: 'notOffered', grok: 'plan' })).toEqual({
      ...BUILT_IN_AGENT_PERMISSIONS,
      grok: 'plan',
    });
  });

  it("sets Codex's approval and reviewer only when the choice differs from Codex's own", () => {
    const catalog = {
      ...CATALOG,
      defaults: { ...CATALOG.defaults, codex: ':danger-full-access' },
    };
    expect(launchAgentPermissions(catalog, {})).not.toHaveProperty('codexApproval');
    expect(launchAgentPermissions(catalog, { codex: ':ask-for-approval' })).toMatchObject({
      codexApproval: 'on-request',
      codexReviewer: 'user',
    });
  });

  it("keeps DNAForge's own prompts for words it does not recognize", () => {
    const words = { ...BUILT_IN_AGENT_PERMISSIONS, claude: 'someNewMode' };
    expect(dnaforgeSupervision('claude', words).skipConfirmations).toBe(false);
    expect(dnaforgeSupervision('claude', { ...words, claude: 'manual' }).askBeforeWrites).toBe(
      true
    );
    expect(
      dnaforgeSupervision('codex', { ...words, codex: ':danger-full-access' }).skipConfirmations
    ).toBe(true);
    expect(
      dnaforgeSupervision('codex', { ...words, codex: ':approve-for-me' }).skipConfirmations
    ).toBe(false);
  });
});

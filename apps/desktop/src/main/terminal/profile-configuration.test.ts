import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { validateTerminalProfileConfiguration } from './profile-configuration';
import { prepareTerminalShell } from './shell-launch';

describe('configured native shell profiles', () => {
  it.skipIf(!existsSync('/bin/bash'))('preserves command marker escaping in native Bash', () => {
    const source = readFileSync(
      new URL(
        '../../../resources/terminal-shell-integration/shellIntegration-bash.sh',
        import.meta.url
      ),
      'utf8'
    );
    const escapeFunction = source.match(/__vsc_escape_value\(\) \{[\s\S]*?\n\}/)?.[0];
    expect(escapeFunction).toBeTruthy();
    const input = 'printf "α DNA 🧬🙂"; C:\\work\\sample\t\n\x1b]633;C\x07';
    const expected = input.replace(/[\\;\x01-\x1e]/g, (character) =>
      character === '\\' ? '\\\\' : `\\x${character.charCodeAt(0).toString(16).padStart(2, '0')}`
    );
    const output = execFileSync(
      '/bin/bash',
      [
        '--noprofile',
        '--norc',
        '-c',
        `${escapeFunction}\n__vsc_escape_value "$DNAFORGE_ESCAPE_INPUT"`,
      ],
      { encoding: 'utf8', env: { ...process.env, DNAFORGE_ESCAPE_INPUT: input } }
    );
    expect(output).toBe(`${expected}\n`);
  });
  it.skipIf(!existsSync('/bin/zsh'))('preserves command marker escaping in native zsh', () => {
    const source = readFileSync(
      new URL(
        '../../../resources/terminal-shell-integration/shellIntegration-rc.zsh',
        import.meta.url
      ),
      'utf8'
    );
    const escapeFunction = source.match(/__vsc_escape_value\(\) \{[\s\S]*?\n\}/)?.[0];
    expect(escapeFunction).toBeTruthy();
    const input = 'printf "α DNA 🧬"; C:\\work\\sample\t\n\x1b]633;C\x07';
    const expected = input.replace(/[\\;\x01-\x1e]/g, (character) =>
      character === '\\' ? '\\\\' : `\\x${character.charCodeAt(0).toString(16).padStart(2, '0')}`
    );
    const output = execFileSync(
      '/bin/zsh',
      ['-f', '-c', `${escapeFunction}\n__vsc_escape_value "$DNAFORGE_ESCAPE_INPUT"`],
      {
        encoding: 'utf8',
        env: { ...process.env, DNAFORGE_ESCAPE_INPUT: input },
      }
    );
    expect(output).toBe(`${expected}\n`);
  });
  it('supplies file colors without replacing user colors, NO_COLOR or explicit profile choices', async () => {
    const profile = { id: 'zsh', name: 'zsh', path: '/bin/zsh', args: ['-c', 'true'] };
    const fresh = await prepareTerminalShell(profile, null, {});
    expect(fresh.env.LS_COLORS).toContain('*.fasta=32');
    expect(fresh.env.LS_COLORS).toContain('*.py=33');
    expect(fresh.env.CLICOLOR).toBe('1');
    const custom = await prepareTerminalShell(profile, null, {
      LS_COLORS: '*.py=35',
      CLICOLOR: '0',
    });
    expect(custom.env.LS_COLORS).toBe('*.py=35');
    expect(custom.env.CLICOLOR).toBe('0');
    const disabled = await prepareTerminalShell(profile, null, { NO_COLOR: '1' });
    expect(disabled.env.LS_COLORS).toBeUndefined();
    expect(disabled.env.CLICOLOR).toBeUndefined();
    const explicit = await prepareTerminalShell(
      { ...profile, env: { LS_COLORS: null, CLICOLOR: '0' } },
      null,
      {}
    );
    expect(explicit.env.LS_COLORS).toBeUndefined();
    expect(explicit.env.CLICOLOR).toBe('0');
  });
  it('preserves argument boundaries, literal environment values and unset values', () => {
    const profile = {
      id: 'custom-bash',
      name: 'Research shell',
      path: '/bin/bash',
      args: ['-i', 'argument containing spaces'],
      env: { EXAMPLE: 'a=b $literal', REMOVE: null },
    };
    expect(
      validateTerminalProfileConfiguration({ profiles: [profile], defaultProfileId: profile.id })
    ).toEqual({ profiles: [profile], defaultProfileId: profile.id });
  });

  it('refuses duplicate identities, relative executables and invalid native environment data', () => {
    const profile = { id: 'custom', name: 'bash', path: '/bin/bash', args: [] };
    expect(() => validateTerminalProfileConfiguration({ profiles: [profile, profile] })).toThrow(
      /duplicate/i
    );
    expect(() =>
      validateTerminalProfileConfiguration({ profiles: [{ ...profile, path: 'bash' }] })
    ).toThrow(/absolute/i);
    expect(() =>
      validateTerminalProfileConfiguration({ profiles: [{ ...profile, env: { BAD: 'x\0y' } }] })
    ).toThrow(/environment/i);
  });

  it('injects fish integration without converting non-login profiles into login shells', async () => {
    for (const args of [[], ['-i'], ['--interactive']]) {
      const launch = await prepareTerminalShell(
        { id: 'fish', name: 'Fish', path: '/fixture/fish', args },
        '/fixture/terminal integration',
        {}
      );
      expect(launch.args).toContain('--init-command');
      expect(launch.args).not.toContain('-il');
      expect(launch.args).not.toContain('-l');
      await launch.cleanup();
    }
  });

  it('recognizes standard long login and interactive flags without losing shell integration', async () => {
    const launch = await prepareTerminalShell(
      { id: 'bash', name: 'Bash', path: '/bin/bash', args: ['--login', '--interactive'] },
      '/fixture/terminal integration',
      {}
    );
    expect(launch.args).toContain('--init-file');
    expect(launch.env.VSCODE_SHELL_LOGIN).toBe('1');
    await launch.cleanup();
  });

  it('recognizes PowerShell implied NoLogo and login flags while preserving command profiles', async () => {
    for (const args of [['-NoLogo'], ['-Login', '-NoLogo']]) {
      const launch = await prepareTerminalShell(
        { id: 'pwsh', name: 'PowerShell', path: '/fixture/pwsh', args },
        '/fixture/terminal integration',
        {}
      );
      expect(launch.args).toContain('-Command');
      if (args.includes('-Login'))
        expect(launch.args.map((argument) => argument.toLowerCase())).toContain('-login');
      await launch.cleanup();
    }
    const args = ['-NoProfile', '-Command', 'Write-Output "literal command"'];
    const launch = await prepareTerminalShell(
      { id: 'pwsh', name: 'PowerShell', path: '/fixture/pwsh', args },
      '/fixture/terminal integration',
      {}
    );
    expect(launch.args).toEqual(args);
    expect(launch.env.VSCODE_INJECTION).toBeUndefined();
    await launch.cleanup();
  });
});

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { TerminalHistory } from './history';

it.runIf(process.platform === 'darwin')(
  'imports the exact Unicode command from a history file written by the native zsh',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'terminal-zsh-history-'));
    const file = join(root, 'zsh_history');
    const command = "printf '%s\\n' 'é漢🙂'";
    try {
      execFileSync(
        '/bin/zsh',
        [
          '-f',
          '-i',
          '-c',
          'HISTFILE=$1; HISTSIZE=100; SAVEHIST=100; print -sr -- "$2"; fc -W "$HISTFILE"',
          '--',
          file,
          command,
        ],
        { encoding: 'utf8' }
      );
      const history = new TerminalHistory({ read: () => undefined, write: () => undefined });
      const result = await history.read('/bin/zsh', { HISTFILE: file }, root);
      expect(result.shellCommands).toEqual([command]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
);

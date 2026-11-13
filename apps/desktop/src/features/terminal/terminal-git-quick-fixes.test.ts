import { describe, expect, it } from 'vitest';
import { terminalGitQuickFixes } from './upstream/terminal-git-quick-fixes';
import type { TerminalCommand } from '../../shared/terminal-ipc';

const command: TerminalCommand = {
  id: 'failed-git',
  command: 'git sttaus --short',
  cwd: '/project',
  startedAt: 1,
  finishedAt: 2,
  exitCode: 1,
};
const similar =
  "git: 'sttaus' is not a git command.\n\nThe most similar commands are\n\tstatus\n\tstage\n";

describe('upstream Git quick fixes', () => {
  it('keeps the original arguments and offers only suggestions from the selected failed command', () => {
    expect(terminalGitQuickFixes(command, similar)).toEqual([
      'git status --short',
      'git stage --short',
    ]);
    expect(
      terminalGitQuickFixes(
        { ...command, command: 'git status -short' },
        'error: did you mean `--short` (with two dashes)?\n'
      )
    ).toEqual(['git status --short']);
    expect(
      terminalGitQuickFixes(
        { ...command, command: 'git status --short' },
        'error: did you mean `--short` (with two dashes)?\n'
      )
    ).toEqual([]);
  });
  it('does not infer corrections from successful, running, non-Git, compound or old output', () => {
    for (const entry of [
      { ...command, exitCode: 0 },
      { ...command, finishedAt: null },
      { ...command, exitCode: null },
      { ...command, command: 'printf git-sttaus' },
      { ...command, command: 'git sttaus && echo other' },
    ])
      expect(terminalGitQuickFixes(entry, similar)).toEqual([]);
    expect(terminalGitQuickFixes(command, similar + 'unrelated output\n'.repeat(20))).toEqual([]);
    expect(
      terminalGitQuickFixes(command, 'The most similar command is\n\tstatus; echo injected\n')
    ).toEqual([]);
    expect(
      terminalGitQuickFixes(
        { ...command, command: 'git status -short' },
        'error: did you mean `--short;echo injected` (with two dashes)?\n'
      )
    ).toEqual([]);
  });
});

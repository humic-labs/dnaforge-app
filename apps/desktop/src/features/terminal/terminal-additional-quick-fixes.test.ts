import { expect, it } from 'vitest';
import type { TerminalCommand } from '../../shared/terminal-ipc';
import { terminalAdditionalQuickFixes } from './upstream/terminal-git-quick-fixes';

const command = (text: string, exitCode = 0): TerminalCommand => ({
  command: text,
  cwd: '/fixture',
  exitCode,
  startedAt: 1,
  finishedAt: 2,
});

it('offers bounded Git pull, upstream push and validated PR links only after a completed command', () => {
  expect(
    terminalAdditionalQuickFixes(
      command('git status'),
      "Your branch is behind 'origin/main' by 1 commit, and can be fast-forwarded."
    )
  ).toContainEqual({ kind: 'command', command: 'git pull --ff-only' });
  expect(
    terminalAdditionalQuickFixes(
      command('git push', 1),
      'fatal: no upstream\n    git push --set-upstream origin feature/example\n'
    )
  ).toContainEqual({ kind: 'command', command: 'git push --set-upstream origin feature/example' });
  expect(
    terminalAdditionalQuickFixes(
      command('git push'),
      'remote: https://github.com/example/project/pull/new/feature/example'
    )
  ).toContainEqual({
    kind: 'link',
    url: 'https://github.com/example/project/pull/new/feature/example',
  });
  for (const output of [
    'git push --set-upstream origin feature;touch',
    'remote: https://github.com@evil.example/a/b/pull/new/c',
  ]) {
    expect(terminalAdditionalQuickFixes(command('git push', 1), output)).toEqual([]);
  }
});

it('uses literal PowerShell feedback and a native callback for occupied ports', () => {
  expect(
    terminalAdditionalQuickFixes(
      command('Get-ChidlItem', 1),
      'Suggestion [General]:\nThe most similar commands are: Get-ChildItem, Get-Item.',
      'pwsh'
    )
  ).toContainEqual({ kind: 'command', command: 'Get-ChildItem' });
  expect(
    terminalAdditionalQuickFixes(
      command('missing', 1),
      "Suggestion [cmd-not-found]:\nYou also have python3 installed, you can run 'python3' instead.",
      'pwsh'
    )
  ).toContainEqual({ kind: 'command', command: 'python3' });
  expect(
    terminalAdditionalQuickFixes(
      command('missing', 1),
      'Suggestion [General]:\nThe most similar commands are: Get-Item;evil.',
      'pwsh'
    )
  ).toEqual([]);
  expect(
    terminalAdditionalQuickFixes(
      command('node server.js', 1),
      'Error: listen EADDRINUSE 127.0.0.1:1666'
    )
  ).toContainEqual({ kind: 'port', port: 1666 });
  expect(
    terminalAdditionalQuickFixes(
      { ...command('node server.js'), finishedAt: null },
      'Error: listen EADDRINUSE 127.0.0.1:1666'
    )
  ).toEqual([]);
});

it('recognizes command suggestions from actual native PowerShell General Feedback output', () => {
  const output =
    "Get-ChidlItem: The term 'Get-ChidlItem' is not recognized as a name of a cmdlet, function, script file, or executable program.\nCheck the spelling of the name, or if a path was included, verify that the path is correct and try again.\n\n[General Feedback]\n  The most similar commands are:\n    ➤ Get-ChildItem\n\n";
  expect(terminalAdditionalQuickFixes(command('Get-ChidlItem', 1), output, 'pwsh')).toContainEqual({
    kind: 'command',
    command: 'Get-ChildItem',
  });
  expect(
    terminalAdditionalQuickFixes(
      command('Get-ChidlItem', 1),
      output.replace('➤ Get-ChildItem', '➤ Get-ChildItem; exit'),
      'pwsh'
    )
  ).toEqual([]);
});

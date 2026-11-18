/* Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See LICENSE.txt for license information.
 */
import type { TerminalCommand } from '../../../shared/terminal-ipc';
import { terminalOccupiedPorts, type TerminalQuickFix } from '../../../shared/terminal-quick-fix';

export function terminalAdditionalQuickFixes(
  command: TerminalCommand,
  output: string,
  shellPath = ''
): TerminalQuickFix[] {
  if (command.finishedAt === null || command.exitCode === null || command.command.length > 8192)
    return [];
  const lines = output.slice(-64_000).replace(/\r/g, '').trimEnd().split('\n');
  const fixes: TerminalQuickFix[] = [];
  const simple = !/[;&|<>`$\r\n]/.test(command.command);
  const git = simple && /^\s*git\s+/.test(command.command);
  if (
    git &&
    command.exitCode === 0 &&
    lines.some((line) =>
      /^Your branch is behind '.+' by \d+ commits?, and can be fast-forwarded\.$/.test(line)
    )
  )
    fixes.push({ kind: 'command', command: 'git pull --ff-only' });
  if (git && /^\s*git\s+push(?:\s|$)/.test(command.command)) {
    if (command.exitCode !== 0) {
      for (const line of lines.slice(-8)) {
        const branch = /^\s*git push --set-upstream origin ([a-zA-Z0-9_][\w./-]*)\s*$/.exec(
          line
        )?.[1];
        if (branch && !branch.includes('..') && !branch.includes('//') && !branch.endsWith('.lock'))
          fixes.push({ kind: 'command', command: `git push --set-upstream origin ${branch}` });
      }
    } else {
      for (const line of lines.slice(-16)) {
        const text = /^remote:\s*(https:\/\/\S+)\s*$/.exec(line)?.[1];
        if (!text || text.length > 4096 || /\p{Cc}/u.test(text)) continue;
        try {
          const url = new URL(text);
          if (
            url.protocol === 'https:' &&
            url.hostname === 'github.com' &&
            !url.username &&
            !url.password &&
            !url.port &&
            /^\/[^/]+\/[^/]+\/pull\/new\/.+/.test(url.pathname)
          )
            fixes.push({ kind: 'link', url: url.href });
        } catch {
          continue;
        }
      }
    }
  }
  if (command.exitCode !== 0) {
    fixes.push(
      ...terminalOccupiedPorts(output).map((port): TerminalQuickFix => ({ kind: 'port', port }))
    );
    if (simple && /(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?$/i.test(shellPath)) {
      const feedback = lines.slice(-10);
      const general = feedback.findIndex((line) =>
        /^(?:Suggestion \[General\]:|\[General Feedback\])$/.test(line.trim())
      );
      const heading = feedback[general + 1]?.trim() ?? '';
      const inline =
        general < 0
          ? undefined
          : /^The most similar commands? (?:is|are): (.+)\.$/.exec(heading)?.[1];
      const values = inline?.split(', ') ?? [];
      if (general >= 0 && /^The most similar commands? (?:is|are):$/.test(heading)) {
        for (const line of feedback.slice(general + 2)) {
          const value = /^\s*➤[\t ]+([a-zA-Z][\w.-]*)\s*$/.exec(line)?.[1];
          if (!value) break;
          values.push(value);
        }
      }
      for (const value of values) {
        if (/^[a-zA-Z][\w.-]*$/.test(value)) {
          const suffix = /^\s*\S+(.*)$/.exec(command.command)?.[1] ?? '';
          fixes.push({ kind: 'command', command: value + suffix });
        }
      }
      const unix = feedback.findIndex((line) => /Suggestion \[cmd-not-found\]:/.test(line));
      let installing = false;
      for (const line of unix < 0 ? [] : feedback.slice(unix + 1)) {
        const text = line.trim();
        if (!text) break;
        const installed = /You also have .+ installed, you can run '([^']+)' instead\./.exec(
          text
        )?.[1];
        if (installed && /^[a-zA-Z0-9_./:+@=-]+(?: +[a-zA-Z0-9_./:+@=-]+)*$/.test(installed)) {
          fixes.push({ kind: 'command', command: installed });
          installing = false;
        } else if (/Command '.+' not found, but can be installed with:/.test(text))
          installing = true;
        else if (installing && /^[a-zA-Z0-9_./:+@=-]+(?: +[a-zA-Z0-9_./:+@=-]+)*$/.test(text))
          fixes.push({ kind: 'command', command: text });
      }
    }
  }
  const seen = new Set<string>();
  return fixes
    .filter((fix) => {
      const key = JSON.stringify(fix);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 10);
}

export function terminalGitQuickFixes(command: TerminalCommand, output: string): string[] {
  if (
    command.finishedAt === null ||
    command.exitCode === null ||
    command.exitCode === 0 ||
    command.command.length > 8192 ||
    /[;&|<>`$\r\n]/.test(command.command)
  )
    return [];
  const parsed = /^(\s*git\s+)([a-z][a-z0-9-]*)(.*)$/.exec(command.command);
  if (!parsed) return [];
  const lines = output.slice(-64_000).replace(/\r/g, '').trimEnd().split('\n');
  const fixes: string[] = [];
  const similar = lines.slice(-10);
  const header = similar.findIndex((line) => /most similar commands? (is|are)/.test(line));
  if (header !== -1) {
    for (const line of similar.slice(header + 1)) {
      const token = line.trim();
      if (!token) continue;
      if (!/^[a-z][a-z0-9-]*$/.test(token)) break;
      fixes.push(`${parsed[1]}${token}${parsed[3]}`);
    }
  }
  const twoDashes = /error: did you mean `--([a-z][a-z0-9-]*)` \(with two dashes\)\?/;
  for (const line of lines.slice(-2)) {
    const flag = twoDashes.exec(line)?.[1];
    if (!flag) continue;
    const argument = new RegExp(` -${flag}(?=\\s|$)`);
    if (argument.test(command.command)) {
      fixes.push(command.command.replace(argument, () => ` --${flag}`));
    }
  }
  return [...new Set(fixes)].filter((fix) => fix !== command.command).slice(0, 10);
}

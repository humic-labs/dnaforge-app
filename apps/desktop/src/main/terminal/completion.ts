import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, opendir, stat } from 'node:fs/promises';
import { basename, delimiter, join, resolve } from 'node:path';
import { resolveGitBinary } from 'dugite';
import type { TerminalCompletionKind } from '../../shared/terminal-completion';

type Quote = "'" | '"' | null;
export interface CompletionInput {
  words: string[];
  prefix: string;
  quote: Quote;
  powershell: boolean;
}
export interface CompletionContext {
  input: string;
  cwd: string;
  shellPath: string;
  environment: Record<string, string>;
}
export interface CompletionCandidate {
  value: string;
  kind: TerminalCompletionKind;
}

export function completionInput(input: string, shellPath: string): CompletionInput | undefined {
  if (input.length > 8192 || /[\p{Cc}]/u.test(input)) return undefined;
  const powershell = /^(pwsh|powershell)(\.exe)?$/i.test(basename(shellPath));
  let quote: Quote = null;
  let word = '';
  const words: string[] = [];
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    const escape = powershell ? '`' : '\\';
    if (ch === escape && quote !== "'") {
      if (i + 1 === input.length) return undefined;
      word += input[++i];
    } else if (quote) {
      if (ch === quote) {
        if (powershell && quote === "'" && input[i + 1] === "'") {
          word += "'";
          i++;
        } else quote = null;
      } else {
        if (quote === '"' && (ch === '$' || (!powershell && (ch === '`' || ch === '!'))))
          return undefined;
        word += ch;
      }
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (/\s/u.test(ch)) {
      if (word || words.length === 0) words.push(word);
      word = '';
    } else {
      if (/[;&|<>()$`*?{}[\]#!]/.test(ch)) return undefined;
      word += ch;
    }
  }

  const prefix = word;
  return { words: [...words.filter(Boolean), prefix], prefix, quote, powershell };
}

export function completionSuffix(
  parsed: CompletionInput,
  value: string,
  directory: boolean
): string | undefined {
  if (!value.startsWith(parsed.prefix) || /\p{Cc}/u.test(value)) return undefined;
  const suffix = value.slice(parsed.prefix.length);
  if (!parsed.powershell) {
    const literal = (text: string) => "'" + text.replace(/'/g, "'\\''") + "'";

    const insertion =
      parsed.quote === "'"
        ? suffix.replace(/'/g, "'\\''") + "'"
        : parsed.quote === '"'
          ? '"' + literal(suffix)
          : !(parsed.prefix.startsWith('~') && !parsed.prefix.includes('/')) &&
              /^[\p{L}\p{N}_./:+-]+$/u.test(suffix)
            ? suffix
            : literal(suffix);
    return insertion + (directory ? '' : ' ');
  }
  let escaped: string;
  if (parsed.quote === "'") escaped = suffix.replace(/'/g, parsed.powershell ? "''" : "'\\''");
  else if (parsed.quote === '"')
    escaped = suffix.replace(
      parsed.powershell ? /[`"$]/g : /[\\"$`]/g,
      (c) => (parsed.powershell ? '`' : '\\') + c
    );
  else
    escaped = suffix.replace(/[^\p{L}\p{N}_./:+-]/gu, (c) => (parsed.powershell ? '`' : '\\') + c);
  return escaped + (directory ? '' : (parsed.quote ?? '') + ' ');
}

function envValue(environment: Record<string, string>, name: string): string | undefined {
  const key = Object.keys(environment).find((key) => key.toUpperCase() === name);
  return key ? environment[key] : undefined;
}
export function providerEnvironment(context: CompletionContext): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    GIT_OPTIONAL_LOCKS: '0',
  };
  for (const key of ['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']) {
    const value = envValue(context.environment, key);
    if (value) result[key === 'SYSTEMROOT' ? 'SystemRoot' : key] = value;
  }
  if (/^(pwsh|powershell)(\.exe)?$/i.test(basename(context.shellPath))) {
    for (const key of [
      'APPDATA',
      'LOCALAPPDATA',
      'ProgramFiles',
      'ProgramFiles(x86)',
      'ProgramW6432',
      'PSModulePath',
      'PSModuleAnalysisCachePath',
      'PSDisableModuleAnalysisCacheCleanup',
    ]) {
      const value = envValue(context.environment, key.toUpperCase());
      if (value !== undefined) result[key] = value;
    }
    result.POWERSHELL_TELEMETRY_OPTOUT = '1';
    result.POWERSHELL_UPDATECHECK = 'Off';
  }
  return result;
}

function runProvider(
  file: string,
  args: string[],
  context: CompletionContext,
  signal: AbortSignal,
  input?: string,
  timeout = 1500
): Promise<string> {
  if (signal.aborted) return Promise.resolve('');
  return new Promise((resolveOutput) => {
    const child = execFile(
      file,
      args,
      {
        cwd: context.cwd,
        env: providerEnvironment(context),
        windowsHide: true,
        timeout,
        maxBuffer: 128_000,
        signal,
        encoding: 'utf8',
      },
      (_error, stdout, stderr) =>
        resolveOutput(signal.aborted ? '' : `${stdout}\n${stderr}`.slice(0, 128_000))
    );

    child.stdin?.on('error', () => undefined);
    child.stdin?.end(input ?? '');
  });
}

async function directoryCandidates(
  context: CompletionContext,
  prefix: string,
  signal: AbortSignal
): Promise<CompletionCandidate[]> {
  const slash = process.platform === 'win32' ? /[\\/]/ : /\//;
  const last = Math.max(
    prefix.lastIndexOf('/'),
    process.platform === 'win32' ? prefix.lastIndexOf('\\') : -1
  );
  const parent = prefix.slice(0, last + 1);
  const name = prefix.slice(last + 1);
  const home =
    envValue(context.environment, 'HOME') ?? envValue(context.environment, 'USERPROFILE');
  const expanded = parent.startsWith('~/') && home ? join(home, parent.slice(2)) : parent;
  const path = resolve(context.cwd, expanded || '.');
  const candidates: CompletionCandidate[] = [];
  try {
    const dir = await opendir(path);
    let visited = 0;
    for await (const entry of dir) {
      if (signal.aborted || ++visited > 4096) break;
      if (
        !entry.name.startsWith(name) ||
        (!name.startsWith('.') && entry.name.startsWith('.')) ||
        /\p{Cc}/u.test(entry.name)
      )
        continue;
      let directory = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        directory = await stat(join(path, entry.name)).then(
          (s) => s.isDirectory(),
          () => false
        );
      }
      candidates.push({
        value: `${parent}${entry.name}${directory ? (slash.test(parent) && parent.includes('\\') ? '\\' : '/') : ''}`,
        kind: directory ? 'directory' : 'file',
      });
      if (candidates.length >= 100) break;
    }
  } catch {
    return candidates;
  }
  return candidates;
}

async function commandCandidates(
  context: CompletionContext,
  prefix: string,
  signal: AbortSignal
): Promise<CompletionCandidate[]> {
  const found = new Set<string>();
  const path = envValue(context.environment, 'PATH') ?? '';
  const extensions = (envValue(context.environment, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD')
    .toLowerCase()
    .split(';');
  for (const directory of [...new Set(path.split(delimiter).filter(Boolean))].slice(0, 64)) {
    if (signal.aborted || found.size >= 100) break;
    try {
      const entries = await opendir(resolve(context.cwd, directory));
      let visited = 0;
      for await (const entry of entries) {
        if (signal.aborted || ++visited > 4096 || found.size >= 100) break;
        if (!entry.name.startsWith(prefix) || /\p{Cc}/u.test(entry.name) || entry.isDirectory())
          continue;
        if (process.platform === 'win32') {
          if (extensions.some((ext) => entry.name.toLowerCase().endsWith(ext)))
            found.add(entry.name);
        } else {
          const path = resolve(context.cwd, directory, entry.name);
          if (
            (await stat(path).then(
              (s) => s.isFile(),
              () => false
            )) &&
            (await access(path, constants.X_OK).then(
              () => true,
              () => false
            ))
          )
            found.add(entry.name);
        }
      }
    } catch {
      continue;
    }
  }
  const shell = basename(context.shellPath).replace(/\.exe$/i, '');
  const args =
    shell === 'bash'
      ? ['--noprofile', '--norc', '-c', 'compgen -b']
      : shell === 'zsh'
        ? ['-f', '-c', 'print -rl -- ${(k)builtins}']
        : null;
  if (args) {
    const output = await runProvider(context.shellPath, args, context, signal);
    for (const word of output.split(/\s+/))
      if (/^[a-zA-Z][\w.-]*$/.test(word) && word.startsWith(prefix)) found.add(word);
  }
  return [...found].slice(0, 100).map((value) => ({ value, kind: 'command' }));
}

async function gitOptionCandidates(
  binary: string,
  args: string[],
  context: CompletionContext,
  prefix: string,
  signal: AbortSignal
): Promise<CompletionCandidate[]> {
  const help = await runProvider(binary, args, context, signal);
  const options = help.replace(/--\[no-\]/g, '--').match(/--[a-z][a-z0-9-]*/g) ?? [];
  return options
    .filter((word) => word.startsWith(prefix))
    .map((value) => ({ value, kind: 'option' }));
}

export async function suggestTerminalCompletions(
  context: CompletionContext,
  signal: AbortSignal
): Promise<CompletionCandidate[]> {
  const parsed = completionInput(context.input, context.shellPath);
  if (!parsed || signal.aborted) return [];
  const { words, prefix } = parsed;
  const candidates: CompletionCandidate[] = [];
  if (words.length === 1 && !/[\\/]/.test(prefix))
    candidates.push(...(await commandCandidates(context, prefix, signal)));
  candidates.push(...(await directoryCandidates(context, prefix, signal)));
  if (words[0] === 'git' && words.length === 2 && prefix.startsWith('-')) {
    candidates.unshift(
      ...(await gitOptionCandidates(resolveGitBinary(''), ['-h'], context, prefix, signal))
    );
  } else if (words[0] === 'git') {
    const binary = resolveGitBinary('');
    const builtins = (await runProvider(binary, ['--list-cmds=builtins'], context, signal))
      .split(/\s+/)
      .filter((word) => /^[a-z][a-z0-9-]*$/.test(word));
    if (words.length === 2)
      candidates.unshift(
        ...builtins
          .filter((word) => word.startsWith(prefix))
          .map((value): CompletionCandidate => ({ value, kind: 'argument' }))
      );
    else if (builtins.includes(words[1] ?? '')) {
      if (prefix.startsWith('-')) {
        candidates.unshift(
          ...(await gitOptionCandidates(binary, [words[1]!, '-h'], context, prefix, signal))
        );
      } else if (
        ['checkout', 'switch', 'merge', 'rebase', 'log', 'show', 'diff'].includes(words[1]!)
      ) {
        const refs = await runProvider(
          binary,
          ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes', 'refs/tags'],
          context,
          signal
        );
        candidates.unshift(
          ...refs
            .split(/\r?\n/)
            .filter((word) => word.startsWith(prefix) && /^[\w./-]+$/.test(word))
            .map((value): CompletionCandidate => ({ value, kind: 'argument' }))
        );
      }
    }
  }
  if (parsed.powershell && !signal.aborted) {
    const script =
      "$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.UTF8Encoding]::new(); [Console]::OutputEncoding=[Text.UTF8Encoding]::new(); $s=[Console]::In.ReadToEnd() | ConvertFrom-Json; @(TabExpansion2 -inputScript $s -cursorColumn $s.Length).CompletionMatches | Select-Object -First 100 -Property CompletionText,ResultType | ConvertTo-Json -Compress";
    const output = await runProvider(
      context.shellPath,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      context,
      signal,
      JSON.stringify(context.input),

      12_000
    );
    try {
      const result: unknown = JSON.parse(output.trim());
      for (const match of Array.isArray(result) ? result : [result]) {
        if (
          !match ||
          typeof match !== 'object' ||
          !('CompletionText' in match) ||
          typeof match.CompletionText !== 'string'
        )
          continue;
        const literal = completionInput(match.CompletionText, context.shellPath);
        if (
          literal &&
          literal.words.length === 1 &&
          literal.quote === null &&
          literal.prefix.startsWith(prefix)
        )
          candidates.unshift({ value: literal.prefix, kind: 'argument' });
      }
    } catch (error) {
      void error;
    }
  }
  const seen = new Set<string>();
  return signal.aborted
    ? []
    : candidates
        .filter(({ value }) => {
          if (!value.startsWith(prefix) || /\p{Cc}/u.test(value) || seen.has(value)) return false;
          seen.add(value);
          return true;
        })
        .slice(0, 100);
}

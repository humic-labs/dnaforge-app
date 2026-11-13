import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import type { AgentShellSupervision } from '../../shared/agent-runtime-ipc';
import { isPathInsideBoundary } from '../../shared/path-boundary';

export type ToolPermissionClassification =
  | 'allow'
  | 'confirm-destructive-user-file'
  | 'confirm-shell-command';

export type ShellCommandRisk = 'read-only' | 'mutating' | 'destructive' | 'unknown';

export interface ShellCommandClassification {
  risk: ShellCommandRisk;
  operation: string;
  riskSummary: string;
}

export interface ClassifyToolCallInput {
  toolName: string;
  input: unknown;
  cwd: string | null;
  userRoots: readonly string[];
  scratchRoot: string;
  shellSupervision?: AgentShellSupervision;
  askBeforeWrites?: boolean;
  commandSandbox?: boolean;
}

const STRUCTURED_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const STRUCTURED_MOVE_TOOLS = new Set(['Move']);
const STRUCTURED_DELETE_TOOLS = new Set(['Delete']);

export function canonicalizePath(inputPath: string): string {
  const abs = resolve(inputPath);
  let cur = abs;
  const tail: string[] = [];
  for (let i = 0; i < 4096; i += 1) {
    if (existsSync(cur)) break;
    const parent = dirname(cur);
    if (parent === cur) break;
    tail.unshift(basename(cur));
    cur = parent;
  }
  let real: string;
  try {
    real = realpathSync.native(cur);
  } catch {
    real = cur;
  }
  return tail.length > 0 ? join(real, ...tail) : real;
}

function extractStructuredTargetPath(toolName: string, input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const record = input as Record<string, unknown>;
  const raw = toolName === 'NotebookEdit' ? record.notebook_path : record.file_path;
  return typeof raw === 'string' && raw.trim().length > 0 ? raw : null;
}

function extractString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

const READ_ONLY_COMMANDS = new Set([
  'cat',
  'cut',
  'find',
  'grep',
  'head',
  'jq',
  'ls',
  'pwd',
  'rg',
  'sed',
  'sort',
  'stat',
  'tail',
  'uniq',
  'wc',
]);

const NON_DESTRUCTIVE_MUTATORS = new Set([
  'chmod',
  'chown',
  'mkdir',
  'npm',
  'pnpm',
  'touch',
  'yarn',
]);

function commandSegments(command: string): string[] {
  return command
    .split(/(?:&&|\|\||[;|\n])/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function commandName(segment: string): string {
  const withoutAssignments = segment.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*/, '');
  const tokens = withoutAssignments.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  let index = 0;
  while (tokens[index] === 'sudo' || tokens[index] === 'command' || tokens[index] === 'env') {
    index += 1;
  }
  const raw = tokens[index] ?? '';
  return raw.slice(raw.lastIndexOf('/') + 1).toLowerCase();
}

function gitIsReadOnly(segment: string): boolean {
  return /\bgit(?:\s+-C\s+(?:"[^"]*"|'[^']*'|\S+))*\s+(?:status|diff|log|show|branch|rev-parse|ls-files|grep)\b/i.test(
    segment
  );
}

function hasProgramLaunchingArguments(segment: string, name: string): boolean {
  if (name === 'find') {
    return /(?:^|\s)-(?:exec|execdir|ok|okdir)(?:\s|$)/.test(segment);
  }
  return false;
}

function hasOverwriteRedirection(command: string): boolean {
  let quote: 'single' | 'double' | null = null;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== 'single') {
      escaped = true;
      continue;
    }
    if (quote === 'single') {
      if (char === "'") quote = null;
      continue;
    }
    if (quote === 'double') {
      if (char === '"') quote = null;
      continue;
    }
    if (char === "'") {
      quote = 'single';
      continue;
    }
    if (char === '"') {
      quote = 'double';
      continue;
    }
    if (char !== '>') continue;
    if (command[index - 1] === '>' || command[index + 1] === '>') continue;
    const suffix = command.slice(index + 1);
    if (/^\s*&\s*\d/.test(suffix)) continue;
    return true;
  }
  return false;
}

export function classifyShellCommand(command: string): ShellCommandClassification {
  const normalized = command.trim();
  if (!normalized) {
    return {
      risk: 'unknown',
      operation: 'Run shell command',
      riskSummary: 'DNAForge could not determine what this empty or malformed command would do.',
    };
  }
  const segments = commandSegments(normalized);

  if (/\b(?:rm|rmdir|unlink|shred)\b/i.test(normalized)) {
    return {
      risk: 'destructive',
      operation: 'Delete files',
      riskSummary: 'This command can delete files or directories.',
    };
  }

  if (
    /\btruncate\b/i.test(normalized) ||
    /\bdd\b[^\n;&|]*\bof=/i.test(normalized) ||
    /\bsed\b[^\n;&|]*(?:\s-i\S*(?:\s|$)|\s--in-place(?:=\S*)?(?:\s|$))/i.test(normalized) ||
    /\bperl\b[^\n;&|]*\s-(?:pi|i)\S*(?:\s|$)/i.test(normalized) ||
    /\bfind\b[^\n;&|]*\s-delete\b/i.test(normalized) ||
    /\bopen\s*\([^)]*,\s*['"][wax]/i.test(normalized)
  ) {
    return {
      risk: 'destructive',
      operation: 'Overwrite file contents',
      riskSummary: 'This command can replace or erase existing file contents.',
    };
  }

  if (
    hasOverwriteRedirection(normalized) ||
    /\btee\b(?![^\n;&|]*\s-a(?:\s|$))/i.test(normalized) ||
    segments.some((segment) => ['cp', 'mv', 'install'].includes(commandName(segment))) ||
    /\b(?:curl|wget)\b[^\n;&|]*\s(?:-o|-O)(?:\S+|\s|$)/i.test(normalized) ||
    /\b(?:curl|wget)\b[^\n;&|]*\s(?:--output|--remote-name)(?:\s|=|$)/i.test(normalized)
  ) {
    return {
      risk: 'destructive',
      operation: 'Write or overwrite files',
      riskSummary: 'This command can overwrite an existing file.',
    };
  }

  if (
    /\bgit\b[^\n;&|]*\b(?:reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--|restore\b|stash\s+(?:drop|clear))\b/i.test(
      normalized
    ) ||
    /\bgit\b[^\n;&|]*\bbranch\b[^\n;&|]*(?:\s-[dD](?:\s|$)|\s--delete(?:\s|$))/i.test(normalized) ||
    /\brsync\b[^\n;&|]*\s--delete\b/i.test(normalized)
  ) {
    return {
      risk: 'destructive',
      operation: 'Discard file changes',
      riskSummary: 'This command can discard or delete existing file changes.',
    };
  }

  const allReadOnly = segments.every((segment) => {
    const name = commandName(segment);
    if (name === 'curl' || name === 'wget') {
      return !/\s(?:--data(?:-raw|-binary|-urlencode)?|-d|--request|-X|--upload-file|-T)(?:\s|=)/i.test(
        segment
      );
    }
    if (name === 'git') return gitIsReadOnly(segment);
    return READ_ONLY_COMMANDS.has(name) && !hasProgramLaunchingArguments(segment, name);
  });
  if (allReadOnly) {
    return {
      risk: 'read-only',
      operation: 'Run read-only shell command',
      riskSummary: 'This command reads data and does not modify files.',
    };
  }

  if (segments.some((segment) => NON_DESTRUCTIVE_MUTATORS.has(commandName(segment)))) {
    return {
      risk: 'mutating',
      operation: 'Run file-changing shell command',
      riskSummary:
        'This command may create files or change metadata, but is not classified as destructive.',
    };
  }

  return {
    risk: 'unknown',
    operation: 'Run shell command',
    riskSummary: 'DNAForge could not prove whether this command changes files.',
  };
}

export function classifyToolCall({
  toolName,
  input,
  userRoots,
  scratchRoot,
  shellSupervision = 'always',
  askBeforeWrites = false,
  commandSandbox = false,
}: ClassifyToolCallInput): ToolPermissionClassification {
  const canonScratch = canonicalizePath(scratchRoot);
  const canonUserRoots = userRoots.map((root) => canonicalizePath(root));
  const insideScratch = (candidate: string): boolean =>
    isPathInsideBoundary(candidate, canonScratch);
  const insideAnyUserRoot = (candidate: string): boolean =>
    canonUserRoots.some((root) => isPathInsideBoundary(candidate, root));

  if (
    askBeforeWrites &&
    (STRUCTURED_WRITE_TOOLS.has(toolName) ||
      STRUCTURED_MOVE_TOOLS.has(toolName) ||
      STRUCTURED_DELETE_TOOLS.has(toolName))
  ) {
    return 'confirm-destructive-user-file';
  }

  if (STRUCTURED_WRITE_TOOLS.has(toolName)) {
    const target = extractStructuredTargetPath(toolName, input);
    if (!target) return 'confirm-destructive-user-file';
    const canon = canonicalizePath(target);
    if (insideScratch(canon)) return 'allow';
    if (!insideAnyUserRoot(canon)) return 'confirm-destructive-user-file';
    if (existsSync(canon) && insideAnyUserRoot(canon)) return 'confirm-destructive-user-file';
    return 'allow';
  }

  if (STRUCTURED_MOVE_TOOLS.has(toolName) || STRUCTURED_DELETE_TOOLS.has(toolName)) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return 'confirm-destructive-user-file';
    }
    const record = input as Record<string, unknown>;
    const source = extractString(record, toolName === 'Move' ? 'source_path' : 'path');
    if (!source) return 'confirm-destructive-user-file';
    const candidates = [canonicalizePath(source)];
    if (toolName === 'Move') {
      const destination = extractString(record, 'destination_path');
      if (!destination) return 'confirm-destructive-user-file';
      candidates.push(canonicalizePath(destination));
    }
    if (candidates.every(insideScratch)) return 'allow';
    return 'confirm-destructive-user-file';
  }

  if (toolName === 'Bash' || toolName === 'ProcessStart') {
    const record = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
    const command = typeof record.command === 'string' ? record.command : '';
    if (shellSupervision === 'auto') return 'allow';
    if (shellSupervision === 'always') return 'confirm-shell-command';
    if (commandSandbox && record.dangerouslyDisableSandbox === true) return 'confirm-shell-command';
    const risk = classifyShellCommand(command).risk;
    if (risk === 'destructive') return 'confirm-shell-command';
    return risk === 'unknown' && !commandSandbox ? 'confirm-shell-command' : 'allow';
  }

  return 'allow';
}

import {
  userMessagePayload,
  renderUserMessagePayload,
  userMessageValue,
} from '@waypoint/user-messages';
import { basename, dirname, relative, sep } from 'node:path';

import type { AgentApprovalPath, AgentApprovalRule } from '../../shared/agent-approval';
import { canonicalizePath } from './tool-permission-policy';

export interface ApprovalRoot {
  path: string;
  name: string;
}

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function containingRoot(path: string, roots: readonly ApprovalRoot[]): ApprovalRoot | null {
  let best: ApprovalRoot | null = null;
  for (const root of roots) {
    for (const rootPath of new Set([root.path, canonicalizePath(root.path)])) {
      const inside = path === rootPath || path.startsWith(`${rootPath}${sep}`);
      if (inside && (!best || rootPath.length > best.path.length)) {
        best = { path: rootPath, name: root.name };
      }
    }
  }
  return best;
}

export function displayApprovalPath(path: string, roots: readonly ApprovalRoot[]): string {
  const root = containingRoot(path, roots);
  if (!root) return path;
  const rest = relative(root.path, path);
  return rest ? `${root.name}/${rest.split(sep).join('/')}` : root.name;
}

export function approvalPath(path: string, roots: readonly ApprovalRoot[]): AgentApprovalPath {
  return { display: displayApprovalPath(path, roots), full: path };
}

export function displayApprovalCommand(command: string, roots: readonly ApprovalRoot[]): string {
  return roots
    .flatMap((root) => [root, { path: canonicalizePath(root.path), name: root.name }])
    .sort((left, right) => right.path.length - left.path.length)
    .reduce((text, root) => text.split(root.path).join(root.name), command);
}

function tokens(command: string): string[] {
  return command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
}

function unquote(token: string): string {
  return token.length >= 2 && /^(["'])[\s\S]*\1$/.test(token) ? token.slice(1, -1) : token;
}

const SETUP_PROGRAMS = new Set(['cd', 'pushd', 'popd', 'export', 'set', 'source', '.']);

function segments(command: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote) {
      if (character === quote) quote = null;
      current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    const pair = command.slice(index, index + 2);
    if (pair === '&&' || pair === '||') {
      parts.push(current);
      current = '';
      index += 1;
      continue;
    }
    if (character === ';' || character === '|' || character === '\n') {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

function segmentPrograms(segment: string): string[] {
  const all = tokens(segment);
  let start = 0;
  while (start < all.length && ENV_ASSIGNMENT.test(all[start])) start += 1;
  const words = all.slice(start);
  const program = words[0] ? basename(unquote(words[0])) : null;
  if (!program) return [];
  if (!SHELLS.has(program)) return [program];
  const flag = words.findIndex((word) => /^-[a-z]*c$/.test(word));
  const inner = flag >= 0 ? words.slice(flag + 1).join(' ') : '';
  return inner ? allPrograms(unquote(inner)) : [program];
}

function allPrograms(command: string): string[] {
  return segments(command).flatMap(segmentPrograms);
}

export function commandPrograms(command: string): string[] {
  const programs = allPrograms(command);
  const tools = programs.filter((program) => !SETUP_PROGRAMS.has(program));
  return [...new Set(tools.length > 0 ? tools : programs)].sort();
}

export function commandProgram(command: string): string | null {
  const programs = allPrograms(command);
  return programs.find((program) => !SETUP_PROGRAMS.has(program)) ?? programs[0] ?? null;
}

export function commandApprovalRule(command: string): AgentApprovalRule {
  const programs = commandPrograms(command);
  if (!programs.length) return { key: `command-exact:${command}`, label: 'this exact command' };
  const message = userMessagePayload('approval.commandScope', {
    programs: userMessageValue(programs.join(' + ')),
  });
  return {
    key: `command:${programs.join('+')}`,
    label: renderUserMessagePayload(message),
    catalogMessage: message,
  };
}

export function writeApprovalRule(path: string, roots: readonly ApprovalRoot[]): AgentApprovalRule {
  const root = containingRoot(path, roots);
  const folder = root?.path ?? dirname(path);
  const message = userMessagePayload('approval.writeScope', {
    folder: userMessageValue(root?.name ?? displayApprovalPath(folder, roots)),
  });
  return {
    key: `write:${folder}`,
    label: renderUserMessagePayload(message),
    catalogMessage: message,
  };
}

export function permissionApprovalRule(kind: string): AgentApprovalRule {
  return { key: `permission:${kind}`, label: `${kind} access` };
}

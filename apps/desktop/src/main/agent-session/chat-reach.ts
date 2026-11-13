import {
  mkdir,
  readFile,
  readlink,
  realpath,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import {
  AGENT_CHAT_FILES_LABEL,
  agentShortcutName,
  isAgentChatFolderId,
  type AgentReachRoot,
} from '../../shared/agent-chat-files';
import { isPathInsideAnyBoundary, isPathInsideBoundary } from '../../shared/path-boundary';
import type { ApprovalRoot } from '../agent-sdk/approval-rules';

export interface ChatReachShortcut {
  name: string;
  path: string;
}

export interface PreparedChatReach {
  cwd: string;
  writableRoots: string[];
  shortcuts: ChatReachShortcut[];
}

export function chatReachApprovalRoots(reach: PreparedChatReach): ApprovalRoot[] {
  return [
    { path: reach.cwd, name: AGENT_CHAT_FILES_LABEL },
    ...reach.shortcuts.flatMap((shortcut) => [
      { path: shortcut.path, name: shortcut.name },
      { path: join(reach.cwd, shortcut.name), name: shortcut.name },
    ]),
  ];
}

export interface PrepareChatReachInput {
  chatFilesRoot: string;
  conversationId: string;
  roots: readonly AgentReachRoot[];
  allowedRoots: readonly string[];
  appDataDir: string;
  scratchRoot: string;
}

const SHORTCUT_MANIFEST = '.dnaforge-shortcuts.json';

async function canonicalDirectory(path: string): Promise<string | null> {
  if (!isAbsolute(path)) return null;
  try {
    const canonical = await realpath(path);
    return (await stat(canonical)).isDirectory() ? canonical : null;
  } catch {
    return null;
  }
}

async function canonicalOrSelf(path: string): Promise<string> {
  return (await canonicalDirectory(path)) ?? path;
}

export async function admitReachRoots(input: {
  roots: readonly AgentReachRoot[];
  allowedRoots: readonly string[];
  appDataDir: string;
  scratchRoot: string;
}): Promise<AgentReachRoot[]> {
  const allowed = await Promise.all(input.allowedRoots.map(canonicalOrSelf));
  const appDataDir = await canonicalOrSelf(input.appDataDir);
  const scratchRoot = await canonicalOrSelf(input.scratchRoot);
  const admitted: AgentReachRoot[] = [];
  const seen = new Set<string>();
  for (const root of input.roots) {
    const canonical = await canonicalDirectory(root.path);
    if (!canonical || seen.has(canonical)) continue;
    if (!isPathInsideAnyBoundary(canonical, allowed)) continue;
    if (isPathInsideBoundary(canonical, scratchRoot)) continue;
    if (isPathInsideBoundary(appDataDir, canonical)) continue;
    seen.add(canonical);
    admitted.push({ path: canonical, name: root.name });
  }
  return admitted;
}

async function readManifest(folder: string): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(folder, SHORTCUT_MANIFEST), 'utf8'));
    return Array.isArray(parsed)
      ? parsed.filter((name): name is string => typeof name === 'string' && name.length > 0)
      : [];
  } catch {
    return [];
  }
}

async function existingLinkTarget(path: string): Promise<string | null> {
  try {
    return await readlink(path);
  } catch {
    return null;
  }
}

async function entryExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return (await existingLinkTarget(path)) !== null;
    }
    return true;
  }
}

export async function syncProjectShortcuts(
  folder: string,
  roots: readonly AgentReachRoot[]
): Promise<ChatReachShortcut[]> {
  const previous = await readManifest(folder);
  const previousTargets = new Map<string, string | null>();
  for (const name of previous) {
    previousTargets.set(name, await existingLinkTarget(join(folder, name)));
  }

  const desired: ChatReachShortcut[] = [];
  const taken = new Set<string>();
  for (const root of roots) {
    const base = agentShortcutName(root.name);
    let name = base;
    for (let suffix = 2; ; suffix += 1) {
      const key = name.toLowerCase();
      const ownedLink = (previousTargets.get(name) ?? null) !== null;
      if (!taken.has(key) && (ownedLink || !(await entryExists(join(folder, name))))) break;
      name = `${base} (${suffix})`;
    }
    taken.add(name.toLowerCase());
    desired.push({ name, path: root.path });
  }

  const desiredTargets = new Map(desired.map((shortcut) => [shortcut.name, shortcut.path]));
  for (const [name, target] of previousTargets) {
    if (target !== null && desiredTargets.get(name) !== target) {
      await unlink(join(folder, name));
    }
  }
  for (const shortcut of desired) {
    if (previousTargets.get(shortcut.name) === shortcut.path) continue;
    await symlink(
      shortcut.path,
      join(folder, shortcut.name),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
  }
  await writeFile(
    join(folder, SHORTCUT_MANIFEST),
    `${JSON.stringify(desired.map((shortcut) => shortcut.name))}\n`,
    'utf8'
  );
  return desired;
}

export async function prepareChatReach(input: PrepareChatReachInput): Promise<PreparedChatReach> {
  if (!isAgentChatFolderId(input.conversationId)) {
    throw new Error('The chat folder identifier is invalid.');
  }
  await mkdir(input.chatFilesRoot, { recursive: true });
  const cwd = join(await canonicalOrSelf(input.chatFilesRoot), input.conversationId);
  await mkdir(cwd, { recursive: true });
  const roots = await admitReachRoots(input);
  const shortcuts = await syncProjectShortcuts(cwd, roots);
  return { cwd, writableRoots: roots.map((root) => root.path), shortcuts };
}

export function chatReachInstructions(reach: PreparedChatReach): string {
  const lines = [
    `Your working folder is this chat's own folder (${reach.cwd}). It persists across every message in this chat. Keep downloads, scratch files and intermediate results here.`,
  ];
  if (reach.shortcuts.length === 0) {
    lines.push('No projects are available to this chat yet, so keep every file in this folder.');
  } else {
    lines.push(
      `Each of the user's projects appears inside it as a folder named after the project: ${reach.shortcuts
        .map((shortcut) => `\`${shortcut.name}/\``)
        .join(
          ', '
        )}. You can read and write any of them. Save finished results into the project the user means, under \`<Project name>/analyses/<short-name>/\`, and tell the user where you put them.`,
      'Use these project-named folders in commands instead of long storage paths. When a DNAForge tool takes a path, pass `<Project name>/<path inside the project>` for project files and the absolute path for files in this chat folder.'
    );
  }
  return lines.join('\n');
}

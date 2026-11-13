import { promises as fs } from 'node:fs';
import { win32 as pathWin32 } from 'node:path';

export const WIN32_DIRECTLY_SPAWNABLE_EXTS = ['.exe', '.com'] as const;
export const NODE_ENTRYPOINT_EXTS = ['.js', '.mjs', '.cjs'] as const;

export const CLAUDE_VENDOR_SEGMENT = '@anthropic-ai/claude-code';
export const CODEX_VENDOR_SEGMENT = '@openai/codex';
export const GROK_VENDOR_SEGMENT = '@xai-official/grok';

export const WIN32_CODEX_TARGETS: ReadonlyArray<{
  pkg: string;
  triple: string;
}> = [
  { pkg: 'codex-win32-x64', triple: 'x86_64-pc-windows-msvc' },
  { pkg: 'codex-win32-arm64', triple: 'aarch64-pc-windows-msvc' },
];

export function win32LowerExt(candidate: string): string {
  const base = pathWin32.basename(candidate);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

export function isNodeEntrypoint(candidate: string): boolean {
  if ((NODE_ENTRYPOINT_EXTS as readonly string[]).includes(win32LowerExt(candidate))) return true;
  const normalized = candidate.replace(/\//gu, '\\').toLowerCase();
  return (
    normalized.includes(`\\${GROK_VENDOR_SEGMENT.replace('/', '\\')}\\`) &&
    normalized.endsWith('\\bin\\grok')
  );
}

export function isDirectlySpawnableWin32(candidate: string): boolean {
  return (WIN32_DIRECTLY_SPAWNABLE_EXTS as readonly string[]).includes(win32LowerExt(candidate));
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function tryRealpath(p: string): Promise<string> {
  try {
    const rp = (fs as typeof fs & { realpath?: (x: string) => Promise<string> }).realpath;
    if (typeof rp === 'function') return await rp(p);
  } catch {}
  return p;
}

export function parseCmdShimTargets(content: string, shimDir: string): string[] {
  const text = content.replace(/^\uFEFF/, '');
  const base = shimDir.replace(/[\\/]+$/, '');

  const tokens: string[] = [];
  for (const m of text.matchAll(/"([^"]+)"/g)) tokens.push(m[1]);
  for (const line of text.split(/\r?\n/)) {
    for (const raw of line.split(/\s+/)) {
      if (raw.includes('/') || raw.includes('\\')) tokens.push(raw.replace(/^["']|["']$/g, ''));
    }
  }

  const out: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    let resolved = token
      .replace(/%~?dp0%?/gi, base + '\\')
      .replace(/\$basedir/gi, base)
      .replace(/\$PSScriptRoot/gi, base);
    if (!pathWin32.isAbsolute(resolved) && !/^[a-z]:/i.test(resolved)) {
      resolved = pathWin32.join(base, resolved);
    }
    resolved = pathWin32.normalize(resolved);
    const lowered = resolved.toLowerCase();
    const underVendor =
      lowered.includes('@anthropic-ai\\claude-code\\') ||
      lowered.includes('@anthropic-ai/claude-code/') ||
      lowered.includes('@openai\\codex\\') ||
      lowered.includes('@openai/codex/') ||
      lowered.includes('@xai-official\\grok\\') ||
      lowered.includes('@xai-official/grok/');
    const ext = win32LowerExt(resolved);
    const spawnableExt =
      (NODE_ENTRYPOINT_EXTS as readonly string[]).includes(ext) ||
      (WIN32_DIRECTLY_SPAWNABLE_EXTS as readonly string[]).includes(ext) ||
      isNodeEntrypoint(resolved);
    if (underVendor && spawnableExt && !seen.has(resolved)) {
      seen.add(resolved);
      out.push(resolved);
    }
  }
  return out;
}

export async function resolveCodexNativeExe(launcherPath: string): Promise<string | null> {
  const real = await tryRealpath(launcherPath);
  const launcherDir = pathWin32.dirname(real);
  const codexPkgDir = pathWin32.dirname(launcherDir);

  for (const { pkg, triple } of WIN32_CODEX_TARGETS) {
    const exeTail = pathWin32.join('vendor', triple, 'bin', 'codex.exe');
    let dir = launcherDir;
    for (let i = 0; i < 40; i += 1) {
      const candidate = pathWin32.join(dir, 'node_modules', '@openai', pkg, exeTail);
      if (await pathExists(candidate)) return candidate;
      const parent = pathWin32.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    const inPackage = pathWin32.join(codexPkgDir, exeTail);
    if (await pathExists(inPackage)) return inPackage;
  }
  return null;
}

export function nodeAwareSpawn(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv
): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  if (isNodeEntrypoint(command)) {
    return {
      file: process.execPath,
      args: [command, ...args],
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
    };
  }
  return { file: command, args: [...args], env };
}

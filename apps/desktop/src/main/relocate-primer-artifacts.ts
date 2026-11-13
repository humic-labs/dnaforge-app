import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  isPathInsideBoundary,
  pathRelativeToBoundary,
  rebasePath,
  stripTrailingSep,
} from '../shared/path-boundary';

const MAX_ENTRIES = 20000;
const MAX_DEPTH = 40;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.waypoint']);

function discoverPrimerArtifacts(root: string): string[] {
  const found: string[] = [];
  let scanned = 0;
  let truncated = false;
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH || scanned >= MAX_ENTRIES) {
      truncated = true;
      return;
    }
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (scanned >= MAX_ENTRIES) {
        truncated = true;
        return;
      }
      scanned++;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(join(dir, entry.name), depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.primer.json')) {
        found.push(join(dir, entry.name));
      }
    }
  };
  walk(root, 0);
  if (truncated) {
    console.warn(
      `[relocate-primer-artifacts] workspace scan hit the ${MAX_ENTRIES}-entry / depth-${MAX_DEPTH} cap under ${root}; ` +
        `some .primer.json artifacts may not have been rebased and will re-converge on the next reconcile.`
    );
  }
  return found;
}

export interface PrimerRewriteResult {
  rewritten: number;

  originalBytes: Map<string, string>;

  failedPaths: string[];
}

interface PrimerArtifactPathFields {
  file?: { workspaceRelativePath?: unknown };
  bindings?: Array<{ target?: { workspaceRelativePath?: unknown } }>;
}

interface PrimerPathRebase {
  workspaceRoot: string;
  oldAbs: string;
  newAbs: string;
}

export function primerArtifactRelocationWouldChange(
  source: string,
  input: PrimerPathRebase
): boolean {
  const artifact: PrimerArtifactPathFields = JSON.parse(source);
  return rebasePrimerArtifactPathFields(artifact, input);
}

function rebasePrimerArtifactPathFields(
  artifact: PrimerArtifactPathFields,
  input: PrimerPathRebase
): boolean {
  const wsRoot = stripTrailingSep(resolve(input.workspaceRoot));
  const oldAbs = stripTrailingSep(resolve(input.oldAbs));
  const newAbs = stripTrailingSep(resolve(input.newAbs));
  if (oldAbs === newAbs) return false;
  const rebaseWsRel = (rel: string): string | null => {
    const abs = resolve(wsRoot, rel);
    if (!isPathInsideBoundary(abs, oldAbs)) return null;
    return pathRelativeToBoundary(rebasePath(abs, oldAbs, newAbs), wsRoot);
  };
  let changed = false;
  const selfRel = artifact.file?.workspaceRelativePath;
  if (typeof selfRel === 'string') {
    const next = rebaseWsRel(selfRel);
    if (next != null && next !== selfRel) {
      artifact.file!.workspaceRelativePath = next;
      changed = true;
    }
  }
  if (Array.isArray(artifact.bindings)) {
    for (const b of artifact.bindings) {
      const rel = b?.target?.workspaceRelativePath;
      if (typeof rel === 'string') {
        const next = rebaseWsRel(rel);
        if (next != null && next !== rel) {
          b.target!.workspaceRelativePath = next;
          changed = true;
        }
      }
    }
  }
  return changed;
}

export function rewriteAffectedPrimerArtifacts(
  input: PrimerPathRebase & {
    assertWritable?: (path: string) => void;
  }
): PrimerRewriteResult {
  const wsRoot = stripTrailingSep(resolve(input.workspaceRoot));
  const oldAbs = stripTrailingSep(resolve(input.oldAbs));
  const newAbs = stripTrailingSep(resolve(input.newAbs));
  const result: PrimerRewriteResult = { rewritten: 0, originalBytes: new Map(), failedPaths: [] };
  if (oldAbs === newAbs) return result;

  for (const filePath of discoverPrimerArtifacts(wsRoot)) {
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    let artifact: PrimerArtifactPathFields;
    try {
      artifact = JSON.parse(raw);
    } catch {
      continue;
    }

    try {
      if (!rebasePrimerArtifactPathFields(artifact, input)) continue;
      input.assertWritable?.(filePath);

      result.originalBytes.set(filePath, raw);
      const tmp = `${filePath}.reloc.tmp`;
      writeFileSync(tmp, `${JSON.stringify(artifact, null, 2)}\n`);
      renameSync(tmp, filePath);
      result.rewritten += 1;
    } catch {
      try {
        const tmp = `${filePath}.reloc.tmp`;
        if (existsSync(tmp)) rmSync(tmp);
      } catch {}
      result.originalBytes.delete(filePath);
      result.failedPaths.push(filePath);
    }
  }
  return result;
}

export function restorePrimerArtifactBytes(originalBytes: Map<string, string>): void {
  for (const [filePath, bytes] of originalBytes) {
    try {
      const tmp = `${filePath}.reloc-restore.tmp`;
      writeFileSync(tmp, bytes);
      renameSync(tmp, filePath);
    } catch {}
  }
}

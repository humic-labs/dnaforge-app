import { retainPrimerSourceInDb } from './primer-source-history';
import {
  PRIMER_RELOCATION_SOURCE_EVENT,
  PRIMER_SAVED_SOURCE_EVENT,
} from '../shared/primer-artifacts/primer-source-history';
import type Database from 'better-sqlite3';
import { assertWorkspaceProjectionPathSafe } from './workspace-projection-boundary';
import { createHash, randomUUID } from 'node:crypto';
import { readBoundPrimerArtifact, type PrimerArtifactV1 } from '../shared/primers/primer-artifact';
import {
  existsSync,
  closeSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  isPathInsideBoundary,
  pathRelativeToBoundary,
  rebasePath,
  stripTrailingSep,
} from '../shared/path-boundary';

const MAX_ENTRIES = 20000;
const MAX_DEPTH = 40;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.waypoint']);

export function discoverPrimerArtifacts(root: string): string[] {
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
  writtenHashes: Map<string, string>;

  failedPaths: string[];
  saved: Map<string, RelocatedSavedPrimer>;
}

interface PrimerArtifactPathFields {
  file?: { workspaceRelativePath?: unknown };
  bindings?: Array<{
    target?: { workspaceRelativePath?: unknown; legacyWorkspaceRelativePath?: unknown };
  }>;
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

export function rebasedPrimerSource(raw: string, input: PrimerPathRebase): string | null {
  const artifact: PrimerArtifactPathFields = JSON.parse(raw);
  return rebasePrimerArtifactPathFields(artifact, input)
    ? `${JSON.stringify(artifact, null, 2)}\n`
    : null;
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
      for (const key of ['workspaceRelativePath', 'legacyWorkspaceRelativePath'] as const) {
        const rel = b?.target?.[key];
        if (typeof rel !== 'string') continue;
        const next = rebaseWsRel(rel);
        if (next != null && next !== rel) {
          b.target![key] = next;
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
    db?: Database.Database;
  }
): PrimerRewriteResult {
  const wsRoot = stripTrailingSep(resolve(input.workspaceRoot));
  const oldAbs = stripTrailingSep(resolve(input.oldAbs));
  const newAbs = stripTrailingSep(resolve(input.newAbs));
  const result: PrimerRewriteResult = {
    rewritten: 0,
    originalBytes: new Map(),
    writtenHashes: new Map(),
    failedPaths: [],
    saved: new Map(),
  };
  if (oldAbs === newAbs) return result;

  const bindings = input.db
    ?.prepare(
      `SELECT f.entity_id, f.path FROM catalog_entity_files f
    JOIN catalog_entities e ON e.id=f.entity_id JOIN workspaces w ON w.id=f.workspace_id
    WHERE w.path=? AND f.status='current' AND (f.file_kind='primer-artifact' OR e.type='primer')`
    )
    .all(wsRoot) as Array<{ entity_id: string; path: string }> | undefined;
  const catalogued = new Map(
    (bindings ?? []).map((row) => [
      isPathInsideBoundary(row.path, oldAbs) ? rebasePath(row.path, oldAbs, newAbs) : row.path,
      row,
    ])
  );
  const paths = new Set([...discoverPrimerArtifacts(wsRoot), ...catalogued.keys()]);
  for (const filePath of paths) {
    const binding = catalogued.get(filePath);
    let raw: string;
    try {
      if (binding) assertWorkspaceProjectionPathSafe(wsRoot, filePath);
      raw = readFileSync(filePath, 'utf8');
    } catch {
      if (binding && isPathInsideBoundary(binding.path, oldAbs)) result.failedPaths.push(filePath);
      continue;
    }
    let nextText: string | null;
    try {
      nextText = rebasedPrimerSource(raw, input);
    } catch {
      if (binding && isPathInsideBoundary(binding.path, oldAbs)) result.failedPaths.push(filePath);
      continue;
    }

    let tmpCreated = false;
    try {
      if (nextText === null) {
        if (binding && isPathInsideBoundary(binding.path, oldAbs))
          throw new Error('The saved primer does not match its current file binding.');
        continue;
      }
      input.assertWritable?.(filePath);

      result.originalBytes.set(filePath, raw);
      let saved: RelocatedSavedPrimer | undefined;
      if (binding && input.db) {
        const oldRelative = pathRelativeToBoundary(binding.path, wsRoot);
        const newRelative = pathRelativeToBoundary(filePath, wsRoot);
        if (!oldRelative || !newRelative) throw new Error('Primer relocation escaped its project.');
        readBoundPrimerArtifact(raw, oldRelative, binding.entity_id);
        const next = readBoundPrimerArtifact(nextText, newRelative, binding.entity_id);
        retainPrimerSourceInDb(
          input.db,
          binding.entity_id,
          oldRelative,
          raw,
          PRIMER_RELOCATION_SOURCE_EVENT
        );
        saved = {
          relativePath: newRelative,
          content: nextText,
          sha256: createHash('sha256').update(nextText).digest('hex'),
          bytes: Buffer.byteLength(nextText),
          bindings: next.bindings,
        };
      }
      const tmp = `${filePath}.reloc.tmp`;
      writeFileSync(tmp, nextText, { flag: 'wx', mode: statSync(filePath).mode, flush: true });
      tmpCreated = true;
      renameSync(tmp, filePath);
      result.writtenHashes.set(filePath, createHash('sha256').update(nextText).digest('hex'));
      if (saved && binding) result.saved.set(binding.entity_id, saved);
      result.rewritten += 1;
    } catch {
      try {
        const tmp = `${filePath}.reloc.tmp`;
        if (tmpCreated && existsSync(tmp)) rmSync(tmp);
      } catch {}
      result.originalBytes.delete(filePath);
      result.failedPaths.push(filePath);
    }
  }
  return result;
}

export function restorePrimerArtifactBytes(
  originalBytes: ReadonlyMap<string, string>,
  writtenHashes?: ReadonlyMap<string, string>,
  temporaryDirectory: (path: string) => string = dirname
): string[] {
  const failed: string[] = [];
  for (const [filePath, bytes] of originalBytes) {
    const tmp = join(
      temporaryDirectory(filePath),
      `.${basename(filePath)}.reloc-${randomUUID()}.tmp`
    );
    let ownsTemporary = false;
    try {
      const leaf = lstatSync(filePath);
      if (!leaf.isFile() || !(leaf.mode & 0o222)) throw new Error('Primer file is not writable.');
      const fd = openSync(tmp, 'wx', leaf.mode);
      ownsTemporary = true;
      try {
        writeFileSync(fd, bytes);
        fchmodSync(fd, leaf.mode & 0o777);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      const current = lstatSync(filePath);
      if (
        !current.isFile() ||
        current.dev !== leaf.dev ||
        current.ino !== leaf.ino ||
        current.mode !== leaf.mode ||
        (writtenHashes &&
          createHash('sha256').update(readFileSync(filePath)).digest('hex') !==
            writtenHashes.get(filePath))
      )
        throw new Error('Primer changed during relocation.');
      renameSync(tmp, filePath);
      ownsTemporary = false;
    } catch {
      failed.push(filePath);
    } finally {
      if (ownsTemporary) rmSync(tmp, { force: true });
    }
  }
  return failed;
}

export interface RelocatedSavedPrimer {
  content: string;
  relativePath: string;
  sha256: string;
  bytes: number;
  bindings: PrimerArtifactV1['bindings'];
}

export function applySavedPrimerMoveProjections(
  db: Database.Database,
  saved: ReadonlyMap<string, RelocatedSavedPrimer>
) {
  for (const [id, file] of saved) {
    const binding = db
      .prepare(
        "UPDATE catalog_entity_files SET file_kind='primer-artifact',content_hash=?,size_bytes=? WHERE entity_id=? AND relative_path=? AND status='current'"
      )
      .run('sha256:' + file.sha256, file.bytes, id, file.relativePath);
    if (binding.changes !== 1)
      throw new Error('Primer relocation no longer has a unique current file binding.');
    retainPrimerSourceInDb(db, id, file.relativePath, file.content, PRIMER_SAVED_SOURCE_EVENT);
    db.prepare(
      "UPDATE catalog_entities SET metadata=json_set(COALESCE(metadata,'{}'),'$.relativePath',?) WHERE id=?"
    ).run(file.relativePath, id);
    db.prepare(
      "UPDATE primers SET origin_details=json_set(origin_details,'$.artifactPath',?) WHERE id=? AND json_extract(origin_details,'$.authority')='primer_artifact'"
    ).run(file.relativePath, id);
  }
}

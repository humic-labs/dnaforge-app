import { platform } from '../../platform';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { getExtension, getFilename, getTabTypeForFile } from '../../utils/fileTypes';
import type { TabType } from '../canvas/public/types';
import { openDocument } from '../document-opening/public/open-document';
import { presentedTabId } from '../canvas/public/document-presentation';

export interface WorkspaceFileRecord {
  path: string;
  size: number;
  mtime: number;
}

export interface WorkspaceFileSnapshot {
  rootPath: string;
  files: Map<string, WorkspaceFileRecord>;
  truncated: boolean;
  errors: Array<{ path: string; message: string }>;
}

export interface WorkspaceFileChanges {
  created: WorkspaceFileRecord[];
  modified: WorkspaceFileRecord[];
  deleted: WorkspaceFileRecord[];
}

export interface ReconcileCliWorkspaceChangesResult {
  workspaceRoot: string;
  beforeAvailable: boolean;
  after: WorkspaceFileSnapshot;
  changes: WorkspaceFileChanges;
  representativePath: string | null;
  openedPath: string | null;
}

const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_FILES = 5000;
const EXCLUDED_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.next',
  '.turbo',
  'dist',
  'build',
  'target',
]);
const IGNORED_OUTPUT_EXTENSIONS = new Set([
  'lock',
  'tmp',
  'temp',
  'swp',
  'swo',
  'bak',
  'db',
  'sqlite',
  'sqlite3',
  'map',
]);
const REPORT_TEXT_EXTENSIONS = new Set([
  'md',
  'markdown',
  'txt',
  'csv',
  'tsv',
  'json',
  'yaml',
  'yml',
  'html',
  'htm',
  'log',
]);
const BIOLOGY_EXTENSIONS = new Set([
  'gb',
  'gbk',
  'gbff',
  'genbank',
  'fasta',
  'fa',
  'fas',
  'fna',
  'ffn',
  'faa',
  'fastq',
  'fq',
  'seq',
  'ab1',
  'abi',
  'dna',
]);
const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'webp',
  'bmp',
  'tiff',
  'tif',
]);
const OUTPUT_SEGMENT_RE =
  /(^|\/)(output|outputs|result|results|report|reports|artifact|artifacts|download|downloads)(\/|$)/i;
const REPORTISH_NAME_RE =
  /(report|summary|result|analysis|output|product|construct|design|sequence|alignment|table|figure|plot)/i;

function joinPath(parent: string, child: string): string {
  return parent.endsWith('/') ? `${parent}${child}` : `${parent}/${child}`;
}

function pathName(path: string): string {
  return getFilename(path) || path.split('/').filter(Boolean).pop() || path;
}

function isHiddenPathName(name: string): boolean {
  return name.startsWith('.') && name !== '.env';
}

function isIgnoredOutputPath(path: string): boolean {
  const filename = pathName(path);
  if (!filename || filename.endsWith('~')) return true;
  if (isHiddenPathName(filename)) return true;
  const ext = getExtension(path);
  return ext !== null && IGNORED_OUTPUT_EXTENSIONS.has(ext.toLowerCase());
}

export async function scanWorkspaceFiles(
  rootPath: string,
  options: { maxDepth?: number; maxFiles?: number } = {}
): Promise<WorkspaceFileSnapshot> {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const snapshot: WorkspaceFileSnapshot = {
    rootPath,
    files: new Map(),
    truncated: false,
    errors: [],
  };

  async function scanDir(dirPath: string, depth: number): Promise<void> {
    if (depth > maxDepth || snapshot.files.size >= maxFiles) {
      snapshot.truncated = true;
      return;
    }

    let entries: Array<{ name: string; isDirectory: boolean; isFile: boolean }>;
    try {
      entries = await platform().fs.readDir(dirPath);
    } catch (err) {
      snapshot.errors.push({
        path: dirPath,
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (snapshot.files.size >= maxFiles) {
        snapshot.truncated = true;
        return;
      }
      const entryPath = joinPath(dirPath, entry.name);
      if (entry.isDirectory) {
        if (!EXCLUDED_DIRS.has(entry.name) && !isHiddenPathName(entry.name)) {
          await scanDir(entryPath, depth + 1);
        }
        continue;
      }
      if (!entry.isFile || isIgnoredOutputPath(entryPath)) continue;

      try {
        const stat = await platform().fs.stat(entryPath);
        if (!stat.isFile) continue;
        snapshot.files.set(entryPath, {
          path: entryPath,
          size: stat.size,
          mtime: stat.mtime,
        });
      } catch (err) {
        snapshot.errors.push({
          path: entryPath,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  await scanDir(rootPath, 0);
  return snapshot;
}

export function diffWorkspaceSnapshots(
  before: WorkspaceFileSnapshot,
  after: WorkspaceFileSnapshot
): WorkspaceFileChanges {
  const created: WorkspaceFileRecord[] = [];
  const modified: WorkspaceFileRecord[] = [];
  const deleted: WorkspaceFileRecord[] = [];

  for (const [path, afterRecord] of after.files) {
    const beforeRecord = before.files.get(path);
    if (!beforeRecord) {
      created.push(afterRecord);
      continue;
    }
    if (beforeRecord.size !== afterRecord.size || beforeRecord.mtime !== afterRecord.mtime) {
      modified.push(afterRecord);
    }
  }

  for (const [path, beforeRecord] of before.files) {
    if (!after.files.has(path)) {
      deleted.push(beforeRecord);
    }
  }

  const byPath = (a: WorkspaceFileRecord, b: WorkspaceFileRecord) => a.path.localeCompare(b.path);
  return {
    created: created.sort(byPath),
    modified: modified.sort(byPath),
    deleted: deleted.sort(byPath),
  };
}

function candidateScore(record: WorkspaceFileRecord, kind: 'created' | 'modified'): number {
  const ext = getExtension(record.path)?.toLowerCase() ?? '';
  const filename = pathName(record.path);
  let score = kind === 'created' ? 1000 : 300;
  if (OUTPUT_SEGMENT_RE.test(record.path)) score += 500;
  if (REPORTISH_NAME_RE.test(filename)) score += 250;
  if (BIOLOGY_EXTENSIONS.has(ext)) score += 220;
  if (REPORT_TEXT_EXTENSIONS.has(ext)) score += 180;
  if (IMAGE_EXTENSIONS.has(ext)) score += 140;
  return score;
}

export function selectRepresentativeCliOutput(changes: WorkspaceFileChanges): string | null {
  const candidates = [
    ...changes.created.map((record) => ({ record, kind: 'created' as const })),
    ...changes.modified.map((record) => ({ record, kind: 'modified' as const })),
  ].filter(({ record }) => !isIgnoredOutputPath(record.path));

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    const scoreDelta = candidateScore(b.record, b.kind) - candidateScore(a.record, a.kind);
    if (scoreDelta !== 0) return scoreDelta;
    const mtimeDelta = b.record.mtime - a.record.mtime;
    if (mtimeDelta !== 0) return mtimeDelta;
    return a.record.path.localeCompare(b.record.path);
  });
  return candidates[0].record.path;
}

function shouldAutoOpenCliOutput(path: string, tabType: TabType): boolean {
  if (tabType === 'sequence' || tabType === 'image') return true;
  if (tabType !== 'text' && tabType !== 'html') return false;
  const ext = getExtension(path)?.toLowerCase() ?? '';
  return (
    REPORT_TEXT_EXTENSIONS.has(ext) &&
    (OUTPUT_SEGMENT_RE.test(path) || REPORTISH_NAME_RE.test(pathName(path)))
  );
}

async function openCliOutput(path: string): Promise<string | null> {
  const label = pathName(path);
  const tabType = getTabTypeForFile(path);
  if (!shouldAutoOpenCliOutput(path, tabType)) return null;

  return presentedTabId(
    await openDocument({
      target: { kind: 'file', path, tabType },
      label,
      placement: { kind: 'focused' },
    })
  );
}

function dispatchWorkspaceFilesChanged(workspaceRoot: string, path: string | null): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent('waypoint:workspace-files-changed', {
      detail: {
        workspaceRoot,
        ...(path ? { path } : {}),
      },
    })
  );
}

export async function reconcileCliWorkspaceChanges({
  workspaceRoot,
  before,
  openRepresentativeOutput = false,
}: {
  workspaceRoot: string;
  before: WorkspaceFileSnapshot | null;
  openRepresentativeOutput?: boolean;
}): Promise<ReconcileCliWorkspaceChangesResult> {
  const after = await scanWorkspaceFiles(workspaceRoot);
  const changes = before
    ? diffWorkspaceSnapshots(before, after)
    : { created: [], modified: [], deleted: [] };
  const representativePath = before ? selectRepresentativeCliOutput(changes) : null;

  dispatchWorkspaceFilesChanged(workspaceRoot, representativePath);
  if (representativePath) {
    useWorkspaceStore.getState().revealPath(representativePath);
  }

  let openedPath: string | null = null;
  if (representativePath && openRepresentativeOutput) {
    const openedTabId = await openCliOutput(representativePath);
    openedPath = openedTabId ? representativePath : null;
  }

  return {
    workspaceRoot,
    beforeAvailable: before !== null,
    after,
    changes,
    representativePath,
    openedPath,
  };
}

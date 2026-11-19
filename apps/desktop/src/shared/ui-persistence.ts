import { pathIsAtOrUnder, stripTrailingSep } from './path-boundary';
import type { ActivityView } from './activity-view';

const EXPANDED_PATHS_PREFIX = 'waypoint:file-tree-expanded:';
const SIDEBAR_STATE_KEY = 'waypoint:sidebar-state';
const SCHEMA_VERSION = 1;
const SIDEBAR_SCHEMA_VERSION = 2;

export const EXPANDED_PATHS_PER_ROOT_CAP = 500;

export const EXPANDED_ROOTS_CAP = 25;

export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 500;
export const SIDEBAR_DEFAULT_WIDTH = 260;

const RESTORABLE_VIEWS = new Set<ActivityView>([
  'files',
  'search',
  'jobs',
  'lims',
  'references',
  'terminal',
  'ai',
]);

export interface SidebarState {
  activeView: ActivityView;
  sidebarVisible: boolean;
  sidebarWidth: number;
}

const SIDEBAR_DEFAULTS: SidebarState = {
  activeView: 'files',
  sidebarVisible: true,
  sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
};

let warnedExpanded = false;
let warnedSidebar = false;

function warnOnce(which: 'expanded' | 'sidebar', err: unknown): void {
  if (which === 'expanded') {
    if (warnedExpanded) return;
    warnedExpanded = true;
  } else {
    if (warnedSidebar) return;
    warnedSidebar = true;
  }
  console.warn(`[ui-persistence] could not persist ${which} state:`, err);
}

export function expandedPathsKey(rootPath: string): string {
  return `${EXPANDED_PATHS_PREFIX}${stripTrailingSep(rootPath)}`;
}

interface ExpandedRecord {
  v: number;
  updatedAt: number;
  paths: string[];
}

function parseExpandedRecord(raw: string | null): ExpandedRecord | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Partial<ExpandedRecord>;
    if (record.v !== SCHEMA_VERSION) return null;
    if (!Array.isArray(record.paths)) return null;
    return {
      v: SCHEMA_VERSION,
      updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0,
      paths: record.paths.filter((p): p is string => typeof p === 'string'),
    };
  } catch {
    return null;
  }
}

export function readExpandedPaths(rootPath: string): string[] {
  if (!rootPath) return [];
  const root = stripTrailingSep(rootPath);
  let record: ExpandedRecord | null = null;
  try {
    record = parseExpandedRecord(localStorage.getItem(expandedPathsKey(root)));
  } catch {
    return [];
  }
  if (!record) return [];
  return record.paths.filter((p) => p !== root && pathIsAtOrUnder(p, root));
}

function depthOf(path: string): number {
  return path.split(/[\\/]+/).filter(Boolean).length;
}

export function writeExpandedPaths(
  rootPath: string,
  paths: readonly string[],
  options?: { now?: number }
): void {
  if (!rootPath) return;
  const root = stripTrailingSep(rootPath);
  const kept = paths.filter((p) => p !== root && pathIsAtOrUnder(p, root));
  const bounded =
    kept.length <= EXPANDED_PATHS_PER_ROOT_CAP
      ? kept
      : [...kept]
          .sort((a, b) => depthOf(a) - depthOf(b) || a.length - b.length)
          .slice(0, EXPANDED_PATHS_PER_ROOT_CAP);

  const record: ExpandedRecord = {
    v: SCHEMA_VERSION,
    updatedAt: options?.now ?? Date.now(),
    paths: bounded,
  };
  try {
    localStorage.setItem(expandedPathsKey(root), JSON.stringify(record));
  } catch (err) {
    warnOnce('expanded', err);
  }
}

export function clearExpandedPaths(rootPath: string): void {
  if (!rootPath) return;
  try {
    localStorage.removeItem(expandedPathsKey(stripTrailingSep(rootPath)));
  } catch {}
}

export function sweepExpandedPathRoots(): void {
  let entries: Array<{ key: string; updatedAt: number }> = [];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(EXPANDED_PATHS_PREFIX)) continue;
      const record = parseExpandedRecord(localStorage.getItem(key));
      entries.push({ key, updatedAt: record?.updatedAt ?? 0 });
    }
  } catch {
    return;
  }
  if (entries.length <= EXPANDED_ROOTS_CAP) return;

  entries = entries.sort((a, b) => a.updatedAt - b.updatedAt);
  const doomed = entries.slice(0, entries.length - EXPANDED_ROOTS_CAP);
  for (const { key } of doomed) {
    try {
      localStorage.removeItem(key);
    } catch {}
  }
}

function clampWidth(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, value));
}

export function readSidebarState(): SidebarState {
  let parsed: unknown;
  try {
    const raw = localStorage.getItem(SIDEBAR_STATE_KEY);
    if (!raw) return { ...SIDEBAR_DEFAULTS };
    parsed = JSON.parse(raw);
  } catch {
    return { ...SIDEBAR_DEFAULTS };
  }
  if (!parsed || typeof parsed !== 'object') return { ...SIDEBAR_DEFAULTS };

  const record = parsed as Partial<SidebarState> & { v?: number };
  if (record.v !== 1 && record.v !== SIDEBAR_SCHEMA_VERSION) return { ...SIDEBAR_DEFAULTS };

  const storedView = record.activeView as ActivityView | undefined;
  const viewIsRestorable = !!storedView && RESTORABLE_VIEWS.has(storedView);

  return {
    activeView: viewIsRestorable ? storedView : 'files',
    sidebarVisible:
      !viewIsRestorable ||
      (record.v === 1 && storedView === 'terminal') ||
      record.sidebarVisible !== false,
    sidebarWidth: clampWidth(record.sidebarWidth),
  };
}

export function writeSidebarState(state: SidebarState): void {
  try {
    localStorage.setItem(
      SIDEBAR_STATE_KEY,
      JSON.stringify({ v: SIDEBAR_SCHEMA_VERSION, ...state })
    );
  } catch (err) {
    warnOnce('sidebar', err);
  }
}

export function __resetUiPersistence(): void {
  warnedExpanded = false;
  warnedSidebar = false;
}

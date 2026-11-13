import { createDemoSessionRuntime, type DemoSessionRuntime } from './demo-runtime';
import { DEMO_SESSIONS_DIRECTORY, type DemoStore } from './demo-store';
import {
  isSequencePackageMetaPath,
  parseSequencePackageDocument,
  serializeSequencePackageDocument,
} from '../db/sequence-package';

export const DEMO_SESSION_STORAGE_KEY = 'dnaforge.demo-session';
export const DEMO_CARRY_STORAGE_KEY = 'dnaforge.demo-carry';
export const DEMO_SWEEP_GRACE_MS = 10 * 60 * 1000;
export const DEMO_CARRY_TTL_MS = 60 * 60 * 1000;
export const DEMO_PROJECTS_BASE = '/demo-projects';

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HEARTBEAT_MS = 60 * 1000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function demoLockName(sessionId: string): string {
  return `dnaforge-demo-session:${sessionId}`;
}

function readStorage(storage: Storage | undefined, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStorage(storage: Storage | undefined, key: string, value: string | null): void {
  try {
    if (value === null) storage?.removeItem(key);
    else storage?.setItem(key, value);
  } catch {
    return;
  }
}

export function resolveDemoSessionId(
  location: Pick<Location, 'search'> = window.location,
  storage: Storage | undefined = window.sessionStorage
): string | null {
  const existing = readStorage(storage, DEMO_SESSION_STORAGE_KEY);
  if (existing && SESSION_ID.test(existing)) return existing;
  if (new URLSearchParams(location.search).get('demo') !== '1') return null;
  const created = crypto.randomUUID();
  writeStorage(storage, DEMO_SESSION_STORAGE_KEY, created);
  return created;
}

export function endDemoSessionInThisTab(storage: Storage | undefined = window.sessionStorage) {
  writeStorage(storage, DEMO_SESSION_STORAGE_KEY, null);
}

export interface DemoCarryRequest {
  sessionId: string;
  requestedAt: number;
}

export function requestDemoCarry(
  sessionId: string,
  storage: Storage | undefined = window.localStorage,
  now = Date.now()
): void {
  writeStorage(storage, DEMO_CARRY_STORAGE_KEY, JSON.stringify({ sessionId, requestedAt: now }));
}

export function readDemoCarry(
  storage: Storage | undefined = window.localStorage,
  now = Date.now()
): DemoCarryRequest | null {
  const raw = readStorage(storage, DEMO_CARRY_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<DemoCarryRequest>;
    if (
      typeof parsed.sessionId === 'string' &&
      SESSION_ID.test(parsed.sessionId) &&
      typeof parsed.requestedAt === 'number' &&
      now - parsed.requestedAt < DEMO_CARRY_TTL_MS
    ) {
      return { sessionId: parsed.sessionId, requestedAt: parsed.requestedAt };
    }
  } catch {
    return null;
  }
  return null;
}

export function clearDemoCarry(storage: Storage | undefined = window.localStorage): void {
  writeStorage(storage, DEMO_CARRY_STORAGE_KEY, null);
}

export async function touchDemoSession(store: DemoStore, sessionId: string, now = Date.now()) {
  await store.write(
    [DEMO_SESSIONS_DIRECTORY, sessionId, 'last-seen.json'],
    encoder.encode(JSON.stringify({ at: now }))
  );
}

async function lastSeen(store: DemoStore, sessionId: string): Promise<number> {
  const bytes = await store.read([DEMO_SESSIONS_DIRECTORY, sessionId, 'last-seen.json']);
  if (!bytes) return 0;
  try {
    const at = (JSON.parse(decoder.decode(bytes)) as { at?: unknown }).at;
    return typeof at === 'number' ? at : 0;
  } catch {
    return 0;
  }
}

export interface DemoLockManager {
  query(): Promise<{ held?: { name?: string }[]; pending?: { name?: string }[] }>;
}

export async function sweepDemoSessions(args: {
  store: DemoStore;
  locks: DemoLockManager | undefined;
  keepSessionIds: readonly string[];
  now?: number;
}): Promise<string[]> {
  const now = args.now ?? Date.now();
  const snapshot = (await args.locks?.query()) ?? {};
  const live = new Set(
    [...(snapshot.held ?? []), ...(snapshot.pending ?? [])]
      .map((lock) => lock.name)
      .filter((name): name is string => typeof name === 'string')
  );
  const removed: string[] = [];
  for (const sessionId of await args.store.list([DEMO_SESSIONS_DIRECTORY])) {
    if (args.keepSessionIds.includes(sessionId) || live.has(demoLockName(sessionId))) continue;
    if (now - (await lastSeen(args.store, sessionId)) < DEMO_SWEEP_GRACE_MS) continue;
    await args.store.remove([DEMO_SESSIONS_DIRECTORY, sessionId]);
    removed.push(sessionId);
  }
  return removed;
}

export function holdDemoSessionLock(sessionId: string): void {
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  void locks?.request(
    demoLockName(sessionId),
    { mode: 'shared' },
    () => new Promise<void>(() => {})
  );
}

export function startDemoHeartbeat(store: DemoStore, sessionId: string): () => void {
  const beat = () => {
    if (document.visibilityState === 'visible') void touchDemoSession(store, sessionId);
  };
  const timer = window.setInterval(beat, HEARTBEAT_MS);
  document.addEventListener('visibilitychange', beat);
  return () => {
    window.clearInterval(timer);
    document.removeEventListener('visibilitychange', beat);
  };
}

export interface DemoProjectManifest {
  schemaVersion: 1;
  projects: {
    key: string;
    displayName: string;
    openPath: string;
    files: { path: string; contentType: string }[];
  }[];
}

export async function seedDemoSession(args: {
  runtime: DemoSessionRuntime;
  fetchFile: (path: string) => Promise<Uint8Array>;
}): Promise<{ workspaceId: string; openPath: string } | null> {
  if ((await args.runtime.listWorkspaces()).length > 0) return null;
  const manifest = JSON.parse(
    decoder.decode(await args.fetchFile('manifest.json'))
  ) as DemoProjectManifest;
  let landing: { workspaceId: string; openPath: string } | null = null;
  for (const project of manifest.projects) {
    const files = await Promise.all(
      project.files.map(async (file) => {
        const bytes = await args.fetchFile(`${project.key}/${file.path}`);
        return {
          path: file.path,
          contentType: file.contentType,
          bytes: isSequencePackageMetaPath(file.path)
            ? encoder.encode(
                serializeSequencePackageDocument(
                  parseSequencePackageDocument(decoder.decode(bytes))
                )
              )
            : bytes,
        };
      })
    );
    const { workspaceId } = await args.runtime.createWorkspace(
      project.displayName,
      args.runtime.accountId
    );
    await args.runtime.publishFiles({
      workspaceId,
      baseVersionId: null,
      baseFiles: [],
      files,
      expectedAccountId: args.runtime.accountId,
      operationId: `demo-seed:${project.key}`,
    });
    landing ??= { workspaceId, openPath: project.openPath };
  }
  return landing;
}

export async function fetchDemoProjectFile(path: string): Promise<Uint8Array> {
  const response = await fetch(`${DEMO_PROJECTS_BASE}/${path}`, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`Demo project file is unavailable: ${path}`);
  return new Uint8Array(await response.arrayBuffer());
}

export function openDemoSessionRuntime(store: DemoStore, sessionId: string): DemoSessionRuntime {
  return createDemoSessionRuntime({ store, sessionId });
}

import { useCanvasStore } from '../features/canvas/store';
import { createHostedWorkspace, HostedWorkspaceApiError, publishHostedWorkspaceFiles } from './api';
import { setHostedDemoSession } from './capabilities';
import { setBrowserDemoWorkspaceStorage } from './controller';
import { DEMO_SESSIONS_DIRECTORY, createOpfsDemoStore, type DemoStore } from './demo-store';
import {
  clearDemoCarry,
  endDemoSessionInThisTab,
  fetchDemoProjectFile,
  holdDemoSessionLock,
  openDemoSessionRuntime,
  seedDemoSession,
  startDemoHeartbeat,
  sweepDemoSessions,
  touchDemoSession,
  type DemoLockManager,
} from './demo-session';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function lockManager(): DemoLockManager | undefined {
  return (navigator as Navigator & { locks?: DemoLockManager }).locks;
}

export function demoStorageSupported(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function';
}

export async function sweepAbandonedDemoSessions(keepSessionIds: readonly string[]) {
  if (!demoStorageSupported()) return [];
  try {
    return await sweepDemoSessions({
      store: createOpfsDemoStore(),
      locks: lockManager(),
      keepSessionIds,
    });
  } catch (error) {
    console.warn('[Demo session] Abandoned sessions could not be swept:', error);
    return [];
  }
}

export async function startBrowserDemoSession(sessionId: string): Promise<void> {
  if (!demoStorageSupported()) {
    throw new Error(
      'This browser cannot store a demo session. Try a current Chrome, Edge, Firefox or Safari.'
    );
  }
  const store = createOpfsDemoStore();
  holdDemoSessionLock(sessionId);
  await touchDemoSession(store, sessionId);
  startDemoHeartbeat(store, sessionId);
  await sweepAbandonedDemoSessions([sessionId]);
  const runtime = openDemoSessionRuntime(store, sessionId);
  const landing = await seedDemoSession({ runtime, fetchFile: fetchDemoProjectFile });
  setBrowserDemoWorkspaceStorage(runtime);
  setHostedDemoSession(true);
  if (landing) {
    const url = new URL(window.location.href);
    url.searchParams.set('workspaceId', landing.workspaceId);
    window.history.replaceState(window.history.state, '', url);
  }
}

async function readCarried(store: DemoStore, sessionId: string): Promise<string[]> {
  const bytes = await store.read([DEMO_SESSIONS_DIRECTORY, sessionId, 'carried.json']);
  return bytes ? (JSON.parse(decoder.decode(bytes)) as string[]) : [];
}

export async function carryDemoSessionIntoAccount(
  sessionId: string,
  accountId: string,
  store: DemoStore = createOpfsDemoStore()
): Promise<number> {
  const demo = openDemoSessionRuntime(store, sessionId);
  const carried = await readCarried(store, sessionId);
  let published = 0;
  for (const workspace of await demo.listWorkspaces()) {
    if (carried.includes(workspace.workspaceId)) continue;
    const files = await demo.latestFiles(workspace.workspaceId);
    if (files.length > 0) {
      const created = await createHostedWorkspace(workspace.displayName, accountId);
      const input = {
        workspaceId: created.workspaceId,
        baseVersionId: null,
        baseFiles: [],
        files: await Promise.all(
          files.map(async (file) => ({
            path: file.path,
            contentType: file.contentType,
            bytes: await demo.readBlob(file.contentSha256),
          }))
        ),
        expectedAccountId: accountId,
        operationId: `demo-carry:${workspace.workspaceId}`,
      };
      await publishWhenAdmitted(() => publishHostedWorkspaceFiles(input));
      published += 1;
    }
    carried.push(workspace.workspaceId);
    await store.write(
      [DEMO_SESSIONS_DIRECTORY, sessionId, 'carried.json'],
      encoder.encode(JSON.stringify(carried))
    );
  }
  await store.remove([DEMO_SESSIONS_DIRECTORY, sessionId]);
  clearDemoCarry();
  endDemoSessionInThisTab();
  return published;
}

export function closeDemoTabs(): void {
  useCanvasStore.getState().reset();
}

async function publishWhenAdmitted<T>(publish: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      return await publish();
    } catch (error) {
      if (
        !(error instanceof HostedWorkspaceApiError) ||
        error.code !== 'SEQUENCE_PACKAGE_ADMISSION_PENDING' ||
        Date.now() >= deadline
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}

import { appendFileSync } from 'fs';
import { app } from 'electron';
import { appendBootLog } from '../boot-log';
import type { DatabaseErrorDialog, DatabaseErrorDialogActionId } from '../native-module-error';
import { nativeDocumentSettlementTestSeam } from '../native-document-settlement-test-seam';
import type { SidecarFetch } from '../sidecar-request-auth';

export interface StartupWindowCreationTestBarrier {
  reached: boolean;
  wait: Promise<void>;
  release(): void;
}

export function createStartupWindowTestBarrier(): StartupWindowCreationTestBarrier | null {
  if (
    app.isPackaged ||
    process.env.NODE_ENV !== 'test' ||
    process.env.DNAFORGE_E2E_HOLD_INITIAL_WINDOW !== '1'
  ) {
    return null;
  }
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const barrier: StartupWindowCreationTestBarrier = { reached: false, wait, release };
  (
    globalThis as typeof globalThis & {
      __dnaforgeStartupWindowBarrier?: StartupWindowCreationTestBarrier;
    }
  ).__dnaforgeStartupWindowBarrier = barrier;
  return barrier;
}

export async function holdAtStartupWindowTestBarrier(
  barrier: StartupWindowCreationTestBarrier
): Promise<void> {
  barrier.reached = true;
  appendBootLog('e2e_initial_window_barrier_reached');
  await barrier.wait;
}

export function testRendererBridgeOptions(): {
  port?: number;
  sessionToken?: string;
  timeoutMs?: number;
} {
  if (process.env.WAYPOINT_TEST !== '1') return {};

  const options: { port?: number; sessionToken?: string; timeoutMs?: number } = {};
  const deadline = Number(process.env.DNAFORGE_TEST_RENDERER_DEADLINE_MS);
  if (Number.isFinite(deadline) && deadline > 0) options.timeoutMs = deadline;
  const rawPort = process.env.DNAFORGE_RENDERER_BRIDGE_PORT;
  if (rawPort) {
    const port = Number(rawPort);
    if (Number.isInteger(port) && port > 0 && port <= 65535) {
      options.port = port;
    }
  }

  const sessionToken = process.env.DNAFORGE_RENDERER_BRIDGE_TOKEN;
  if (sessionToken) {
    options.sessionToken = sessionToken;
  }

  return options;
}

export function captureStartupDatabaseDialogForTest(
  model: DatabaseErrorDialog
): DatabaseErrorDialogActionId | null {
  const capturePath = process.env.DNAFORGE_E2E_STARTUP_DIALOG_PATH;
  if (!app.isPackaged && process.env.WAYPOINT_TEST === '1' && capturePath) {
    appendFileSync(capturePath, `${JSON.stringify(model)}\n`, 'utf8');
    const requestedAction = process.env.DNAFORGE_E2E_STARTUP_DIALOG_ACTION;
    return (
      model.actions?.find((action) => action.id === requestedAction)?.id ??
      model.actions?.find((action) => action.id === 'quit')?.id ??
      'quit'
    );
  }
  return null;
}

export function skipsStartupRecoveryRelaunchForTest(): boolean {
  return (
    process.env.WAYPOINT_TEST === '1' && process.env.DNAFORGE_E2E_DISABLE_RECOVERY_RELAUNCH === '1'
  );
}

export function withNativeDocumentSettlementTestSeam(
  nativeDocumentFetch: SidecarFetch
): SidecarFetch {
  return async (path, options) => {
    const pause = nativeDocumentSettlementTestSeam.pause;
    const action = /\/actions\/([^/]+)\/settlement$/.exec(String(path));
    if (!app.isPackaged && process.env.NODE_ENV === 'test' && pause && action) {
      pause.actionId = decodeURIComponent(action[1]);
      await pause.wait;
    }
    if (!app.isPackaged && process.env.NODE_ENV === 'test' && action) {
      nativeDocumentSettlementTestSeam.attempts++;
      const failure = nativeDocumentSettlementTestSeam.failure;
      nativeDocumentSettlementTestSeam.failure = null;
      if (failure === 'before-send')
        throw new Error('Test transport failed before sending the receipt.');
      if (failure === 'after-response') {
        const response = await nativeDocumentFetch(path, options);
        if (!response.ok) return response;
        await response.arrayBuffer();
        throw new Error('Test transport lost the committed receipt response.');
      }
    }
    return nativeDocumentFetch(path, options);
  };
}

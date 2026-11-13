// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({ app: { isPackaged: false } }));
const bootLog = vi.hoisted(() => [] as string[]);

vi.mock('electron', () => electron);
vi.mock('../boot-log', () => ({ appendBootLog: (line: string) => bootLog.push(line) }));

import { nativeDocumentSettlementTestSeam } from '../native-document-settlement-test-seam';
import type { DatabaseErrorDialog } from '../native-module-error';
import {
  captureStartupDatabaseDialogForTest,
  createStartupWindowTestBarrier,
  holdAtStartupWindowTestBarrier,
  skipsStartupRecoveryRelaunchForTest,
  testRendererBridgeOptions,
  withNativeDocumentSettlementTestSeam,
} from './test-hooks';

type BarrierGlobal = typeof globalThis & { __dnaforgeStartupWindowBarrier?: unknown };

const dialog = (actions: Array<{ id: string; label: string }>): DatabaseErrorDialog =>
  ({ title: 'PRIVATE_TITLE', detail: 'PRIVATE_DETAIL', actions }) as DatabaseErrorDialog;

function resetSeam() {
  nativeDocumentSettlementTestSeam.pause = null;
  nativeDocumentSettlementTestSeam.failure = null;
  nativeDocumentSettlementTestSeam.attempts = 0;
}

beforeEach(() => {
  electron.app.isPackaged = false;
  bootLog.length = 0;
  delete (globalThis as BarrierGlobal).__dnaforgeStartupWindowBarrier;
  resetSeam();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('startup window barrier', () => {
  it('is absent, and publishes nothing, unless an unpackaged test build asks to hold', () => {
    for (const [packaged, nodeEnv, hold] of [
      [true, 'test', '1'],
      [false, 'production', '1'],
      [false, 'test', ''],
    ] as const) {
      electron.app.isPackaged = packaged;
      vi.stubEnv('NODE_ENV', nodeEnv);
      vi.stubEnv('DNAFORGE_E2E_HOLD_INITIAL_WINDOW', hold);
      expect(createStartupWindowTestBarrier()).toBeNull();
      expect((globalThis as BarrierGlobal).__dnaforgeStartupWindowBarrier).toBeUndefined();
    }
  });

  it('publishes the barrier and holds startup until a test releases it', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('DNAFORGE_E2E_HOLD_INITIAL_WINDOW', '1');
    const barrier = createStartupWindowTestBarrier();
    expect(barrier).not.toBeNull();
    if (!barrier) return;
    expect((globalThis as BarrierGlobal).__dnaforgeStartupWindowBarrier).toBe(barrier);
    let released = false;
    const held = holdAtStartupWindowTestBarrier(barrier).then(() => {
      released = true;
    });
    await Promise.resolve();
    expect(barrier.reached).toBe(true);
    expect(bootLog).toEqual(['e2e_initial_window_barrier_reached']);
    expect(released).toBe(false);
    barrier.release();
    await held;
    expect(released).toBe(true);
  });
});

describe('renderer bridge options', () => {
  it('are empty outside WAYPOINT_TEST', () => {
    vi.stubEnv('WAYPOINT_TEST', '');
    vi.stubEnv('DNAFORGE_RENDERER_BRIDGE_PORT', '4321');
    expect(testRendererBridgeOptions()).toEqual({});
  });

  it('read a deadline, a valid port and a token under WAYPOINT_TEST', () => {
    vi.stubEnv('WAYPOINT_TEST', '1');
    vi.stubEnv('DNAFORGE_TEST_RENDERER_DEADLINE_MS', '9000');
    vi.stubEnv('DNAFORGE_RENDERER_BRIDGE_PORT', '4321');
    vi.stubEnv('DNAFORGE_RENDERER_BRIDGE_TOKEN', 'PRIVATE_TOKEN');
    expect(testRendererBridgeOptions()).toEqual({
      timeoutMs: 9000,
      port: 4321,
      sessionToken: 'PRIVATE_TOKEN',
    });
    vi.stubEnv('DNAFORGE_RENDERER_BRIDGE_PORT', '70000');
    expect(testRendererBridgeOptions().port).toBeUndefined();
  });
});

describe('startup database dialog capture', () => {
  it('leaves the real dialog alone outside an unpackaged WAYPOINT_TEST run with a capture path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dialog-capture-'));
    const path = join(dir, 'dialogs.jsonl');
    try {
      for (const [packaged, waypointTest, capture] of [
        [true, '1', path],
        [false, '', path],
        [false, '1', ''],
      ] as const) {
        electron.app.isPackaged = packaged;
        vi.stubEnv('WAYPOINT_TEST', waypointTest);
        vi.stubEnv('DNAFORGE_E2E_STARTUP_DIALOG_PATH', capture);
        expect(
          captureStartupDatabaseDialogForTest(dialog([{ id: 'quit', label: 'Quit' }]))
        ).toBeNull();
      }
      expect(() => readFileSync(path, 'utf8')).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records the dialog and answers with the requested action, falling back to quit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dialog-capture-'));
    const path = join(dir, 'dialogs.jsonl');
    try {
      vi.stubEnv('WAYPOINT_TEST', '1');
      vi.stubEnv('DNAFORGE_E2E_STARTUP_DIALOG_PATH', path);
      vi.stubEnv('DNAFORGE_E2E_STARTUP_DIALOG_ACTION', 'restore');
      const actions = [
        { id: 'restore', label: 'Restore' },
        { id: 'quit', label: 'Quit' },
      ];
      expect(captureStartupDatabaseDialogForTest(dialog(actions))).toBe('restore');
      vi.stubEnv('DNAFORGE_E2E_STARTUP_DIALOG_ACTION', 'missing');
      expect(captureStartupDatabaseDialogForTest(dialog(actions))).toBe('quit');
      expect(captureStartupDatabaseDialogForTest(dialog([]))).toBe('quit');
      const lines = readFileSync(path, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(3);
      expect(JSON.parse(lines[0])).toMatchObject({ title: 'PRIVATE_TITLE', actions });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('startup recovery relaunch', () => {
  it('is skipped only when WAYPOINT_TEST and the disable flag are both set', () => {
    for (const [waypointTest, disable, skipped] of [
      ['1', '1', true],
      ['1', '', false],
      ['', '1', false],
    ] as const) {
      vi.stubEnv('WAYPOINT_TEST', waypointTest);
      vi.stubEnv('DNAFORGE_E2E_DISABLE_RECOVERY_RELAUNCH', disable);
      expect(skipsStartupRecoveryRelaunchForTest()).toBe(skipped);
    }
  });
});

describe('native document settlement seam', () => {
  const settlement = '/documents/actions/PRIVATE%20ACTION/settlement';

  it('passes production settlement straight through, even with the seam armed', async () => {
    const fetch = vi.fn(async () => new Response('ok'));
    nativeDocumentSettlementTestSeam.failure = 'before-send';
    nativeDocumentSettlementTestSeam.pause = {
      actionId: null,
      wait: new Promise<void>(() => {}),
      release: () => {},
    };
    for (const [packaged, nodeEnv] of [
      [true, 'test'],
      [false, 'production'],
    ] as const) {
      electron.app.isPackaged = packaged;
      vi.stubEnv('NODE_ENV', nodeEnv);
      await expect(withNativeDocumentSettlementTestSeam(fetch)(settlement)).resolves.toBeInstanceOf(
        Response
      );
    }
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(nativeDocumentSettlementTestSeam.attempts).toBe(0);
    expect(nativeDocumentSettlementTestSeam.failure).toBe('before-send');
    expect(nativeDocumentSettlementTestSeam.pause?.actionId).toBeNull();
  });

  it('pauses, counts and injects failures for settlement in an unpackaged test build', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const fetch = vi.fn(async () => new Response('ok'));
    const seamed = withNativeDocumentSettlementTestSeam(fetch);
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    nativeDocumentSettlementTestSeam.pause = { actionId: null, wait, release };
    const paused = seamed(settlement);
    await Promise.resolve();
    expect(nativeDocumentSettlementTestSeam.pause.actionId).toBe('PRIVATE ACTION');
    expect(fetch).not.toHaveBeenCalled();
    release();
    await paused;
    expect(nativeDocumentSettlementTestSeam.attempts).toBe(1);
    nativeDocumentSettlementTestSeam.pause = null;

    nativeDocumentSettlementTestSeam.failure = 'before-send';
    await expect(seamed(settlement)).rejects.toThrow('before sending the receipt');
    nativeDocumentSettlementTestSeam.failure = 'after-response';
    await expect(seamed(settlement)).rejects.toThrow('lost the committed receipt response');
    expect(nativeDocumentSettlementTestSeam.failure).toBeNull();
    expect(nativeDocumentSettlementTestSeam.attempts).toBe(3);
    await expect(seamed('/documents/other')).resolves.toBeInstanceOf(Response);
    expect(nativeDocumentSettlementTestSeam.attempts).toBe(3);
  });
});

describe('main-process root', () => {
  const root = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');

  it('reads no test-only switch itself', () => {
    for (const name of [
      'DNAFORGE_E2E_HOLD_INITIAL_WINDOW',
      'DNAFORGE_E2E_STARTUP_DIALOG_PATH',
      'DNAFORGE_E2E_STARTUP_DIALOG_ACTION',
      'DNAFORGE_E2E_DISABLE_RECOVERY_RELAUNCH',
      'DNAFORGE_TEST_RENDERER_DEADLINE_MS',
      'DNAFORGE_RENDERER_BRIDGE_PORT',
      'DNAFORGE_RENDERER_BRIDGE_TOKEN',
      'nativeDocumentSettlementTestSeam',
    ]) {
      expect(root, name).not.toContain(name);
    }
  });

  it('keeps each test hook at its original point in startup', () => {
    const at = (text: string) => {
      expect(root.split(text), text).toHaveLength(2);
      return root.indexOf(text);
    };
    expect(
      at('const startupWindowCreationTestBarrier = createStartupWindowTestBarrier();')
    ).toBeLessThan(at('function showStartupDatabaseError('));
    const dialogStart = at('function showStartupDatabaseError(');
    const capture = at('const captured = captureStartupDatabaseDialogForTest(model);');
    expect(capture).toBeGreaterThan(dialogStart);
    expect(capture).toBeLessThan(root.indexOf('.showMessageBoxSync(', dialogStart));
    expect(at('if (skipsStartupRecoveryRelaunchForTest()) {')).toBeLessThan(at('app.relaunch();'));
    const hold = at('await holdAtStartupWindowTestBarrier(startupWindowCreationTestBarrier);');
    expect(hold).toBeLessThan(at('config = loadConfig(app.getAppPath(), {'));
    expect(hold).toBeLessThan(root.lastIndexOf('const mainWindow = await createWindow();'));
    expect(root.lastIndexOf('const mainWindow = await createWindow();')).toBeLessThan(
      at("await import('./test-bridge')")
    );
    const nativeDocuments = readFileSync(new URL('./native-documents.ts', import.meta.url), 'utf8');
    expect(nativeDocuments).toContain(
      'fetch: withNativeDocumentSettlementTestSeam(nativeDocumentFetch),'
    );
    expect(root).not.toContain('withNativeDocumentSettlementTestSeam');
  });
});

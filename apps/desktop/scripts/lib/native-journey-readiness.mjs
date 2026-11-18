import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

export const NATIVE_JOURNEY_COMMAND_TIMEOUT_MS = 600_000;

export async function waitForInitialWorkspaceIndexing(page, paths) {
  assert.ok(paths.length > 0, 'Workspace setup requires an initial project');
  await page.evaluate(async (roots) => {
    const wait = window.__test?.waitForWorkspaceReconcileIdle;
    if (typeof wait !== 'function')
      throw new Error('Workspace reconciliation readiness observation is unavailable');
    await window.__test.waitForNativeDocumentReadiness();
    await Promise.all(roots.map((root) => wait(root)));
  }, paths);
}

export async function reloadNativePage(page, { timeoutMs = 60000, observe = () => {} } = {}) {
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0, 'Reload needs a finite deadline');
  const deadline = Date.now() + timeoutMs;
  const remaining = () => {
    const timeout = deadline - Date.now();
    assert.ok(timeout > 0, 'Native reload readiness timed out');
    return timeout;
  };
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Native reload readiness timed out')), timeoutMs);
  });
  const read = () =>
    Promise.race([page.evaluate(() => window.electronAPI?.startup?.getState?.()), expired]);
  let startup = null;
  try {
    startup = await read();
    const previousLoadId = startup?.loadId;
    assert.ok(
      typeof previousLoadId === 'string' && previousLoadId.length > 0,
      'Native reload needs the current load identity'
    );
    await observe({ phase: 'before', startup });
    await page.reload({ waitUntil: 'commit', timeout: remaining() });
    while (true) {
      remaining();
      startup = await read();
      remaining();
      if (
        typeof startup?.loadId === 'string' &&
        startup.loadId.length > 0 &&
        startup.loadId !== previousLoadId &&
        startup.pageLoaded === true &&
        startup.shellReady === true
      ) {
        await observe({ phase: 'after', startup });
        return startup;
      }
      await delay(Math.min(50, remaining()));
    }
  } catch (error) {
    await observe({ phase: 'failed', startup });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

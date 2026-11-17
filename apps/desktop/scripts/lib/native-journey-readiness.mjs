import assert from 'node:assert/strict';

export const NATIVE_JOURNEY_COMMAND_TIMEOUT_MS = 600_000;

export async function waitForInitialWorkspaceIndexing(page, paths) {
  assert.ok(paths.length > 0, 'Workspace setup requires an initial project');
  await page.evaluate(async (roots) => {
    const wait = window.__test?.waitForWorkspaceReconcileIdle;
    if (typeof wait !== 'function')
      throw new Error('Workspace reconciliation readiness observation is unavailable');
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
  const read = () => page.evaluate(() => window.electronAPI.startup.getState());
  try {
    const before = await read();
    assert.ok(
      typeof before?.loadId === 'string' && before.loadId.length > 0,
      'Native reload needs the current load identity'
    );
    await observe({ phase: 'before', startup: before });
    await page.reload({ waitUntil: 'commit', timeout: remaining() });
    const handle = await page.waitForFunction(
      async (previousLoadId) => {
        const startup = await window.electronAPI?.startup?.getState?.();
        return typeof startup?.loadId === 'string' &&
          startup.loadId.length > 0 &&
          startup.loadId !== previousLoadId &&
          startup.pageLoaded === true &&
          startup.shellReady === true
          ? startup
          : false;
      },
      before.loadId,
      { timeout: remaining() }
    );
    let startup;
    try {
      startup = await handle.jsonValue();
    } finally {
      await handle.dispose();
    }
    remaining();
    await observe({ phase: 'after', startup });
    return startup;
  } catch (error) {
    await observe({ phase: 'failed', startup: await read().catch(() => null) });
    throw error;
  }
}

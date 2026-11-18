import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const subject = await import('../../apps/desktop/scripts/lib/native-journey-readiness.mjs').catch(
  (error) => {
    if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
    throw error;
  }
);
const operation = () => {
  assert.equal(
    typeof subject.reloadNativePage,
    'function',
    'Missing native reload readiness owner'
  );
  return subject.reloadNativePage;
};
const ready = (loadId) => ({ loadId, pageLoaded: true, shellReady: true });

function fixture(
  t,
  states,
  { prior = ready('old'), reloadElapsed = 0, readElapsed = 0, reloadError, startupError } = {}
) {
  const originalNow = Date.now;
  let elapsed = 0;
  Date.now = () => originalNow() + elapsed;
  t.after(() => {
    Date.now = originalNow;
  });
  let reloaded = false;
  const events = [];
  const observations = [];
  const reads = [];
  const window = {
    electronAPI: {
      startup: {
        getState: async () => {
          if (startupError) throw startupError;
          if (!reloaded) return structuredClone(prior);
          elapsed += readElapsed;
          const state = states[Math.min(reads.length, states.length - 1)];
          reads.push(structuredClone(state));
          return structuredClone(state);
        },
      },
    },
  };
  const query = (fn, args) => vm.runInNewContext(`(${fn.toString()})(...args)`, { window, args });
  const page = {
    evaluate: async (fn, ...args) => {
      events.push({ type: 'evaluate' });
      return query(fn, args);
    },
    reload: async (options) => {
      events.push({ type: 'reload', options });
      assert.equal(
        options.waitUntil,
        'commit',
        'Navigation must not wait for the unrelated browser load event'
      );
      elapsed += reloadElapsed;
      if (reloadError) throw reloadError;
      reloaded = true;
    },
    waitForFunction: async (fn, arg, options) => {
      events.push({ type: 'wait', options });
      for (let attempt = 0; attempt < states.length; attempt++) {
        const value = query(fn, [arg]);
        if (value) return { jsonValue: async () => await value, dispose: async () => {} };
      }
      throw new Error('Native readiness timed out');
    },
  };
  return {
    page,
    events,
    observations,
    reads,
    observe: (value) => observations.push(structuredClone(value)),
  };
}

test('reload waits for the new fully ready native load before returning and observing success', async (t) => {
  const reload = operation();
  const fresh = ready('new');
  const states = [
    ready('old'),
    { ...fresh, pageLoaded: false },
    { ...fresh, shellReady: false },
    fresh,
  ];
  const f = fixture(t, states);
  const result = await reload(f.page, { timeoutMs: 1500, observe: f.observe });
  assert.deepEqual(result, fresh);
  assert.deepEqual(f.reads, states);
  assert.deepEqual(f.observations, [
    { phase: 'before', startup: ready('old') },
    { phase: 'after', startup: fresh },
  ]);
  assert.equal(f.events.filter((event) => event.type === 'reload').length, 1);
});

for (const [name, state] of [
  ['the old ready identity', ready('old')],
  ['a new load without page readiness', { ...ready('new'), pageLoaded: false }],
  ['a new load without shell readiness', { ...ready('new'), shellReady: false }],
  ['readiness without a valid new identity', { pageLoaded: true, shellReady: true }],
  ['a numeric new identity', ready(42)],
  ['an empty new identity', ready('')],
  ['a false startup observation', false],
])
  test(`${name} never counts as successful restoration`, async (t) => {
    const reload = operation();
    const f = fixture(t, [state]);
    await assert.rejects(reload(f.page, { timeoutMs: 100, observe: f.observe }));
    assert.ok(f.reads.length > 0);
    for (const read of f.reads) assert.deepEqual(read, state);
    assert.equal(
      f.observations.some((event) => event.phase === 'after'),
      false
    );
    assert.equal(f.observations.at(-1)?.phase, 'failed');
  });

for (const loadId of [undefined, '', 42])
  test(`invalid prior load identity ${String(loadId)} refuses reload`, async (t) => {
    const reload = operation();
    const f = fixture(t, [ready('new')], { prior: ready(loadId) });
    await assert.rejects(reload(f.page, { timeoutMs: 100, observe: f.observe }));
    assert.equal(
      f.events.some((event) => event.type === 'reload'),
      false
    );
    assert.equal(
      f.observations.some((event) => event.phase === 'after'),
      false
    );
  });

test('navigation and IPC reads must both fit within the original deadline', async (t) => {
  const reload = operation();
  const f = fixture(t, [ready('new')], { reloadElapsed: 65, readElapsed: 65 });
  await assert.rejects(reload(f.page, { timeoutMs: 100, observe: f.observe }));
  const navigation = f.events.find((event) => event.type === 'reload');
  assert.ok(navigation.options.timeout > 0 && navigation.options.timeout <= 100);
  assert.deepEqual(f.observations.map((event) => event.phase), ['before', 'failed']);
});

test('a navigation that exhausts the deadline cannot qualify even if a fresh state is available', async (t) => {
  const reload = operation();
  const f = fixture(t, [ready('new')], { reloadElapsed: 101 });
  await assert.rejects(reload(f.page, { timeoutMs: 100, observe: f.observe }));
  assert.equal(
    f.events.some((event) => event.type === 'wait'),
    false
  );
  assert.equal(
    f.observations.some((event) => event.phase === 'after'),
    false
  );
  assert.equal(f.observations.at(-1)?.phase, 'failed');
});

test('a closed page propagates the navigation failure and records no successful restoration', async (t) => {
  const reload = operation();
  const f = fixture(t, [ready('new')], { reloadError: new Error('Target page has been closed') });
  await assert.rejects(
    reload(f.page, { timeoutMs: 100, observe: f.observe }),
    /Target page has been closed/u
  );
  assert.equal(
    f.events.some((event) => event.type === 'wait'),
    false
  );
  assert.equal(f.observations.at(-1)?.phase, 'failed');
});

test('failure to read the native startup authority cannot launch a speculative reload', async (t) => {
  const reload = operation();
  const f = fixture(t, [ready('new')], {
    startupError: new Error('Native startup IPC unavailable'),
  });
  await assert.rejects(
    reload(f.page, { timeoutMs: 100, observe: f.observe }),
    /Native startup IPC unavailable/u
  );
  assert.equal(
    f.events.some((event) => event.type === 'reload'),
    false
  );
});

test('the workspace fixture waits for every initial root through a slow seed reconciliation', async (t) => {
  assert.equal(typeof subject?.waitForInitialWorkspaceIndexing, 'function');
  assert.equal(subject.NATIVE_JOURNEY_COMMAND_TIMEOUT_MS, 600_000);
  const roots = ['/sample-project', '/empty-project'];
  const pending = new Map(roots.map((root) => [root, Promise.withResolvers()]));
  const previousWindow = globalThis.window;
  const enrollment = Promise.withResolvers();
  const observedRoots = [];
  globalThis.window = { __test: {
    waitForNativeDocumentReadiness: () => enrollment.promise,
    waitForWorkspaceReconcileIdle: (root) => {
      observedRoots.push(root);
      return pending.get(root).promise;
    },
  } };
  t.after(() => { globalThis.window = previousWindow; });
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  let ready = false;
  const page = { evaluate: (observe, args) => observe(args) };
  const waiting = subject.waitForInitialWorkspaceIndexing(page, roots).then(() => { ready = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(observedRoots, [], 'The new root scans do not exist until native enrollment finishes');
  enrollment.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(observedRoots, roots);
  pending.get(roots[1]).resolve();
  t.mock.timers.tick(60_001);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ready, false);
  pending.get(roots[0]).resolve();
  await waiting;
  assert.equal(ready, true);
});

test('the workspace fixture surfaces a missing or failing reconciliation observer', async (t) => {
  assert.equal(typeof subject?.waitForInitialWorkspaceIndexing, 'function');
  const previousWindow = globalThis.window;
  t.after(() => { globalThis.window = previousWindow; });
  const page = { evaluate: (observe, args) => observe(args) };
  globalThis.window = { __test: {} };
  await assert.rejects(() => subject.waitForInitialWorkspaceIndexing(page, ['/sample-project']));
  globalThis.window.__test.waitForWorkspaceReconcileIdle = async () => {};
  await assert.rejects(() => subject.waitForInitialWorkspaceIndexing(page, ['/sample-project']));
  globalThis.window.__test.waitForNativeDocumentReadiness = async () => { throw new Error('enrollment failed'); };
  await assert.rejects(() => subject.waitForInitialWorkspaceIndexing(page, ['/sample-project']), /enrollment failed/u);
  globalThis.window.__test.waitForNativeDocumentReadiness = async () => {};
  globalThis.window.__test.waitForWorkspaceReconcileIdle = async () => { throw new Error('failed to index project'); };
  await assert.rejects(() => subject.waitForInitialWorkspaceIndexing(page, ['/sample-project']), /failed to index project/);
});

test('workspace fixture observes each new enrollment before archiving a seeded project', async () => {
  const source = readFileSync(new URL('../../apps/desktop/scripts/check-workspace-session.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('    const initialFolders = ');
  const end = source.indexOf('    const second = await create(', start);
  assert.ok(start >= 0 && end > start);
  const run = new vm.Script(`(async ({ assert, page, observe, receipt, create, step, archive, waitForInitialWorkspaceIndexing }) => {${source.slice(start, end)}})`).runInThisContext();
  const trace = [];
  const folders = [{ path: '/ordinary' }, { path: '/samples' }, { path: '/reference', pinned: true }];
  await run({
    assert,
    page: { keyboard: { press() {} }, locator: () => ({ allTextContents: async () => [] }) },
    observe: async () => ({ folders: [...folders] }),
    receipt: { setup: {}, consoleErrors: [] },
    create: async () => {
      trace.push('create Session A');
      const project = { path: '/Session A' };
      folders.push(project);
      return project;
    },
    step() {},
    archive: async (folder) => {
      trace.push(`archive ${folder.path}`);
      folders.splice(folders.indexOf(folder), 1);
    },
    waitForInitialWorkspaceIndexing: async (_page, roots) => trace.push(['wait', ...roots]),
  });
  assert.deepEqual(trace, [
    ['wait', '/ordinary', '/samples', '/reference'],
    'create Session A',
    ['wait', '/ordinary'],
    'archive /ordinary',
    ['wait', '/samples'],
    'archive /samples',
  ]);
});

import assert from 'node:assert/strict';
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
  { prior = ready('old'), reloadElapsed = 0, reloadError, startupError } = {}
) {
  let now = 1000;
  const originalNow = Date.now;
  Date.now = () => now;
  t.after(() => {
    Date.now = originalNow;
  });
  let current = structuredClone(prior);
  const events = [];
  const observations = [];
  const predicates = [];
  const window = {
    electronAPI: {
      startup: {
        getState: async () => {
          if (startupError) throw startupError;
          return structuredClone(current);
        },
      },
    },
  };
  const query = (fn, args) => vm.runInNewContext(`(${fn.toString()})(...args)`, { window, args });
  const page = {
    evaluate: async (fn, ...args) => {
      events.push({ type: 'evaluate', at: now });
      return query(fn, args);
    },
    reload: async (options) => {
      events.push({ type: 'reload', at: now, options });
      assert.equal(
        options.waitUntil,
        'commit',
        'Navigation must not wait for the unrelated browser load event'
      );
      now += reloadElapsed;
      if (reloadError) throw reloadError;
    },
    waitForFunction: async (fn, arg, options) => {
      events.push({ type: 'wait', at: now, options });
      for (const state of states) {
        current = structuredClone(state);
        const value = await query(fn, [arg]);
        predicates.push(Boolean(value));
        if (value) return { jsonValue: async () => value, dispose: async () => {} };
      }
      throw new Error('Native readiness timed out');
    },
  };
  return {
    page,
    events,
    observations,
    predicates,
    observe: (value) => observations.push(structuredClone(value)),
  };
}

test('reload waits for the new fully ready native load before returning and observing success', async (t) => {
  const reload = operation();
  const fresh = ready('new');
  const f = fixture(t, [
    ready('old'),
    { ...fresh, pageLoaded: false },
    { ...fresh, shellReady: false },
    fresh,
  ]);
  const result = await reload(f.page, { timeoutMs: 100, observe: f.observe });
  assert.deepEqual(result, fresh);
  assert.deepEqual(f.predicates, [false, false, false, true]);
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
])
  test(`${name} never counts as successful restoration`, async (t) => {
    const reload = operation();
    const f = fixture(t, [state]);
    await assert.rejects(reload(f.page, { timeoutMs: 100, observe: f.observe }));
    assert.deepEqual(f.predicates, [false]);
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

test('navigation and readiness consume one deadline instead of granting a second full timeout', async (t) => {
  const reload = operation();
  const f = fixture(t, [ready('new')], { reloadElapsed: 40 });
  assert.deepEqual(await reload(f.page, { timeoutMs: 100, observe: f.observe }), ready('new'));
  const navigation = f.events.find((event) => event.type === 'reload');
  const wait = f.events.find((event) => event.type === 'wait');
  assert.ok(navigation.options.timeout > 0 && navigation.options.timeout <= 100);
  assert.ok(wait.options.timeout > 0 && wait.options.timeout <= 60);
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
  globalThis.window = { __test: { waitForWorkspaceReconcileIdle: (root) => pending.get(root).promise } };
  t.after(() => { globalThis.window = previousWindow; });
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  let ready = false;
  const page = { evaluate: (observe, args) => observe(args) };
  const waiting = subject.waitForInitialWorkspaceIndexing(page, roots).then(() => { ready = true; });
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
  globalThis.window.__test.waitForWorkspaceReconcileIdle = async () => { throw new Error('failed to index project'); };
  await assert.rejects(() => subject.waitForInitialWorkspaceIndexing(page, ['/sample-project']), /failed to index project/);
});

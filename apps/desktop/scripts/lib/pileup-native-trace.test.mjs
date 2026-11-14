import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'vitest';
import { createPileupNativeTrace } from './pileup-native-trace.mjs';

const directories = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function fixture({
  dataLossOccurred = false,
  missingMarker = false,
  diagnosticOnly = false,
} = {}) {
  const output = await mkdtemp(path.join(tmpdir(), 'pileup-trace-lifecycle-'));
  directories.push(output);
  const cdp = new EventEmitter();
  cdp.calls = [];
  cdp.events = [];
  cdp.now = 1000;
  cdp.send = async (method, args) => {
    cdp.calls.push({ method, args });
    if (method === 'Tracing.recordClockSyncMarker')
      cdp.events.push({
        name: 'clock_sync',
        ph: 'c',
        pid: 0,
        tid: 0,
        ts: cdp.now * 1000,
        args: { sync_id: args.syncId },
      });
    if (method === 'Tracing.end')
      queueMicrotask(() =>
        cdp.emit('Tracing.tracingComplete', { stream: 'trace', dataLossOccurred })
      );
    if (method === 'IO.read')
      return {
        data: JSON.stringify({
          traceEvents: missingMarker
            ? cdp.events.filter((event) => !event.name.startsWith('pileup-renderer-'))
            : cdp.events,
        }),
        eof: true,
      };
    if (method === 'Profiler.stop') return { profile: { nodes: [], samples: [] } };
    return {};
  };
  const page = {
    evaluate: async (fn, marker) => {
      if (!String(fn).includes('performance.mark(')) return;
      cdp.events.push({ name: marker, ph: 'R', pid: 41, tid: 1, ts: cdp.now * 1000 });
      return cdp.now;
    },
  };
  const capture = createPileupNativeTrace({ output, refreshHz: 120, diagnosticOnly });
  async function gesture(label, droppedAt = null) {
    const token = await capture.start({ label, cdp, page });
    if (!token) return null;
    const inputStartEpochMs = cdp.now;
    for (let index = 0; index < 120; index++) {
      const begin = inputStartEpochMs * 1000 + index * (1_000_000 / 120);
      const args = {
        layer_tree_host_id: '1',
        frame_source: 4_294_967_296,
        frame_sequence: index + 1,
      };
      const id2 = { local: `${label}-${index}` };
      cdp.events.push(
        { name: 'PipelineReporter', ph: 'b', pid: 41, tid: 1, ts: begin, id2, args },
        {
          name: 'PipelineReporter',
          ph: 'e',
          pid: 41,
          tid: 1,
          ts: begin + 1000,
          id2,
          args: { ...args, state: index === droppedAt ? 'STATE_DROPPED' : 'STATE_PRESENTED_ALL' },
        }
      );
    }
    cdp.now += 1001;
    return capture.stop({
      label,
      token,
      page,
      cdp,
      inputStartEpochMs,
      inputEndEpochMs: inputStartEpochMs + 1000,
      cadence: { durationMs: 1000 },
    });
  }
  return { output, cdp, page, capture, gesture };
}

test('owns one trace for the journey and defers stream IO until finalization', async () => {
  const f = await fixture();
  assert.equal(typeof f.capture.beginJourney, 'function');
  assert.equal(typeof f.capture.finishJourney, 'function');
  await f.capture.beginJourney(f);
  const pending = [];
  for (let index = 0; index < 14; index++) {
    const label = `gesture-${index}`;
    const token = await f.capture.start({ ...f, label });
    pending.push(await f.capture.stop({ ...f, label, token, aborted: true }));
  }
  assert.equal(f.cdp.calls.filter((call) => call.method === 'Tracing.start').length, 1);
  assert.equal(f.cdp.calls.filter((call) => call.method === 'Tracing.end').length, 0);
  assert.equal(f.cdp.calls.filter((call) => call.method === 'IO.read').length, 0);
  assert.ok(pending.every((result) => result.status === 'unqualified'));
  assert.deepEqual(await readdir(f.output), []);
  await f.capture.finishJourney(f);
  assert.equal(f.cdp.calls.filter((call) => call.method === 'Tracing.end').length, 1);
  assert.equal(f.cdp.calls.filter((call) => call.method === 'IO.read').length, 1);
  assert.ok(pending.every((result) => result.status === 'invalid'));
  await f.capture.finishJourney(f);
  assert.equal(f.cdp.calls.filter((call) => call.method === 'Tracing.end').length, 1);
});

test('keeps exact per-input presentation, display budget and dropped-frame classification', async () => {
  const f = await fixture();
  await f.capture.beginJourney(f);
  const clean = await f.gesture('clean');
  const dropped = await f.gesture('dropped', 60);
  assert.equal(clean.status, 'unqualified');
  assert.equal(dropped.status, 'unqualified');
  await f.capture.finishJourney(f);
  assert.equal(clean.status, 'valid');
  assert.equal(clean.refreshHz, 120);
  assert.equal(clean.requestedDurationMs, 1000);
  assert.equal(clean.expectedFrameCount, 120);
  assert.equal(clean.observedFrameCount, 120);
  assert.equal(clean.droppedFrames, 0);
  assert.equal(dropped.status, 'valid');
  assert.equal(dropped.droppedFrames, 1);
  assert.ok(dropped.failures.includes('surface-pipeline-dropped:1'));
  const files = await readdir(f.output);
  assert.equal(files.filter((file) => file.endsWith('.trace.json.gz')).length, 1);
  assert.equal(files.filter((file) => file.endsWith('.presentation.json')).length, 2);
});

for (const options of [{ missingMarker: true }, { dataLossOccurred: true }]) {
  test(`rejects incomplete continuous trace evidence ${JSON.stringify(options)}`, async () => {
    const f = await fixture(options);
    await f.capture.beginJourney(f);
    const result = await f.gesture('input');
    await f.capture.finishJourney(f);
    assert.equal(result.status, 'invalid');
    assert.ok(result.failures.length > 0);
    assert.ok((await readdir(f.output)).includes('journey.trace.json.gz'));
  });
}

test('never promotes an unfinished input window to valid presentation', async () => {
  const f = await fixture();
  await f.capture.beginJourney(f);
  const token = await f.capture.start({ ...f, label: 'unfinished' });
  await f.capture.finishJourney(f);
  assert.equal(token.result.status, 'invalid');
  assert.ok(token.result.failures.includes('native-input-window-aborted-or-missing'));
});

test('fails all pending results closed and retains raw evidence after finalization fails', async () => {
  const f = await fixture();
  await f.capture.beginJourney(f);
  const first = await f.gesture('first');
  const second = await f.gesture('second');
  f.page.evaluate = async () => {
    throw new Error('renderer disconnected');
  };
  await assert.rejects(f.capture.finishJourney(f), /renderer disconnected/);
  assert.equal(first.status, 'invalid');
  assert.equal(second.status, 'invalid');
  assert.ok((await readdir(f.output)).includes('journey.trace.json.gz'));
  await assert.rejects(f.capture.finishJourney(f), /renderer disconnected/);
  assert.equal(f.cdp.calls.filter((call) => call.method === 'Tracing.end').length, 1);
});

test('preserves the optional first-zoom CPU trace as unqualified diagnostics', async () => {
  const f = await fixture({ diagnosticOnly: true });
  await f.capture.beginJourney(f);
  assert.equal(await f.gesture('pan'), null);
  const result = await f.gesture('zoom-26612bp');
  await f.capture.finishJourney(f);
  assert.equal(f.cdp.calls.filter((call) => call.method === 'Tracing.start').length, 1);
  assert.equal(f.cdp.calls.filter((call) => call.method === 'Tracing.end').length, 1);
  assert.equal(f.cdp.calls.filter((call) => call.method === 'Profiler.start').length, 1);
  assert.equal(result.status, 'unqualified');
  assert.ok(result.failures.includes('diagnostic-only-no-declared-display-target'));
});

test('requires an owned active journey and an explicit actual display target', async () => {
  const f = await fixture();
  assert.throws(() => createPileupNativeTrace({ output: f.output }), /Declare the actual/);
  await assert.rejects(f.capture.start({ ...f, label: 'before-journey' }), /not active/);
  await f.capture.beginJourney(f);
  await assert.rejects(f.capture.finishJourney({ page: f.page, cdp: {} }), /another CDP/);
  await f.capture.finishJourney(f);
});

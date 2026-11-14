import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  CHROMIUM_DISPLAY_FRAME_EVENT_SOURCE,
  PIPELINE_PRESENTATION_STATE,
  parseChromiumPresentationTrace,
  summarizeChromiumDisplayClockTrace,
} from './chromium-presentation-trace.mjs';

const PID = 41;
const SURFACE = 'surface-7';
const START_SYNC_ID = 'measurement-start';
const END_SYNC_ID = 'measurement-end';
const START_US = 1_000_000;
const PERIOD_US = 8_333;
const FRAME_COUNT = 121;
const END_US = START_US + PERIOD_US * (FRAME_COUNT - 1);

function marker(syncId, ts) {
  return { name: 'clock_sync', ph: 'c', pid: 0, tid: 0, ts, args: { sync_id: syncId } };
}

function processMetadata(pid, processName, mainThreadName) {
  return [
    { name: 'process_name', ph: 'M', pid, tid: 0, ts: 0, args: { name: processName } },
    { name: 'thread_name', ph: 'M', pid, tid: 1, ts: 0, args: { name: mainThreadName } },
  ];
}

function pipelinePair({
  pid = PID,
  surfaceId = SURFACE,
  id = '0x1',
  scope = 'local',
  state = 'STATE_PRESENTED_ALL',
  beginUs = START_US + 1_000,
  endUs = beginUs + 2_000,
  hasMissingContent = false,
  frameSequence = 1,
  diagnostics = {},
} = {}) {
  return [
    {
      name: 'PipelineReporter',
      ph: 'b',
      pid,
      tid: 9,
      ts: beginUs,
      id2: { [scope]: id },
      args: { layer_tree_host_id: surfaceId, frame_sequence: frameSequence },
    },
    {
      name: 'PipelineReporter',
      ph: 'e',
      pid,
      tid: 9,
      ts: endUs,
      id2: { [scope]: id },
      args: {
        layer_tree_host_id: surfaceId,
        state,
        has_missing_content: hasMissingContent,
        frame_sequence: frameSequence,
        ...diagnostics,
      },
    },
  ];
}

function modernPipelinePair(options = {}) {
  const [begin, end] = pipelinePair(options);
  return [
    { ...begin, args: { frame_reporter: { ...begin.args, ...end.args } } },
    { ...end, args: {} },
  ];
}

function framePresented(nativeTimestampUs, { pid = PID, eventTs = nativeTimestampUs } = {}) {
  return {
    name: 'FramePresented',
    ph: 'R',
    pid,
    tid: 9,
    ts: eventTs,
    args: { presentation_timestamp_us: nativeTimestampUs },
  };
}

function newPresentationFeedback(nativeTimestampUs, { pid = PID, eventTs = 17 } = {}) {
  return {
    name: 'NewPresentationFeedbackTimeStamps',
    ph: 'i',
    pid,
    tid: 9,
    ts: eventTs,
    args: { data: { presentation_timestamp_us: nativeTimestampUs } },
  };
}

function frameTimes({ omit = new Set() } = {}) {
  const times = [];
  for (let index = 0; index < FRAME_COUNT; index += 1) {
    if (!omit.has(index)) times.push(START_US + index * PERIOD_US);
  }
  return times;
}

function envelope(events, dataLossOccurred = false) {
  return {
    traceEvents: [marker(START_SYNC_ID, START_US), ...events, marker(END_SYNC_ID, END_US)],
    dataLossOccurred,
  };
}

function displayFrame(timestampUs, overrides = {}) {
  return {
    args: {},
    ...CHROMIUM_DISPLAY_FRAME_EVENT_SOURCE,
    pid: 79253,
    s: 't',
    tid: 30979,
    ts: timestampUs,
    ...overrides,
  };
}

function summarizeDisplay(events, options = {}) {
  return summarizeChromiumDisplayClockTrace(envelope(events), {
    measurementStartSyncId: START_SYNC_ID,
    measurementEndSyncId: END_SYNC_ID,
    ...options,
  });
}

function parse(input, options = {}) {
  return parseChromiumPresentationTrace(input, {
    measurementStartSyncId: START_SYNC_ID,
    measurementEndSyncId: END_SYNC_ID,
    targetPid: PID,
    targetSurfaceId: SURFACE,
    ...options,
  });
}

test('reads Chromium 150 begin-event reporter payloads with the same outcomes and diagnostics', () => {
  const options = frameTimes().map((beginUs, index) => ({
    id: `0x${index.toString(16)}`,
    surfaceId: 2,
    frameSequence: index + 1,
    beginUs,
    state: index % 2 === 0 ? 'STATE_PRESENTED_ALL' : 'STATE_NO_UPDATE_DESIRED',
    diagnostics: {
      frame_source: 4_294_967_296,
      affects_smoothness: true,
      frame_type: 'NON_MISSED',
      frame_skipped_reason_v4: 'SKIPPED_REASON_WAITING_ON_MAIN',
      scroll_state: 'SCROLL_MAIN_THREAD',
      has_high_latency: false,
      high_latency_contribution_stage: ['StartDrawToSwapStart'],
      checkerboarded_needs_raster: false,
      checkerboarded_needs_record: false,
      surface_frame_trace_id: 701,
      display_trace_id: '207570000000000001',
    },
  }));
  const presentations = frameTimes().map((timestampUs) => framePresented(timestampUs));
  const older = parse(envelope([...options.flatMap(pipelinePair), ...presentations]), {
    targetSurfaceId: 2,
  });
  const modern = parse(envelope([...options.flatMap(modernPipelinePair), ...presentations]), {
    targetSurfaceId: 2,
  });

  assert.equal(older.status, 'valid');
  assert.equal(modern.status, 'valid');
  assert.deepEqual(modern, older);
  assert.equal(modern.pipeline.reporters.length, FRAME_COUNT);
  assert.equal(modern.pipeline.stateCounts.PRESENTED_ALL, 61);
  assert.equal(modern.pipeline.stateCounts.NO_UPDATE, 60);
  assert.equal(modern.pipeline.reporters[0].frameSource, 4_294_967_296);
  assert.equal(modern.pipeline.reporters[0].frameSequence, 1);
});

for (const { name, options, failure } of [
  { name: 'dropped', options: { state: 'STATE_DROPPED' }, failure: 'pipeline-dropped' },
  {
    name: 'partial',
    options: { state: 'STATE_PRESENTED_PARTIAL' },
    failure: 'pipeline-presented-partial',
  },
  { name: 'missing content', options: { hasMissingContent: true }, failure: 'pipeline-missing-content' },
]) {
  test(`keeps Chromium 150 ${name} outcomes as hard failures`, () => {
    const result = parse(envelope([
      ...modernPipelinePair(options),
      ...frameTimes().map((timestampUs) => framePresented(timestampUs)),
    ]));

    assert.equal(result.status, 'valid');
    assert.equal(result.claimStatus, 'fail');
    assert.ok(result.claimFailures.includes(failure));
  });
}

for (const { field, value, failure } of [
  { field: 'state', value: 'STATE_DROPPED', failure: 'pipeline-reporter-state-missing-or-ambiguous' },
  { field: 'layer_tree_host_id', value: 'another-surface', failure: 'pipeline-reporter-surface-missing-or-ambiguous' },
]) {
  test(`rejects conflicting old and new reporter aliases for ${field}`, () => {
    const pair = modernPipelinePair();
    pair[0].args.chrome_frame_reporter = { [field]: value };
    const result = parse(envelope([
      ...pair,
      ...frameTimes().map((timestampUs) => framePresented(timestampUs)),
    ]));

    assert.equal(result.status, 'invalid');
    assert.ok(result.failures.includes(failure));
  });
}

test('does not represent rounded numeric diagnostic trace identifiers as exact identities', () => {
  const result = parse(envelope([
    ...pipelinePair({
      diagnostics: {
        surface_frame_trace_id: Number.MAX_SAFE_INTEGER + 1,
        display_trace_id: Number.MAX_SAFE_INTEGER + 1,
      },
    }),
    ...frameTimes().map((timestampUs) => framePresented(timestampUs)),
  ]));

  assert.equal(result.status, 'valid');
  assert.equal(result.claimStatus, 'pass');
  assert.equal(result.pipeline.reporters[0].surfaceFrameTraceId, null);
  assert.equal(result.pipeline.reporters[0].displayTraceId, null);
});

test('parses clean 120 Hz native presentation cadence and keeps pipeline diagnostics separate', () => {
  const events = [
    ...pipelinePair(),
    ...frameTimes().map((timestampUs) =>
      framePresented(timestampUs, { eventTs: timestampUs + 5_000_000 })
    ),
  ];

  const result = parse(envelope(events));

  assert.equal(result.status, 'valid');
  assert.equal(result.claimStatus, 'pass');
  assert.equal(result.presentation.nativeTimestampsUs.length, FRAME_COUNT);
  assert.equal(result.presentation.windowCoverageFraction, 1);
  assert.ok(result.presentation.intervalsMs.every((value) => Math.abs(value - 8.333) < 1e-9));
  assert.deepEqual(result.presentation.timestampSources, [
    'FramePresented.explicit-native-timestamp',
  ]);
  assert.equal(result.pipeline.stateCounts[PIPELINE_PRESENTATION_STATE.PRESENTED_ALL], 1);
  assert.equal(result.gpu.programLinkCount, 0);
});

test('reports GPU program links inside the scored gesture window only', () => {
  const events = [
    ...pipelinePair(),
    ...frameTimes().map((timestampUs) => framePresented(timestampUs)),
    {
      name: 'GLES2DecoderPassthroughImpl::DoLinkProgram',
      cat: 'gpu',
      ph: 'X',
      ts: START_US - 1,
      dur: 91,
      pid: 7,
      tid: 8,
    },
    {
      name: 'GLES2DecoderPassthroughImpl::DoLinkProgram',
      cat: 'gpu',
      ph: 'X',
      ts: START_US + 123_000,
      dur: 73,
      pid: 7,
      tid: 8,
    },
    {
      name: 'GLES2DecoderPassthroughImpl::DoLinkProgram',
      cat: 'gpu',
      ph: 'X',
      ts: END_US + 1,
      dur: 43,
      pid: 7,
      tid: 8,
    },
  ];

  const result = parse(envelope(events));

  assert.equal(result.status, 'valid');
  assert.equal(result.gpu.programLinkCount, 1);
  assert.deepEqual(result.gpu.programLinks, [
    { timestampUs: START_US + 123_000, durationUs: 73, pid: 7, tid: 8 },
  ]);
});

test('exposes native graphics context waits overlapping dropped frames without excusing the drops', () => {
  const nativeWait = {
    name: 'GLContextEGL::MakeCurrent', cat: 'gpu', ph: 'X',
    pid: 7, tid: 1, ts: START_US + 1_000, dur: 78_688, tdur: 83,
    args: { context: '0x3', surface: 'gpu-surface' },
  };
  const events = [
    ...processMetadata(7, 'GPU Process', 'CrGpuMain'),
    ...pipelinePair({ state: 'STATE_DROPPED', beginUs: START_US + 20_000 }),
    ...pipelinePair({ id: 'second-dropped-reporter', frameSequence: 2,
      state: 'STATE_DROPPED', beginUs: START_US + 30_000 }),
    ...pipelinePair({ id: 'second-presented-reporter', frameSequence: 2,
      state: 'STATE_PRESENTED_ALL', beginUs: START_US + 30_000 }),
    ...frameTimes().map((timestampUs) => framePresented(timestampUs)),
    nativeWait,
    { ...nativeWait, pid: PID },
    { ...nativeWait, ts: END_US + 1 },
    { ...nativeWait, ts: START_US - 100_000, dur: 1_000 },
    { ...nativeWait, dur: -1 },
  ];
  const result = parse(envelope(events));
  assert.equal(result.status, 'valid');
  assert.equal(result.claimStatus, 'fail');
  assert.equal(result.pipeline.stateCounts.DROPPED, 2);
  assert.deepEqual(result.gpu.contextMakeCurrentEvents, [{
    timestampUs: nativeWait.ts,
    durationMs: 78.688,
    threadCpuMs: 0.083,
    pid: 7,
    tid: 1,
    overlappingFailedFrameSequences: [1],
  }]);
});

test('uses only explicitly presented PipelineReporter terminations when Electron omits native events', () => {
  const events = [];
  for (let index = 0; index < FRAME_COUNT; index += 1) {
    const endUs = START_US + index * PERIOD_US;
    events.push(
      ...pipelinePair({
        id: `presented-${index}`,
        state: 'STATE_PRESENTED_ALL',
        beginUs: Math.max(START_US, endUs - 2_000),
        endUs,
        frameSequence: index,
      })
    );
  }
  events.push(
    ...pipelinePair({
      id: 'dropped-control',
      state: 'STATE_DROPPED',
      beginUs: START_US + 20_000,
      endUs: START_US + 29_999,
      frameSequence: FRAME_COUNT,
    })
  );

  const result = parse(envelope(events));

  assert.equal(result.status, 'valid', JSON.stringify(result));
  assert.equal(result.claimStatus, 'fail');
  assert.deepEqual(result.claimFailures, ['pipeline-dropped']);
  assert.equal(result.presentation.nativeTimestampsUs.length, FRAME_COUNT);
  assert.ok(result.presentation.intervalsMs.every((value) => value === 8.333));
  assert.deepEqual(result.presentation.timestampSources, [
    'PipelineReporter.presented-frame-termination-timestamp',
  ]);
  assert.ok(!result.presentation.nativeTimestampsUs.includes(START_US + 29_999));
});

test('counts an intentional no-update tail toward target-surface outcome-window coverage', () => {
  const events = [];
  const presentedCount = 90;
  for (let index = 0; index < FRAME_COUNT; index += 1) {
    const beginUs = START_US + index * PERIOD_US;
    events.push(
      ...pipelinePair({
        id: `outcome-${index}`,
        state:
          index < presentedCount ? 'STATE_PRESENTED_ALL' : 'STATE_NO_UPDATE_DESIRED',
        beginUs,
        endUs: Math.min(END_US, beginUs + 2_000),
        frameSequence: index,
      })
    );
  }

  const result = parse(envelope(events));

  assert.equal(result.status, 'valid', JSON.stringify(result));
  assert.equal(result.claimStatus, 'pass');
  assert.equal(result.presentation.nativeTimestampsUs.length, presentedCount);
  assert.ok(result.presentation.presentedWindowCoverageFraction < 0.95);
  assert.equal(result.presentation.windowCoverageFraction, 1);
  assert.equal(
    result.presentation.windowCoverageSource,
    'PipelineReporter-qualified-outcome-window'
  );
  assert.equal(
    result.pipeline.stateCounts[PIPELINE_PRESENTATION_STATE.NO_UPDATE],
    FRAME_COUNT - presentedCount
  );
});

test('attributes a terminal outcome to the window that issued its refresh request', () => {
  const events = [];
  for (let index = 0; index < FRAME_COUNT; index += 1) {
    const beginUs = START_US + index * PERIOD_US;
    events.push(
      ...pipelinePair({
        id: `in-window-${index}`,
        beginUs,
        endUs: beginUs + (index === FRAME_COUNT - 1 ? 4_000 : 2_000),
        frameSequence: index,
      })
    );
  }
  events.push(
    ...pipelinePair({
      id: 'pre-window-finishes-inside',
      beginUs: START_US - 1_000,
      endUs: START_US + 1_000,
      frameSequence: 999,
    })
  );

  const result = parse(envelope(events));

  assert.equal(result.status, 'valid', JSON.stringify(result));
  assert.equal(result.pipeline.reporters.length, FRAME_COUNT);
  assert.equal(result.pipeline.reporters.at(-1).frameSequence, FRAME_COUNT - 1);
  assert.equal(result.pipeline.reporters.at(-1).endTraceTimestampUs, END_US + 4_000);
  assert.ok(!result.pipeline.reporters.some((reporter) => reporter.frameSequence === 999));
});

test('reports a 100 ms presentation gap and dropped reporter without mixing dropped latency into cadence', () => {
  const omitted = new Set(Array.from({ length: 11 }, (_, index) => 50 + index));
  const events = [
    ...pipelinePair({
      id: 'drop',
      state: 'STATE_DROPPED',
      beginUs: START_US + 48 * PERIOD_US,
      endUs: START_US + 48 * PERIOD_US + 100_000,
    }),
    ...frameTimes({ omit: omitted }).map((timestampUs) => framePresented(timestampUs)),
  ];

  const result = parse(envelope(events));

  assert.equal(result.status, 'valid');
  assert.equal(result.claimStatus, 'fail');
  assert.deepEqual(result.claimFailures, ['pipeline-dropped']);
  assert.equal(result.pipeline.stateCounts[PIPELINE_PRESENTATION_STATE.DROPPED], 1);
  assert.deepEqual(result.pipeline.latencyByStateMs[PIPELINE_PRESENTATION_STATE.DROPPED], [100]);
  assert.equal(result.presentation.nativeTimestampsUs.length, FRAME_COUNT - omitted.size);
  assert.equal(Math.max(...result.presentation.intervalsMs), 99.996);
  assert.ok(!result.presentation.nativeTimestampsUs.includes(events[1].ts));
});

test('pairs PipelineReporter by pid plus id2 scope despite cross-process and local/global collisions', () => {
  const events = [
    pipelinePair({ pid: PID, id: '0xdead', scope: 'local', state: 'STATE_PRESENTED_ALL' })[0],
    pipelinePair({ pid: 99, id: '0xdead', scope: 'local', state: 'STATE_DROPPED' })[0],
    pipelinePair({ pid: PID, id: '0xdead', scope: 'global', state: 'STATE_NO_UPDATE_DESIRED' })[0],
    pipelinePair({ pid: 99, id: '0xdead', scope: 'local', state: 'STATE_DROPPED' })[1],
    pipelinePair({ pid: PID, id: '0xdead', scope: 'global', state: 'STATE_NO_UPDATE_DESIRED' })[1],
    pipelinePair({ pid: PID, id: '0xdead', scope: 'local', state: 'STATE_PRESENTED_ALL' })[1],
    ...frameTimes().map((timestampUs) => framePresented(timestampUs)),
  ];

  const result = parse(envelope(events));

  assert.equal(result.status, 'valid');
  assert.equal(result.claimStatus, 'pass');
  assert.equal(result.pipeline.reporters.length, 2);
  assert.equal(result.pipeline.stateCounts[PIPELINE_PRESENTATION_STATE.PRESENTED_ALL], 1);
  assert.equal(result.pipeline.stateCounts[PIPELINE_PRESENTATION_STATE.NO_UPDATE], 1);
  assert.equal(result.pipeline.stateCounts[PIPELINE_PRESENTATION_STATE.DROPPED], 0);
  assert.deepEqual(
    result.pipeline.reporters.map((reporter) => reporter.idScope).sort(),
    ['global', 'local']
  );
});

test('keeps PRESENTED_PARTIAL and missing-content diagnostics distinct from native cadence', () => {
  const events = [
    ...pipelinePair({
      id: 'partial',
      state: 'STATE_PRESENTED_PARTIAL',
      frameSequence: 2,
      diagnostics: {
        reason: 'REASON_DISPLAY_COMPOSITOR',
        scroll_state: 'SCROLL_MAIN_THREAD',
        has_high_latency: true,
        high_latency_contribution_stage: ['StartDrawToSwapStart'],
        checkerboarded_needs_raster: true,
        checkerboarded_needs_record: false,
        surface_frame_trace_id: 701,
        display_trace_id: 702,
      },
    }),
    ...pipelinePair({
      id: 'missing',
      state: 'STATE_PRESENTED_ALL',
      hasMissingContent: true,
      beginUs: START_US + 10_000,
      endUs: START_US + 12_000,
      frameSequence: 3,
    }),
    ...frameTimes().map((timestampUs) => framePresented(timestampUs)),
  ];

  const result = parse(envelope(events));

  assert.equal(result.status, 'valid');
  assert.equal(result.claimStatus, 'fail');
  assert.deepEqual(result.claimFailures, [
    'pipeline-presented-partial',
    'pipeline-missing-content',
  ]);
  assert.equal(result.pipeline.stateCounts[PIPELINE_PRESENTATION_STATE.PRESENTED_PARTIAL], 1);
  assert.deepEqual(
    {
      reason: result.pipeline.reporters[0].reason,
      scrollState: result.pipeline.reporters[0].scrollState,
      hasHighLatency: result.pipeline.reporters[0].hasHighLatency,
      highLatencyContributionStages:
        result.pipeline.reporters[0].highLatencyContributionStages,
      checkerboardedNeedsRaster: result.pipeline.reporters[0].checkerboardedNeedsRaster,
      checkerboardedNeedsRecord: result.pipeline.reporters[0].checkerboardedNeedsRecord,
      surfaceFrameTraceId: result.pipeline.reporters[0].surfaceFrameTraceId,
      displayTraceId: result.pipeline.reporters[0].displayTraceId,
    },
    {
      reason: 'REASON_DISPLAY_COMPOSITOR',
      scrollState: 'SCROLL_MAIN_THREAD',
      hasHighLatency: true,
      highLatencyContributionStages: ['StartDrawToSwapStart'],
      checkerboardedNeedsRaster: true,
      checkerboardedNeedsRecord: false,
      surfaceFrameTraceId: 701,
      displayTraceId: 702,
    }
  );
  assert.equal(result.pipeline.missingContentCount, 1);
  assert.ok(result.presentation.intervalsMs.every((value) => value === 8.333));
});

test('preserves the current Chromium backfill skip reason', () => {
  const events = [
    ...pipelinePair({
      id: 'backfill',
      state: 'STATE_DROPPED',
      diagnostics: {
        frame_type: 'BACKFILL',
        frame_skipped_reason_v4: 'SKIPPED_REASON_WAITING_ON_MAIN',
      },
    }),
    ...frameTimes().map((timestampUs) => framePresented(timestampUs)),
  ];

  const result = parse(envelope(events));

  assert.equal(result.status, 'valid');
  assert.equal(result.claimStatus, 'fail');
  assert.equal(result.pipeline.reporters[0].frameType, 'BACKFILL');
  assert.equal(
    result.pipeline.reporters[0].reason,
    'SKIPPED_REASON_WAITING_ON_MAIN'
  );
});

test('trims NewPresentationFeedbackTimeStamps to explicit clock-sync boundaries using native fields', () => {
  const events = [
    ...pipelinePair(),
    newPresentationFeedback(START_US - PERIOD_US, { eventTs: START_US + 100 }),
    ...frameTimes().map((timestampUs) =>
      newPresentationFeedback(timestampUs, { eventTs: END_US + 10_000_000 })
    ),
    newPresentationFeedback(END_US + PERIOD_US, { eventTs: START_US + 200 }),
    ...pipelinePair({
      id: 'outside-drop',
      state: 'STATE_DROPPED',
      beginUs: END_US + 1_000,
      endUs: END_US + 2_000,
    }),
  ];

  const result = parse(envelope(events));

  assert.equal(result.status, 'valid');
  assert.equal(result.claimStatus, 'pass');
  assert.equal(result.presentation.nativeTimestampsUs.length, FRAME_COUNT);
  assert.equal(result.presentation.firstNativeTimestampUs, START_US);
  assert.equal(result.presentation.lastNativeTimestampUs, END_US);
  assert.deepEqual(result.presentation.timestampSources, [
    'NewPresentationFeedbackTimeStamps.explicit-native-timestamp',
  ]);
  assert.equal(result.pipeline.stateCounts[PIPELINE_PRESENTATION_STATE.DROPPED], 0);
});

test('rejects traces when CDP reports data loss', () => {
  const result = parse(envelope([...pipelinePair(), ...frameTimes().map(framePresented)], true));

  assert.equal(result.status, 'invalid');
  assert.deepEqual(result.failures, ['trace-data-loss']);
});

test('rejects nonmonotonic native presentation time and less than 95 percent window coverage', () => {
  const nonmonotonicTimes = frameTimes();
  [nonmonotonicTimes[60], nonmonotonicTimes[61]] = [
    nonmonotonicTimes[61],
    nonmonotonicTimes[60],
  ];
  const nonmonotonic = parse(
    envelope([...pipelinePair(), ...nonmonotonicTimes.map((timestampUs) => framePresented(timestampUs))])
  );
  const shortPrefix = parse(
    envelope([
      ...pipelinePair(),
      ...frameTimes()
        .slice(0, 80)
        .map((timestampUs) => framePresented(timestampUs)),
    ])
  );

  assert.equal(nonmonotonic.status, 'invalid');
  assert.ok(
    nonmonotonic.failures.includes('nonmonotonic-native-presentation-timestamps:FramePresented')
  );
  assert.equal(shortPrefix.status, 'invalid');
  assert.ok(shortPrefix.failures.includes('insufficient-native-presentation-window-coverage'));
  assert.ok(shortPrefix.presentation.windowCoverageFraction < 0.95);
});

test('rejects missing or ambiguous process and surface selection', () => {
  const ambiguousProcess = parseChromiumPresentationTrace(
    envelope([
      ...pipelinePair({ pid: PID, id: 'p1' }),
      ...pipelinePair({ pid: 99, id: 'p2' }),
      ...frameTimes().map((timestampUs) => framePresented(timestampUs)),
    ]),
    {
      measurementStartSyncId: START_SYNC_ID,
      measurementEndSyncId: END_SYNC_ID,
    }
  );
  const missingSurfaceEvents = pipelinePair({ id: 'no-surface' }).map((event) => {
    const copy = structuredClone(event);
    delete copy.args.layer_tree_host_id;
    return copy;
  });
  const missingSurface = parse(
    envelope([
      ...missingSurfaceEvents,
      ...frameTimes().map((timestampUs) => framePresented(timestampUs)),
    ])
  );
  const ambiguousSurface = parse(
    envelope([
      ...pipelinePair({ id: 'surface-a', surfaceId: SURFACE }),
      ...pipelinePair({
        id: 'surface-b',
        surfaceId: 'surface-8',
        beginUs: START_US + 10_000,
        endUs: START_US + 12_000,
      }),
      ...frameTimes().map((timestampUs) => framePresented(timestampUs)),
    ])
  );

  assert.equal(ambiguousProcess.status, 'invalid');
  assert.ok(ambiguousProcess.failures.includes('target-process-ambiguous'));
  assert.equal(missingSurface.status, 'invalid');
  assert.ok(
    missingSurface.failures.includes('pipeline-reporter-surface-missing-or-ambiguous') ||
      missingSurface.failures.includes('target-surface-missing')
  );
  assert.equal(ambiguousSurface.status, 'invalid');
  assert.ok(ambiguousSurface.failures.includes('presentation-surface-missing-or-ambiguous'));
});

test('binds an implicit target to the traced Renderer instead of the Browser compositor', () => {
  const browserPid = 99;
  const result = parseChromiumPresentationTrace(
    envelope([
      ...processMetadata(browserPid, 'Browser', 'CrBrowserMain'),
      ...processMetadata(PID, 'Renderer', 'CrRendererMain'),
      ...pipelinePair({
        pid: browserPid,
        surfaceId: 'browser-surface',
        id: 'browser-pipeline',
      }),
      ...pipelinePair({ id: 'renderer-pipeline' }),
      ...frameTimes().map((timestampUs) => framePresented(timestampUs)),
    ]),
    {
      measurementStartSyncId: START_SYNC_ID,
      measurementEndSyncId: END_SYNC_ID,
    }
  );

  assert.equal(result.status, 'valid', JSON.stringify(result));
  assert.equal(result.target.pid, PID);
  assert.equal(result.target.surfaceId, SURFACE);
  assert.equal(result.pipeline.processReporters.length, 1);
});

test('fails closed when trace metadata identifies multiple renderer processes', () => {
  const secondRendererPid = 99;
  const result = parseChromiumPresentationTrace(
    envelope([
      ...processMetadata(PID, 'Renderer', 'CrRendererMain'),
      ...processMetadata(secondRendererPid, 'Renderer', 'CrRendererMain'),
      ...pipelinePair({ id: 'renderer-one' }),
      ...pipelinePair({
        pid: secondRendererPid,
        surfaceId: 'surface-8',
        id: 'renderer-two',
      }),
      ...frameTimes().map((timestampUs) => framePresented(timestampUs)),
    ]),
    {
      measurementStartSyncId: START_SYNC_ID,
      measurementEndSyncId: END_SYNC_ID,
    }
  );

  assert.equal(result.status, 'invalid');
  assert.ok(result.failures.includes('target-process-ambiguous'));
});

test('qualifies genuine Display::FrameDisplayed events as a global display-clock diagnostic', () => {
  const result = summarizeDisplay(frameTimes().map((timestampUs) => displayFrame(timestampUs)));

  assert.equal(result.status, 'valid', JSON.stringify(result));
  assert.equal(result.source.name, 'Display::FrameDisplayed');
  assert.equal(result.source.pid, 79253);
  assert.equal(result.source.tid, 30979);
  assert.equal(result.frameCount, FRAME_COUNT);
  assert.equal(result.intervalCount, FRAME_COUNT - 1);
  assert.equal(result.windowCoverageFraction, 1);
  assert.ok(Math.abs(result.presentedFps - 120.0048) < 0.0001);
  assert.ok(result.rawDeltasMs.every((value) => Math.abs(value - 8.333) < 1e-9));
});

test('collapses an exact-equal same-source display timestamp to one physical vsync', () => {
  const timestamps = frameTimes();
  timestamps.splice(61, 0, timestamps[60]);
  const result = summarizeDisplay(
    timestamps.map((timestampUs) => displayFrame(timestampUs))
  );

  assert.equal(result.status, 'valid', JSON.stringify(result));
  assert.equal(result.displayFrameEventCount, FRAME_COUNT + 1);
  assert.equal(result.duplicateTimestampCount, 1);
  assert.equal(result.frameCount, FRAME_COUNT);
  assert.equal(result.intervalCount, FRAME_COUNT - 1);
  assert.ok(result.rawDeltasMs.every((value) => value > 0));
});

test('invalidates missing, nonmonotonic, and truncated global display-clock streams', () => {
  const missing = summarizeDisplay([]);
  const nonmonotonicTimes = frameTimes();
  [nonmonotonicTimes[60], nonmonotonicTimes[61]] = [
    nonmonotonicTimes[61],
    nonmonotonicTimes[60],
  ];
  const nonmonotonic = summarizeDisplay(
    nonmonotonicTimes.map((timestampUs) => displayFrame(timestampUs))
  );
  const truncated = summarizeDisplay(
    frameTimes()
      .slice(0, 80)
      .map((timestampUs) => displayFrame(timestampUs))
  );

  assert.equal(missing.status, 'invalid');
  assert.ok(missing.failures.includes('insufficient-display-frame-timestamps'));
  assert.equal(nonmonotonic.status, 'invalid');
  assert.ok(nonmonotonic.failures.includes('nonmonotonic-display-frame-timestamps'));
  assert.equal(truncated.status, 'invalid');
  assert.ok(truncated.failures.includes('insufficient-display-frame-window-coverage'));
});

test('invalidates same-name trace events that do not match the proven Chromium producer', () => {
  const wrongCategory = summarizeDisplay(
    frameTimes().map((timestampUs) =>
      displayFrame(timestampUs, { cat: 'benchmark,viz,unqualified-display-source' })
    )
  );
  const wrongPhase = summarizeDisplay(
    frameTimes().map((timestampUs) => displayFrame(timestampUs, { ph: 'X' }))
  );
  const ambiguousThread = summarizeDisplay([
    ...frameTimes().map((timestampUs) => displayFrame(timestampUs)),
    displayFrame(START_US + PERIOD_US / 2, { tid: 99 }),
  ]);

  assert.equal(wrongCategory.status, 'invalid');
  assert.ok(wrongCategory.failures.includes('display-frame-source-unqualified'));
  assert.equal(wrongPhase.status, 'invalid');
  assert.ok(wrongPhase.failures.includes('display-frame-source-unqualified'));
  assert.equal(ambiguousThread.status, 'invalid');
  assert.ok(ambiguousThread.failures.includes('display-frame-source-ambiguous'));
});

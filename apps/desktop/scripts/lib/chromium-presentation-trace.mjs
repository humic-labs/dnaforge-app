
export const PIPELINE_PRESENTATION_STATE = Object.freeze({
  PRESENTED_ALL: 'PRESENTED_ALL',
  PRESENTED_PARTIAL: 'PRESENTED_PARTIAL',
  DROPPED: 'DROPPED',
  NO_UPDATE: 'NO_UPDATE',
});

const PIPELINE_BEGIN_PHASES = new Set(['b', 'B', 'S']);
const PIPELINE_END_PHASES = new Set(['e', 'E', 'F']);
const FRAME_PRESENTED_TS_PHASES = new Set(['R', 'i', 'I']);
const GPU_PROGRAM_LINK_EVENT = 'GLES2DecoderPassthroughImpl::DoLinkProgram';

export const CHROMIUM_DISPLAY_FRAME_EVENT_SOURCE = Object.freeze({
  cat: 'benchmark,viz,disabled-by-default-display.framedisplayed',
  name: 'Display::FrameDisplayed',
  ph: 'I',
});

const NUMERIC_PIPELINE_STATES = new Map([
  [0, PIPELINE_PRESENTATION_STATE.NO_UPDATE],
  [1, PIPELINE_PRESENTATION_STATE.PRESENTED_ALL],
  [2, PIPELINE_PRESENTATION_STATE.PRESENTED_PARTIAL],
  [3, PIPELINE_PRESENTATION_STATE.DROPPED],
]);

const STRING_PIPELINE_STATES = new Map([
  ['STATE_NO_UPDATE_DESIRED', PIPELINE_PRESENTATION_STATE.NO_UPDATE],
  ['NO_UPDATE_DESIRED', PIPELINE_PRESENTATION_STATE.NO_UPDATE],
  ['NO_UPDATE', PIPELINE_PRESENTATION_STATE.NO_UPDATE],
  ['STATE_PRESENTED_ALL', PIPELINE_PRESENTATION_STATE.PRESENTED_ALL],
  ['PRESENTED_ALL', PIPELINE_PRESENTATION_STATE.PRESENTED_ALL],
  ['STATE_PRESENTED_PARTIAL', PIPELINE_PRESENTATION_STATE.PRESENTED_PARTIAL],
  ['PRESENTED_PARTIAL', PIPELINE_PRESENTATION_STATE.PRESENTED_PARTIAL],
  ['STATE_DROPPED', PIPELINE_PRESENTATION_STATE.DROPPED],
  ['DROPPED', PIPELINE_PRESENTATION_STATE.DROPPED],
]);

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function valueAt(object, path) {
  let value = object;
  for (const key of path) {
    if (value === null || typeof value !== 'object') return undefined;
    value = value[key];
  }
  return value;
}

function valuesAt(object, paths) {
  const values = [];
  for (const path of paths) {
    const value = valueAt(object, path);
    if (value !== undefined) values.push(value);
  }
  return values;
}

function unique(values) {
  return [...new Set(values)];
}

function metadataName(event) {
  if (event?.ph !== 'M' || !Number.isSafeInteger(event.pid)) return null;
  const name = event?.args?.name;
  return typeof name === 'string' && name.trim().length > 0 ? name.trim() : null;
}

function rendererProcessPids(events, candidatePids) {
  const candidateSet = new Set(candidatePids);
  const processNames = new Map();
  const rendererMainThreadPids = new Set();

  for (const event of events) {
    if (!candidateSet.has(event?.pid)) continue;
    const name = metadataName(event);
    if (name === null) continue;
    if (event.name === 'process_name') {
      const names = processNames.get(event.pid) ?? new Set();
      names.add(name.toLowerCase());
      processNames.set(event.pid, names);
    } else if (event.name === 'thread_name' && name === 'CrRendererMain') {
      rendererMainThreadPids.add(event.pid);
    }
  }

  return candidatePids.filter((pid) => {
    const names = processNames.get(pid);
    if (names && names.size > 0) return names.has('renderer');
    return rendererMainThreadPids.has(pid);
  });
}

function selectImplicitTargetPid(events, candidatePids, failures) {
  if (candidatePids.length === 0) {
    failures.push('target-process-missing');
    return undefined;
  }
  if (candidatePids.length === 1) return candidatePids[0];

  const rendererPids = rendererProcessPids(events, candidatePids);
  if (rendererPids.length === 1) return rendererPids[0];

  failures.push('target-process-ambiguous');
  return undefined;
}

function normalizeIdValue(value) {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return null;
}

function pipelineId(event) {
  const id2 = event?.id2;
  if (!id2 || typeof id2 !== 'object') return null;
  const candidates = [];
  for (const scope of ['local', 'global']) {
    if (!Object.prototype.hasOwnProperty.call(id2, scope)) continue;
    const value = normalizeIdValue(id2[scope]);
    if (value !== null) candidates.push({ scope, value });
  }
  return candidates.length === 1 ? candidates[0] : null;
}

function normalizeSurfaceId(value) {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return null;
}

const SURFACE_ID_PATHS = [
  ['args', 'layer_tree_host_id'],
  ['args', 'layerTreeHostId'],
  ['args', 'surface_id'],
  ['args', 'surfaceId'],
  ['args', 'data', 'layer_tree_host_id'],
  ['args', 'data', 'layerTreeHostId'],
  ['args', 'data', 'surface_id'],
  ['args', 'data', 'surfaceId'],
  ['args', 'chrome_frame_reporter', 'layer_tree_host_id'],
  ['args', 'chrome_frame_reporter2', 'layer_tree_host_id'],
  ['args', 'frame_reporter', 'layer_tree_host_id'],
];

function surfaceIds(event) {
  return unique(
    valuesAt(event, SURFACE_ID_PATHS)
      .map(normalizeSurfaceId)
      .filter((value) => value !== null)
  );
}

const PIPELINE_STATE_PATHS = [
  ['args', 'state'],
  ['args', 'data', 'state'],
  ['args', 'chrome_frame_reporter', 'state'],
  ['args', 'chrome_frame_reporter2', 'state'],
  ['args', 'frame_reporter', 'state'],
];

function normalizePipelineState(value) {
  if (typeof value === 'number') return NUMERIC_PIPELINE_STATES.get(value) ?? null;
  if (typeof value !== 'string') return null;
  return STRING_PIPELINE_STATES.get(value.trim().toUpperCase()) ?? null;
}

function pipelineStates(event) {
  return unique(
    valuesAt(event, PIPELINE_STATE_PATHS)
      .map(normalizePipelineState)
      .filter((value) => value !== null)
  );
}

const MISSING_CONTENT_PATHS = [
  ['args', 'has_missing_content'],
  ['args', 'hasMissingContent'],
  ['args', 'data', 'has_missing_content'],
  ['args', 'data', 'hasMissingContent'],
  ['args', 'chrome_frame_reporter', 'has_missing_content'],
  ['args', 'chrome_frame_reporter2', 'has_missing_content'],
  ['args', 'frame_reporter', 'has_missing_content'],
];

function hasMissingContent(event) {
  return valuesAt(event, MISSING_CONTENT_PATHS).some((value) => value === true || value === 1);
}

const FRAME_SOURCE_PATHS = [
  ['args', 'frame_source'],
  ['args', 'frameSource'],
  ['args', 'data', 'frame_source'],
  ['args', 'data', 'frameSource'],
  ['args', 'chrome_frame_reporter', 'frame_source'],
  ['args', 'chrome_frame_reporter2', 'frame_source'],
  ['args', 'frame_reporter', 'frame_source'],
];

const FRAME_SEQUENCE_PATHS = [
  ['args', 'frame_sequence'],
  ['args', 'frameSequence'],
  ['args', 'data', 'frame_sequence'],
  ['args', 'data', 'frameSequence'],
  ['args', 'chrome_frame_reporter', 'frame_sequence'],
  ['args', 'chrome_frame_reporter2', 'frame_sequence'],
  ['args', 'frame_reporter', 'frame_sequence'],
];

const AFFECTS_SMOOTHNESS_PATHS = [
  ['args', 'affects_smoothness'],
  ['args', 'affectsSmoothness'],
  ['args', 'data', 'affects_smoothness'],
  ['args', 'data', 'affectsSmoothness'],
  ['args', 'chrome_frame_reporter', 'affects_smoothness'],
  ['args', 'chrome_frame_reporter2', 'affects_smoothness'],
  ['args', 'frame_reporter', 'affects_smoothness'],
];

const FRAME_TYPE_PATHS = [
  ['args', 'frame_type'],
  ['args', 'frameType'],
  ['args', 'data', 'frame_type'],
  ['args', 'data', 'frameType'],
  ['args', 'chrome_frame_reporter', 'frame_type'],
  ['args', 'chrome_frame_reporter2', 'frame_type'],
  ['args', 'frame_reporter', 'frame_type'],
];

function reporterFieldPaths(...fields) {
  const containers = [
    ['args'],
    ['args', 'data'],
    ['args', 'chrome_frame_reporter'],
    ['args', 'chrome_frame_reporter2'],
    ['args', 'frame_reporter'],
  ];
  return containers.flatMap((container) =>
    fields.map((field) => [...container, field])
  );
}

const PIPELINE_REASON_PATHS = reporterFieldPaths(
  'reason',
  'frame_skipped_reason',
  'frameSkippedReason',
  'frame_skipped_reason_v2',
  'frameSkippedReasonV2',
  'frame_skipped_reason_v3',
  'frameSkippedReasonV3',
  'frame_skipped_reason_v4',
  'frameSkippedReasonV4'
);
const SCROLL_STATE_PATHS = reporterFieldPaths('scroll_state', 'scrollState');
const HAS_HIGH_LATENCY_PATHS = reporterFieldPaths(
  'has_high_latency',
  'hasHighLatency'
);
const HIGH_LATENCY_STAGE_PATHS = reporterFieldPaths(
  'high_latency_contribution_stage',
  'highLatencyContributionStage'
);
const CHECKERBOARDED_NEEDS_RASTER_PATHS = reporterFieldPaths(
  'checkerboarded_needs_raster',
  'checkerboardedNeedsRaster'
);
const CHECKERBOARDED_NEEDS_RECORD_PATHS = reporterFieldPaths(
  'checkerboarded_needs_record',
  'checkerboardedNeedsRecord'
);
const SURFACE_FRAME_TRACE_ID_PATHS = reporterFieldPaths(
  'surface_frame_trace_id',
  'surfaceFrameTraceId'
);
const DISPLAY_TRACE_ID_PATHS = reporterFieldPaths(
  'display_trace_id',
  'displayTraceId'
);

function firstScalar(event, paths) {
  return valuesAt(event, paths).find(
    (value) => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
  );
}

function firstExactIdentifier(event, paths) {
  return valuesAt(event, paths).find(
    (value) =>
      (typeof value === 'string' && value.length > 0) || Number.isSafeInteger(value)
  );
}

function firstBoolean(event, paths) {
  const value = valuesAt(event, paths).find(
    (candidate) =>
      typeof candidate === 'boolean' ||
      candidate === 0 ||
      candidate === 1
  );
  if (value === undefined) return null;
  return value === true || value === 1;
}

function stringList(event, paths) {
  return unique(
    valuesAt(event, paths)
      .flatMap((value) => (Array.isArray(value) ? value : [value]))
      .filter((value) => typeof value === 'string' && value.length > 0)
  );
}

function syncId(event) {
  if (event?.name !== 'clock_sync' || event?.ph !== 'c') return null;
  const ids = unique(
    valuesAt(event, [
      ['args', 'sync_id'],
      ['args', 'syncId'],
      ['args', 'data', 'sync_id'],
      ['args', 'data', 'syncId'],
    ]).filter((value) => typeof value === 'string' && value.length > 0)
  );
  return ids.length === 1 ? ids[0] : null;
}

function traceEnvelope(input) {
  if (!input || typeof input !== 'object') {
    return { events: null, dataLossOccurred: null };
  }
  const events = Array.isArray(input.traceEvents)
    ? input.traceEvents
    : Array.isArray(input.events)
      ? input.events
      : null;
  const dataLossOccurred =
    typeof input.dataLossOccurred === 'boolean'
      ? input.dataLossOccurred
      : typeof input.tracingComplete?.dataLossOccurred === 'boolean'
        ? input.tracingComplete.dataLossOccurred
        : null;
  return { events, dataLossOccurred };
}

function findBoundary(events, requestedSyncId, label, failures) {
  if (typeof requestedSyncId !== 'string' || requestedSyncId.length === 0) {
    failures.push(`${label}-clock-sync-id-required`);
    return null;
  }
  const matching = events.filter((event) => syncId(event) === requestedSyncId);
  if (matching.length === 0) {
    failures.push(`${label}-clock-sync-missing`);
    return null;
  }
  if (matching.length > 1) {
    failures.push(`${label}-clock-sync-ambiguous`);
    return null;
  }
  const marker = matching[0];
  if (!isFiniteNumber(marker.ts)) {
    failures.push(`${label}-clock-sync-timestamp-invalid`);
    return null;
  }
  return { syncId: requestedSyncId, traceTimestampUs: marker.ts };
}

function pairPipelineReporters(events, measurementStartUs, measurementEndUs, failures) {
  const open = new Map();
  const pairs = [];
  const unmatched = [];

  for (const event of events) {
    if (event?.name !== 'PipelineReporter') continue;
    const id = pipelineId(event);
    if (!Number.isSafeInteger(event.pid) || id === null || !isFiniteNumber(event.ts)) {
      if (
        isFiniteNumber(event?.ts) &&
        event.ts >= measurementStartUs &&
        event.ts <= measurementEndUs
      ) {
        failures.push('pipeline-reporter-identity-invalid');
      }
      continue;
    }
    const key = `${event.pid}:${id.scope}:${id.value}`;
    if (PIPELINE_BEGIN_PHASES.has(event.ph)) {
      if (open.has(key)) {
        if (event.ts >= measurementStartUs && event.ts <= measurementEndUs) {
          failures.push('pipeline-reporter-begin-ambiguous');
        }
        continue;
      }
      open.set(key, { event, id, key });
      continue;
    }
    if (!PIPELINE_END_PHASES.has(event.ph)) continue;
    const begin = open.get(key);
    if (!begin) {
      unmatched.push(event);
      continue;
    }
    open.delete(key);
    pairs.push({ begin, end: event });
  }

  for (const { event } of open.values()) unmatched.push(event);
  if (
    unmatched.some(
      (event) => event.ts >= measurementStartUs && event.ts <= measurementEndUs
    )
  ) {
    failures.push('pipeline-reporter-unpaired-in-measurement');
  }

  const normalized = [];
  for (const pair of pairs) {
    const beginEvent = pair.begin.event;
    const endEvent = pair.end;
    if (beginEvent.ts < measurementStartUs || beginEvent.ts > measurementEndUs) continue;
    if (!(endEvent.ts >= beginEvent.ts)) {
      failures.push('pipeline-reporter-negative-latency');
      continue;
    }
    const states = unique([...pipelineStates(beginEvent), ...pipelineStates(endEvent)]);
    if (states.length !== 1) {
      failures.push('pipeline-reporter-state-missing-or-ambiguous');
      continue;
    }
    const surfaces = unique([...surfaceIds(beginEvent), ...surfaceIds(endEvent)]);
    if (surfaces.length !== 1) {
      failures.push('pipeline-reporter-surface-missing-or-ambiguous');
      continue;
    }
    normalized.push({
      pid: beginEvent.pid,
      idScope: pair.begin.id.scope,
      id: pair.begin.id.value,
      surfaceId: surfaces[0],
      state: states[0],
      hasMissingContent: hasMissingContent(beginEvent) || hasMissingContent(endEvent),
      beginTraceTimestampUs: beginEvent.ts,
      endTraceTimestampUs: endEvent.ts,
      latencyMs: (endEvent.ts - beginEvent.ts) / 1000,
      frameSource: firstScalar(endEvent, FRAME_SOURCE_PATHS) ?? firstScalar(beginEvent, FRAME_SOURCE_PATHS) ?? null,
      frameSequence:
        firstScalar(endEvent, FRAME_SEQUENCE_PATHS) ??
        firstScalar(beginEvent, FRAME_SEQUENCE_PATHS) ??
        null,
      affectsSmoothness:
        firstBoolean(endEvent, AFFECTS_SMOOTHNESS_PATHS) ??
        firstBoolean(beginEvent, AFFECTS_SMOOTHNESS_PATHS),
      frameType:
        firstScalar(endEvent, FRAME_TYPE_PATHS) ??
        firstScalar(beginEvent, FRAME_TYPE_PATHS) ??
        null,
      reason:
        firstScalar(endEvent, PIPELINE_REASON_PATHS) ??
        firstScalar(beginEvent, PIPELINE_REASON_PATHS) ??
        null,
      scrollState:
        firstScalar(endEvent, SCROLL_STATE_PATHS) ??
        firstScalar(beginEvent, SCROLL_STATE_PATHS) ??
        null,
      hasHighLatency:
        firstBoolean(endEvent, HAS_HIGH_LATENCY_PATHS) ??
        firstBoolean(beginEvent, HAS_HIGH_LATENCY_PATHS),
      highLatencyContributionStages: unique([
        ...stringList(beginEvent, HIGH_LATENCY_STAGE_PATHS),
        ...stringList(endEvent, HIGH_LATENCY_STAGE_PATHS),
      ]),
      checkerboardedNeedsRaster:
        firstBoolean(endEvent, CHECKERBOARDED_NEEDS_RASTER_PATHS) ??
        firstBoolean(beginEvent, CHECKERBOARDED_NEEDS_RASTER_PATHS),
      checkerboardedNeedsRecord:
        firstBoolean(endEvent, CHECKERBOARDED_NEEDS_RECORD_PATHS) ??
        firstBoolean(beginEvent, CHECKERBOARDED_NEEDS_RECORD_PATHS),
      surfaceFrameTraceId:
        firstExactIdentifier(endEvent, SURFACE_FRAME_TRACE_ID_PATHS) ??
        firstExactIdentifier(beginEvent, SURFACE_FRAME_TRACE_ID_PATHS) ??
        null,
      displayTraceId:
        firstExactIdentifier(endEvent, DISPLAY_TRACE_ID_PATHS) ??
        firstExactIdentifier(beginEvent, DISPLAY_TRACE_ID_PATHS) ??
        null,
    });
  }
  return normalized;
}

const EXPLICIT_PRESENTATION_TIMESTAMP_PATHS = [
  ['args', 'presentation_timestamp_us'],
  ['args', 'presentationTimestampUs'],
  ['args', 'presentation_time_us'],
  ['args', 'presentationTimeUs'],
  ['args', 'timestamp_us'],
  ['args', 'timestampUs'],
  ['args', 'data', 'presentation_timestamp_us'],
  ['args', 'data', 'presentationTimestampUs'],
  ['args', 'data', 'presentation_time_us'],
  ['args', 'data', 'presentationTimeUs'],
  ['args', 'data', 'timestamp_us'],
  ['args', 'data', 'timestampUs'],
  ['args', 'feedback', 'presentation_timestamp_us'],
  ['args', 'feedback', 'presentationTimestampUs'],
];

function extractPresentationTimestamp(event) {
  if (event?.name !== 'FramePresented' && event?.name !== 'NewPresentationFeedbackTimeStamps') {
    return null;
  }
  const explicit = unique(
    valuesAt(event, EXPLICIT_PRESENTATION_TIMESTAMP_PATHS).filter(isFiniteNumber)
  );
  if (explicit.length > 1) {
    return { error: 'presentation-native-timestamp-ambiguous' };
  }
  if (explicit.length === 1) {
    return {
      timestampUs: explicit[0],
      source:
        event.name === 'FramePresented'
          ? 'FramePresented.explicit-native-timestamp'
          : 'NewPresentationFeedbackTimeStamps.explicit-native-timestamp',
    };
  }
  if (
    event.name === 'FramePresented' &&
    FRAME_PRESENTED_TS_PHASES.has(event.ph) &&
    isFiniteNumber(event.ts)
  ) {
    return {
      timestampUs: event.ts,
      source: 'FramePresented.named-explicit-event-timestamp',
    };
  }
  return { error: 'presentation-native-timestamp-missing' };
}

function sameNumberArray(a, b) {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function selectPresentationStream(
  events,
  { pid, surfaceId, allowImplicitSurface, measurementStartUs, measurementEndUs },
  failures
) {
  const byName = new Map([
    ['FramePresented', []],
    ['NewPresentationFeedbackTimeStamps', []],
  ]);

  for (const event of events) {
    if (!byName.has(event?.name)) continue;
    if (!Number.isSafeInteger(event.pid)) {
      failures.push('presentation-process-missing');
      continue;
    }
    if (event.pid !== pid) continue;
    const eventSurfaces = surfaceIds(event);
    if (eventSurfaces.length > 1) {
      failures.push('presentation-surface-ambiguous');
      continue;
    }
    if (eventSurfaces.length === 1 && eventSurfaces[0] !== surfaceId) continue;
    if (eventSurfaces.length === 0 && !allowImplicitSurface) {
      failures.push('presentation-surface-missing-or-ambiguous');
      continue;
    }
    const extracted = extractPresentationTimestamp(event);
    if (!extracted || extracted.error) {
      failures.push(extracted?.error ?? 'presentation-native-timestamp-missing');
      continue;
    }
    if (
      extracted.timestampUs < measurementStartUs ||
      extracted.timestampUs > measurementEndUs
    ) {
      continue;
    }
    byName.get(event.name).push(extracted);
  }

  for (const [name, entries] of byName) {
    for (let index = 1; index < entries.length; index += 1) {
      if (!(entries[index].timestampUs > entries[index - 1].timestampUs)) {
        failures.push(`nonmonotonic-native-presentation-timestamps:${name}`);
        break;
      }
    }
  }

  const framePresented = byName.get('FramePresented');
  const newFeedback = byName.get('NewPresentationFeedbackTimeStamps');
  if (framePresented.length > 0 && newFeedback.length > 0) {
    const oldValues = framePresented.map((entry) => entry.timestampUs);
    const newValues = newFeedback.map((entry) => entry.timestampUs);
    if (!sameNumberArray(oldValues, newValues)) {
      failures.push('ambiguous-presentation-native-timestamp-streams');
      return [];
    }
    return newFeedback;
  }
  return newFeedback.length > 0 ? newFeedback : framePresented;
}

function selectPresentedPipelineStream(reporters, failures) {
  const entries = reporters
    .filter(
      (reporter) =>
        reporter.state === PIPELINE_PRESENTATION_STATE.PRESENTED_ALL ||
        reporter.state === PIPELINE_PRESENTATION_STATE.PRESENTED_PARTIAL
    )
    .map((reporter) => ({
      timestampUs: reporter.endTraceTimestampUs,
      source: 'PipelineReporter.presented-frame-termination-timestamp',
    }))
    .sort((left, right) => left.timestampUs - right.timestampUs);
  const uniqueEntries = [];
  for (const entry of entries) {
    const previous = uniqueEntries.at(-1);
    if (previous?.timestampUs === entry.timestampUs) continue;
    if (previous && entry.timestampUs < previous.timestampUs) {
      failures.push('nonmonotonic-presented-pipeline-timestamps');
      continue;
    }
    uniqueEntries.push(entry);
  }
  return uniqueEntries;
}

function invalidResult(failures, partial = {}) {
  return {
    status: 'invalid',
    claimStatus: 'invalid',
    failures: unique(failures),
    ...partial,
  };
}

function invalidDisplayResult(failures, partial = {}) {
  return {
    status: 'invalid',
    evidenceKind: 'chromium-display-clock-diagnostic',
    failures: unique(failures),
    ...partial,
  };
}

export function summarizeChromiumDisplayClockTrace(
  input,
  {
    measurementStartSyncId,
    measurementEndSyncId,
    minWindowCoverageFraction = 0.95,
  } = {}
) {
  const failures = [];
  const envelope = traceEnvelope(input);
  if (!Array.isArray(envelope.events)) failures.push('trace-events-missing');
  if (envelope.dataLossOccurred === true) failures.push('trace-data-loss');
  if (envelope.dataLossOccurred !== true && envelope.dataLossOccurred !== false) {
    failures.push('trace-data-loss-status-missing');
  }
  if (
    !isFiniteNumber(minWindowCoverageFraction) ||
    minWindowCoverageFraction <= 0 ||
    minWindowCoverageFraction > 1
  ) {
    failures.push('invalid-min-window-coverage-fraction');
  }
  if (failures.length > 0) return invalidDisplayResult(failures);

  const events = envelope.events;
  const start = findBoundary(events, measurementStartSyncId, 'measurement-start', failures);
  const end = findBoundary(events, measurementEndSyncId, 'measurement-end', failures);
  if (start && end && !(end.traceTimestampUs > start.traceTimestampUs)) {
    failures.push('measurement-clock-sync-order-invalid');
  }
  if (failures.length > 0) {
    return invalidDisplayResult(failures, { boundary: { start, end } });
  }

  const measurementStartUs = start.traceTimestampUs;
  const measurementEndUs = end.traceTimestampUs;
  const namedInWindow = [];
  for (const event of events) {
    if (event?.name !== CHROMIUM_DISPLAY_FRAME_EVENT_SOURCE.name) continue;
    if (!isFiniteNumber(event.ts)) {
      failures.push('display-frame-timestamp-invalid');
      continue;
    }
    if (event.ts < measurementStartUs || event.ts > measurementEndUs) continue;
    namedInWindow.push(event);
    if (
      event.cat !== CHROMIUM_DISPLAY_FRAME_EVENT_SOURCE.cat ||
      event.ph !== CHROMIUM_DISPLAY_FRAME_EVENT_SOURCE.ph
    ) {
      failures.push('display-frame-source-unqualified');
    }
    if (!Number.isSafeInteger(event.pid) || !Number.isSafeInteger(event.tid)) {
      failures.push('display-frame-source-identity-invalid');
    }
  }

  const qualified = namedInWindow.filter(
    (event) =>
      event.cat === CHROMIUM_DISPLAY_FRAME_EVENT_SOURCE.cat &&
      event.ph === CHROMIUM_DISPLAY_FRAME_EVENT_SOURCE.ph &&
      Number.isSafeInteger(event.pid) &&
      Number.isSafeInteger(event.tid)
  );
  const identities = unique(qualified.map((event) => `${event.pid}:${event.tid}`));
  if (identities.length > 1) failures.push('display-frame-source-ambiguous');
  const selectedIdentity = identities.length === 1 ? identities[0] : null;
  const selected =
    selectedIdentity === null
      ? []
      : qualified.filter((event) => `${event.pid}:${event.tid}` === selectedIdentity);

  const timestampsUs = [];
  let duplicateTimestampCount = 0;
  for (const event of selected) {
    const previousTimestampUs = timestampsUs.at(-1);
    if (event.ts === previousTimestampUs) {
      duplicateTimestampCount += 1;
      continue;
    }
    if (previousTimestampUs !== undefined && event.ts < previousTimestampUs) {
      failures.push('nonmonotonic-display-frame-timestamps');
    }
    timestampsUs.push(event.ts);
  }
  if (timestampsUs.length < 2) failures.push('insufficient-display-frame-timestamps');

  const durationUs = measurementEndUs - measurementStartUs;
  const observedWindowUs =
    timestampsUs.length >= 2 ? timestampsUs.at(-1) - timestampsUs[0] : 0;
  const windowCoverageFraction = durationUs > 0 ? observedWindowUs / durationUs : 0;
  if (windowCoverageFraction < minWindowCoverageFraction) {
    failures.push('insufficient-display-frame-window-coverage');
  }

  const rawDeltasMs = [];
  for (let index = 1; index < timestampsUs.length; index += 1) {
    rawDeltasMs.push((timestampsUs[index] - timestampsUs[index - 1]) / 1000);
  }
  const sortedDeltasMs = [...rawDeltasMs].sort((left, right) => left - right);
  const percentile = (fraction) =>
    sortedDeltasMs.length === 0
      ? null
      : sortedDeltasMs[
          Math.min(
            sortedDeltasMs.length - 1,
            Math.floor((sortedDeltasMs.length - 1) * fraction)
          )
        ];
  const identity = selected[0] ?? null;
  const partial = {
    source: {
      ...CHROMIUM_DISPLAY_FRAME_EVENT_SOURCE,
      pid: identity?.pid ?? null,
      tid: identity?.tid ?? null,
    },
    boundary: {
      start,
      end,
      durationMs: durationUs / 1000,
    },
    displayFrameEventCount: selected.length,
    duplicateTimestampCount,
    frameCount: timestampsUs.length,
    intervalCount: rawDeltasMs.length,
    timestampsUs,
    rawDeltasMs,
    presentedFps:
      observedWindowUs > 0
        ? +(((timestampsUs.length - 1) * 1_000_000) / observedWindowUs).toFixed(4)
        : null,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    worstMs: sortedDeltasMs.at(-1) ?? null,
    firstTimestampUs: timestampsUs[0] ?? null,
    lastTimestampUs: timestampsUs.at(-1) ?? null,
    leadingGapMs:
      timestampsUs.length > 0 ? (timestampsUs[0] - measurementStartUs) / 1000 : null,
    trailingGapMs:
      timestampsUs.length > 0 ? (measurementEndUs - timestampsUs.at(-1)) / 1000 : null,
    windowCoverageFraction,
    requiredWindowCoverageFraction: minWindowCoverageFraction,
  };
  if (failures.length > 0) return invalidDisplayResult(failures, partial);
  return {
    status: 'valid',
    evidenceKind: 'chromium-display-clock-diagnostic',
    failures: [],
    ...partial,
  };
}

export function parseChromiumPresentationTrace(
  input,
  {
    measurementStartSyncId,
    measurementEndSyncId,
    targetPid,
    targetSurfaceId,
    minWindowCoverageFraction = 0.95,
  } = {}
) {
  const failures = [];
  const envelope = traceEnvelope(input);
  if (!Array.isArray(envelope.events)) failures.push('trace-events-missing');
  if (envelope.dataLossOccurred === true) failures.push('trace-data-loss');
  if (envelope.dataLossOccurred !== true && envelope.dataLossOccurred !== false) {
    failures.push('trace-data-loss-status-missing');
  }
  if (
    !isFiniteNumber(minWindowCoverageFraction) ||
    minWindowCoverageFraction <= 0 ||
    minWindowCoverageFraction > 1
  ) {
    failures.push('invalid-min-window-coverage-fraction');
  }
  if (failures.length > 0) return invalidResult(failures);

  const events = envelope.events;
  const start = findBoundary(events, measurementStartSyncId, 'measurement-start', failures);
  const end = findBoundary(events, measurementEndSyncId, 'measurement-end', failures);
  if (start && end && !(end.traceTimestampUs > start.traceTimestampUs)) {
    failures.push('measurement-clock-sync-order-invalid');
  }
  if (failures.length > 0) return invalidResult(failures, { boundary: { start, end } });

  const measurementStartUs = start.traceTimestampUs;
  const measurementEndUs = end.traceTimestampUs;
  const gpuProgramLinks = events
    .filter(
      (event) =>
        event?.name === GPU_PROGRAM_LINK_EVENT &&
        event.ph === 'X' &&
        isFiniteNumber(event.ts) &&
        event.ts >= measurementStartUs &&
        event.ts <= measurementEndUs
    )
    .map((event) => ({
      timestampUs: event.ts,
      durationUs: isFiniteNumber(event.dur) ? event.dur : null,
      pid: Number.isSafeInteger(event.pid) ? event.pid : null,
      tid: Number.isSafeInteger(event.tid) ? event.tid : null,
    }));
  const pipelinePairs = pairPipelineReporters(
    events,
    measurementStartUs,
    measurementEndUs,
    failures
  );

  const candidatePids = unique(pipelinePairs.map((pair) => pair.pid));
  let selectedPid = targetPid;
  if (selectedPid !== undefined && !Number.isSafeInteger(selectedPid)) {
    failures.push('target-process-invalid');
  } else if (selectedPid === undefined) {
    selectedPid = selectImplicitTargetPid(events, candidatePids, failures);
  }

  const pidPairs = pipelinePairs.filter((pair) => pair.pid === selectedPid);
  if (selectedPid !== undefined && pidPairs.length === 0) failures.push('target-process-missing');
  if (pidPairs.some((pair) => pair.surfaceId === null)) failures.push('target-surface-missing');
  const candidateSurfaces = unique(pidPairs.map((pair) => pair.surfaceId));
  let selectedSurface = normalizeSurfaceId(targetSurfaceId);
  if (targetSurfaceId !== undefined && selectedSurface === null) {
    failures.push('target-surface-invalid');
  } else if (targetSurfaceId === undefined) {
    if (candidateSurfaces.length === 0) failures.push('target-surface-missing');
    else if (candidateSurfaces.length > 1) failures.push('target-surface-ambiguous');
    else selectedSurface = candidateSurfaces[0];
  }

  const selectedPipeline = pidPairs.filter((pair) => pair.surfaceId === selectedSurface);
  if (selectedSurface !== null && selectedPipeline.length === 0) failures.push('target-surface-missing');

  const gpuMainThreads = new Set(
    events
      .filter((event) =>
        event?.name === 'thread_name' && Number.isSafeInteger(event.tid) &&
        metadataName(event) === 'CrGpuMain')
      .map((event) => `${event.pid}:${event.tid}`)
  );
  const frameReporters = new Map();
  for (const reporter of selectedPipeline) {
    const key = `${reporter.frameSource}:${reporter.frameSequence}`;
    const group = frameReporters.get(key) ?? [];
    group.push(reporter);
    frameReporters.set(key, group);
  }
  const failedReporters = [...frameReporters.values()].flatMap((group) => {
    if (group.some((reporter) => reporter.hasMissingContent)) return group;
    if (group.some((reporter) => reporter.state === PIPELINE_PRESENTATION_STATE.PRESENTED_ALL)) return [];
    if (group.some((reporter) => reporter.state === PIPELINE_PRESENTATION_STATE.PRESENTED_PARTIAL)) return group;
    if (group.some((reporter) => reporter.state === PIPELINE_PRESENTATION_STATE.NO_UPDATE)) return [];
    return group;
  });
  const contextMakeCurrentEvents = events
    .filter((event) =>
      event?.name === 'GLContextEGL::MakeCurrent' && event.ph === 'X' &&
      gpuMainThreads.has(`${event.pid}:${event.tid}`) &&
      isFiniteNumber(event.ts) && isFiniteNumber(event.dur) && event.dur > 0 &&
      event.ts <= measurementEndUs && event.ts + event.dur >= measurementStartUs
    )
    .map((event) => ({
      timestampUs: event.ts,
      durationMs: event.dur / 1_000,
      threadCpuMs: isFiniteNumber(event.tdur) && event.tdur >= 0 ? event.tdur / 1_000 : null,
      pid: event.pid,
      tid: event.tid,
      overlappingFailedFrameSequences: unique(failedReporters
        .filter((reporter) => reporter.beginTraceTimestampUs < event.ts + event.dur &&
          reporter.endTraceTimestampUs > event.ts)
        .map((reporter) => reporter.frameSequence)),
    }));

  let presentationEntries =
    selectedPid !== undefined && selectedSurface !== null
      ? selectPresentationStream(
          events,
          {
            pid: selectedPid,
            surfaceId: selectedSurface,
            allowImplicitSurface: candidateSurfaces.length === 1,
            measurementStartUs,
            measurementEndUs,
          },
          failures
        )
      : [];
  let usedPipelineOutcomeFallback = false;
  if (presentationEntries.length === 0 && selectedPipeline.length > 0) {
    presentationEntries = selectPresentedPipelineStream(selectedPipeline, failures);
    usedPipelineOutcomeFallback = true;
  }

  const nativeTimestampsUs = presentationEntries.map((entry) => entry.timestampUs);
  if (nativeTimestampsUs.length < 2) failures.push('insufficient-native-presentation-timestamps');
  const measurementDurationUs = measurementEndUs - measurementStartUs;
  const presentedObservedWindowUs =
    nativeTimestampsUs.length >= 2
      ? nativeTimestampsUs[nativeTimestampsUs.length - 1] - nativeTimestampsUs[0]
      : 0;
  const presentedWindowCoverageFraction =
    measurementDurationUs > 0 ? presentedObservedWindowUs / measurementDurationUs : 0;
  const firstOutcomeStartedAtUs = selectedPipeline.reduce(
    (earliest, reporter) => Math.min(earliest, reporter.beginTraceTimestampUs),
    Number.POSITIVE_INFINITY
  );
  const lastOutcomeCompletedAtUs = selectedPipeline.reduce(
    (latest, reporter) => Math.max(latest, reporter.endTraceTimestampUs),
    Number.NEGATIVE_INFINITY
  );
  const outcomeObservedWindowUs =
    Number.isFinite(firstOutcomeStartedAtUs) && Number.isFinite(lastOutcomeCompletedAtUs)
      ? Math.max(
          0,
          Math.min(lastOutcomeCompletedAtUs, measurementEndUs) -
            Math.max(firstOutcomeStartedAtUs, measurementStartUs)
        )
      : 0;
  const hasOutcomeWindow = usedPipelineOutcomeFallback && selectedPipeline.length >= 2;
  const windowCoverageFraction =
    measurementDurationUs > 0
      ? (hasOutcomeWindow ? outcomeObservedWindowUs : presentedObservedWindowUs) /
        measurementDurationUs
      : 0;
  if (windowCoverageFraction < minWindowCoverageFraction) {
    failures.push('insufficient-native-presentation-window-coverage');
  }

  const intervalsMs = [];
  for (let index = 1; index < nativeTimestampsUs.length; index += 1) {
    intervalsMs.push((nativeTimestampsUs[index] - nativeTimestampsUs[index - 1]) / 1000);
  }

  const stateCounts = {
    [PIPELINE_PRESENTATION_STATE.PRESENTED_ALL]: 0,
    [PIPELINE_PRESENTATION_STATE.PRESENTED_PARTIAL]: 0,
    [PIPELINE_PRESENTATION_STATE.DROPPED]: 0,
    [PIPELINE_PRESENTATION_STATE.NO_UPDATE]: 0,
  };
  const latencyByStateMs = {
    [PIPELINE_PRESENTATION_STATE.PRESENTED_ALL]: [],
    [PIPELINE_PRESENTATION_STATE.PRESENTED_PARTIAL]: [],
    [PIPELINE_PRESENTATION_STATE.DROPPED]: [],
    [PIPELINE_PRESENTATION_STATE.NO_UPDATE]: [],
  };
  let missingContentCount = 0;
  for (const reporter of selectedPipeline) {
    stateCounts[reporter.state] += 1;
    latencyByStateMs[reporter.state].push(reporter.latencyMs);
    if (reporter.hasMissingContent) missingContentCount += 1;
  }

  const partial = {
    boundary: {
      start,
      end,
      durationMs: measurementDurationUs / 1000,
    },
    target: { pid: selectedPid ?? null, surfaceId: selectedSurface },
    gpu: {
      programLinkCount: gpuProgramLinks.length,
      programLinks: gpuProgramLinks,
      contextMakeCurrentEvents,
    },
    pipeline: {
      reporters: selectedPipeline,
      processReporters: pidPairs,
      stateCounts,
      missingContentCount,
      latencyByStateMs,
    },
    presentation: {
      nativeTimestampsUs,
      intervalsMs,
      timestampSources: unique(presentationEntries.map((entry) => entry.source)),
      firstNativeTimestampUs: nativeTimestampsUs[0] ?? null,
      lastNativeTimestampUs: nativeTimestampsUs.at(-1) ?? null,
      leadingGapMs:
        nativeTimestampsUs.length > 0 ? (nativeTimestampsUs[0] - measurementStartUs) / 1000 : null,
      trailingGapMs:
        nativeTimestampsUs.length > 0
          ? (measurementEndUs - nativeTimestampsUs.at(-1)) / 1000
          : null,
      windowCoverageFraction,
      presentedWindowCoverageFraction,
      outcomeLeadingGapMs: Number.isFinite(firstOutcomeStartedAtUs)
        ? (firstOutcomeStartedAtUs - measurementStartUs) / 1000
        : null,
      outcomeTrailingGapMs: Number.isFinite(lastOutcomeCompletedAtUs)
        ? Math.max(0, measurementEndUs - lastOutcomeCompletedAtUs) / 1000
        : null,
      windowCoverageSource: hasOutcomeWindow
        ? 'PipelineReporter-qualified-outcome-window'
        : 'native-presentation-window',
      requiredWindowCoverageFraction: minWindowCoverageFraction,
    },
  };

  if (failures.length > 0) return invalidResult(failures, partial);

  const claimFailures = [];
  if (stateCounts[PIPELINE_PRESENTATION_STATE.DROPPED] > 0) {
    claimFailures.push('pipeline-dropped');
  }
  if (stateCounts[PIPELINE_PRESENTATION_STATE.PRESENTED_PARTIAL] > 0) {
    claimFailures.push('pipeline-presented-partial');
  }
  if (missingContentCount > 0) claimFailures.push('pipeline-missing-content');

  return {
    status: 'valid',
    claimStatus: claimFailures.length === 0 ? 'pass' : 'fail',
    failures: [],
    claimFailures,
    ...partial,
  };
}

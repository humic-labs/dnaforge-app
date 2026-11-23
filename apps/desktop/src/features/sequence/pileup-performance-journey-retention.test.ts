import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  classifyPileupAnnotation,
  pileupCoverageCoversViewport,
  pileupRangeMatchesViewport,
} from '../../../scripts/lib/pileup-performance.mjs';

type RecordValue = Record<string, unknown>;
type SubjectName = 'observation' | 'complete' | 'wheelGesture' | 'open';
type Callable = (...args: unknown[]) => unknown;

const sourcePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../scripts/lib/pileup-performance-journey.mjs'
);
const source = readFileSync(sourcePath, 'utf8');
const parsed = ts.createSourceFile(
  sourcePath,
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS
);

function record(value: unknown): RecordValue {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as RecordValue;
}

function callable(value: unknown): Callable {
  assert.equal(typeof value, 'function');
  return value as Callable;
}

function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function subject(name: SubjectName, bindings: RecordValue): Callable {
  const matches: ts.Node[] = [];
  if (name === 'open') {
    const owners = parsed.statements.filter(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === 'runPileupPerformanceJourney'
    );
    assert.equal(owners.length, 1, 'The existing journey owner must be unambiguous');
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'open' &&
        node.initializer &&
        ts.isArrowFunction(node.initializer)
      ) {
        matches.push(node.initializer);
      }
      ts.forEachChild(node, visit);
    };
    visit(owners[0]);
  } else {
    for (const node of parsed.statements) {
      if (ts.isFunctionDeclaration(node) && node.name?.text === name) matches.push(node);
    }
  }
  assert.equal(matches.length, 1, `The existing ${name} body must be unambiguous`);
  return callable(
    runInNewContext(`(${matches[0].getText(parsed)})`, bindings, { filename: sourcePath })
  );
}

function clock(initial = 0) {
  let current = initial;
  let inBrowser = false;
  return {
    performance: {
      now: () => {
        assert.equal(inBrowser, false, 'Retention must not add a browser clock read');
        return current;
      },
    },
    now: () => current,
    advance: (milliseconds: number) => (current += milliseconds),
    browser: (value: boolean) => (inBrowser = value),
  };
}

async function rejection(action: () => unknown): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error('The original rejection did not propagate');
}

function openFixture(visible: boolean, failed?: 'isVisible' | 'click' | 'hidden', error?: unknown) {
  const time = clock(1000);
  const calls: string[] = [];
  const phases: RecordValue[] = [];
  const openings: RecordValue[] = [];
  const expectedLane = {
    trackId: 'reads',
    generationKey: 'expected-generation',
    bamSizeBytes: 816350,
    assemblyLengthBp: 600000,
    chromosomeCount: 2,
  };
  const fixture = {
    bamPath: '/unit/synthetic.bam',
    locusStart: 60000,
    readLengthBp: 150,
    annotationExpectation: { trackId: 'mRNA', intervals: [] },
  };
  const operation = async (name: 'isVisible' | 'click' | 'hidden', milliseconds: number) => {
    calls.push(name);
    time.advance(milliseconds);
    if (failed === name) throw error;
    return visible;
  };
  const page = {
    getByRole: (role: string, options: unknown) => {
      expect([role, options]).toEqual(['tree', { name: 'Project files' }]);
      calls.push('getByRole');
      return {
        isVisible: () => operation('isVisible', 10),
        waitFor: (options: unknown) => {
          expect(options).toEqual({ state: 'hidden' });
          return operation('hidden', 25);
        },
      };
    },
    getByTestId: (id: string) => {
      expect(id).toBe('files-button');
      calls.push('getByTestId');
      return { click: () => operation('click', 15) };
    },
    evaluate: () => {
      throw new Error('Opening retention added a page evaluation');
    },
  };
  const bindings: RecordValue = {
    assert,
    performance: time.performance,
    scope: '',
    lane: undefined,
    errors: [],
    fixture,
    page,
    report: { diagnostics: { openings }, source: {} },
    savedFileRow: async () => {
      calls.push('savedFileRow');
      time.advance(5);
      return {
        dblclick: async () => {
          calls.push('dblclick');
          time.advance(20);
        },
      };
    },
    waitForViewer: async () => {
      calls.push('waitForViewer');
      time.advance(30);
    },
    poll: async (read: unknown, accepts: unknown, timeout: unknown) => {
      calls.push('poll');
      expect(timeout).toBe(10000);
      const value = await callable(read)();
      expect(callable(accepts)(value)).toBe(true);
      return value;
    },
    activeLane: async () => {
      calls.push('activeLane');
      time.advance(5);
      return expectedLane;
    },
    complete: async (
      _page: unknown,
      lane: unknown,
      length: unknown,
      started: unknown,
      failures: unknown,
      target: unknown
    ) => {
      calls.push('complete');
      expect(lane).toBe(expectedLane);
      expect(length).toBe(150);
      expect(started).toBe(1005);
      expect(failures).toEqual([]);
      expect(target).toEqual({ startBp: 60000, spanBp: 4000 });
      time.advance(40);
      return { viewport: {}, errors: [], elapsedMs: time.now() - Number(started), settlement: [] };
    },
    stat: async () => {
      calls.push('stat');
      time.advance(1);
      return { size: 816350 };
    },
    record: async (phase: unknown) => {
      calls.push('record');
      phases.push(record(phase));
    },
  };
  return { run: subject('open', bindings), calls, phases, openings };
}

function wheelFixture(failed?: 'acknowledgment' | 'cadenceStop', error?: unknown) {
  const time = clock();
  const calls: string[] = [];
  const sends: Array<{ method: unknown; args: unknown }> = [];
  const pending: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
  const cadence = {
    durationMs: 2000,
    rafIntervalsMs: [1000, 1000],
    longTaskDurationsMs: [],
    endedAtEpochMs: 902000,
    wheelDeliveryWaitMs: 0,
    wheel: { eventCount: 120, deltaY: 3000, untrustedCount: 0 },
  };
  const page = {
    mouse: {
      move: async (x: number, y: number) => {
        calls.push('move');
        expect([x, y]).toEqual([110, 70]);
      },
    },
  };
  const cdp = {
    send: (method: unknown, args: unknown) => {
      calls.push('dispatch');
      sends.push({ method, args });
      return new Promise<void>((resolve, reject) => {
        pending.push({ resolve, reject });
        if (pending.length === 120) {
          queueMicrotask(() => {
            time.advance(200);
            calls.push('acknowledgment');
            pending.forEach((request, index) => {
              if (failed === 'acknowledgment' && index === 119) request.reject(error);
              else request.resolve();
            });
          });
        }
      });
    },
  };
  const bindings = {
    assert,
    performance: time.performance,
    delay: async (milliseconds: number) => time.advance(milliseconds),
    viewer: () => ({
      locator: (selector: string) => {
        expect(selector).toBe('canvas');
        return {
          first: () => ({
            boundingBox: async () => {
              calls.push('bounds');
              return { x: 10, y: 20, width: 200, height: 100 };
            },
          }),
        };
      },
    }),
    startCadence: async () => {
      calls.push('startCadence');
      return 900000;
    },
    stopCadence: async (_page: unknown, delta: unknown) => {
      calls.push('stopCadence');
      expect(delta).toBe(3000);
      time.advance(100);
      if (failed === 'cadenceStop') throw error;
      return cadence;
    },
  };
  const receipt: RecordValue = {};
  return {
    run: () => subject('wheelGesture', bindings)(page, cdp, { deltaY: 25, modifiers: 2 }, receipt),
    receipt,
    calls,
    sends,
    cadence,
  };
}

function state(ready: boolean, counter: number) {
  return {
    checks: { ready },
    preparation: { rowsAssignmentBuilding: !ready },
    viewport: {
      startBp: 0,
      endBp: 4000,
      sourceFraction: 1,
      meshFraction: ready ? 1 : 0,
      pendingTiles: 0,
      recordCount: 2,
    },
    errors: [],
    retainedPreparation: { diagnosticCounters: { rowsAssignmentBuildRecordsLastFrame: counter } },
  };
}

function completeFixture(values: unknown[], observationCost = 10, thrown?: unknown) {
  const time = clock();
  const delays: number[] = [];
  const receipt: RecordValue = {};
  const failures: string[] = [];
  let count = 0;
  const bindings = {
    performance: time.performance,
    structuredClone,
    delay: async (milliseconds: number) => {
      delays.push(milliseconds);
      time.advance(milliseconds);
    },
    observation: async (_page: unknown, _lane: unknown, _length: unknown, poll?: unknown) => {
      const started = time.now();
      time.advance(observationCost);
      if (poll && typeof poll === 'object') {
        record(poll).evaluation = {
          startMs: started,
          endMs: time.now(),
          outcome: thrown === undefined ? 'fulfilled' : 'rejected',
        };
      }
      if (thrown !== undefined) throw thrown;
      assert.ok(count < values.length, 'The producer requested an extra observation');
      return values[count++];
    },
  };
  return {
    run: () =>
      subject('complete', bindings)(
        {},
        {},
        150,
        0,
        failures,
        { startBp: 0, spanBp: 4000 },
        receipt
      ),
    receipt,
    failures,
    delays,
  };
}

function observationFixture(missing?: 'mapper' | 'diagnostic' | 'driver', thrown?: unknown) {
  const time = clock();
  const calls: string[] = [];
  const timings: RecordValue = {
    recordCount: 2,
    totalMs: 3,
    assignMs: 1,
    assignRecordsProcessed: 2,
    assignmentPending: false,
    finishAssignmentMs: 0,
    beginRetainMs: 0,
    extentMs: 0,
    occupancyMs: 0,
    rowHeightFieldMs: 2,
    collapsedFieldMs: 0,
    rowAssignmentMapMs: 0,
    retainScheduled: false,
    exactDerivedBuilt: true,
    metadataOnly: false,
  };
  const paint: RecordValue = {
    totalMs: 4,
    coverageMs: 1,
    recordsMs: 2,
    retainMs: 0,
    readRowsMeshMs: 1,
    densityMs: 0,
    overflowMs: 0,
  };
  const diagnostic: RecordValue = {
    readSourceWindowCoversViewport: true,
    rowsMeshViewportCoverageFraction: 1,
    rowsMeshGenerationKey: 'mesh|expected-generation|records-1',
    readSourceTruncated: false,
    rowsMeshVisible: true,
    rowsVertexCount: 12,
    renderedReadRowsAlpha: 1,
    renderedReadDensityAlpha: 0,
    readSourceWindowCoverageFraction: 1,
    rowsMeshRecordCount: 2,
    coverageSignalStartBp: 0,
    coverageSignalEndBp: 4000,
    rowsAssignmentBuildInProgress: false,
    rowsMeshBuildInProgress: false,
    rowsMeshBuildRecordCursor: 0,
    rowsMeshBuildRecordCount: 2,
    rowsAssignmentBuildRecordsLastFrame: 2,
    rowsAssignmentBuildChunkCount: 1,
    rowsMeshBuildRecordsLastFrame: 2,
    rowsMeshBuildChunkCount: 1,
    rowsMeshBuildTargetMatchesRecordsKey: true,
    readSourceWindowStartBp: 0,
    readSourceWindowEndBp: 4000,
    recordsCommitTiming: timings,
    paintTiming: paint,
  };
  const lifecycle: RecordValue = {
    status: { phase: 'ready', kind: 'reads' },
    sourceKey: 'source|expected-generation',
    generation: 2,
    requestSequence: 3,
    planKey: 'plan-1',
    currentPlanKey: 'plan-1',
    currentRange: { start: 0, end: 4000 },
    lastPresentedRange: { start: 0, end: 4000 },
    pendingPresentation: null,
  };
  const driver = {
    alignedReadLifecycle: lifecycle,
    readComposition: {
      readyCoversViewport: true,
      readCoversViewport: true,
      errorTileCount: 0,
      pendingTileCount: 0,
      stableBandReady: true,
      readyBandTileCount: 4,
      expectedBandTileCount: 4,
    },
    coverageCorridorFloor: { state: 'ready' },
    cache: { byteSize: 100, entries: 1, errors: [] },
    aln: { error: 0 },
  };
  const lane = { trackId: 'reads', generationKey: 'expected-generation' };
  const windowValue = {
    __webglRenderer: {
      getCurrentPathMapper: () => {
        calls.push('mapper');
        return missing === 'mapper'
          ? null
          : { model: { viewStartBp: 0, viewEndBp: 4000 }, pixelsPerBp: 0.1 };
      },
      getTrackDiagnostics: (id: unknown) => {
        expect(id).toBe('reads');
        calls.push('diagnostic');
        return missing === 'diagnostic' ? null : diagnostic;
      },
      getColdGestureSnapshot: () => {
        calls.push('coldSnapshot');
        return null;
      },
      getReadPresentationSnapshot: () => {
        throw new Error('Retention added a read-presentation call');
      },
    },
    __tileEngineDebug: () => {
      calls.push('driver');
      return missing === 'driver' ? {} : { reads: driver };
    },
    __test: {
      getCanvasStore: () => ({ panels: { main: { tabs: [{ id: 'tab', indexedGenome: {} }] } } }),
    },
  };
  const documentValue = {
    querySelector: (selector: string) => {
      if (selector.startsWith('[data-testid="aligned-read-gutter-status-')) {
        return {
          getAttribute: (name: string) =>
            name === 'data-testid' ? 'aligned-read-gutter-status-reads' : 'ready',
          getClientRects: () => [{}],
          textContent: 'Reads ready',
        };
      }
      if (selector.startsWith('[role="tab"]')) return { getAttribute: () => 'tab' };
      return null;
    },
  };
  const receipt: RecordValue = {};
  const page = {
    evaluate: async (callback: unknown, argument: unknown) => {
      calls.push('evaluate');
      time.advance(10);
      if (thrown !== undefined) throw thrown;
      time.browser(true);
      try {
        return callable(callback)(argument);
      } finally {
        time.browser(false);
      }
    },
  };
  const bindings = {
    performance: time.performance,
    window: windowValue,
    document: documentValue,
    classifyPileupAnnotation,
    pileupCoverageCoversViewport,
    pileupRangeMatchesViewport,
  };
  return {
    run: () => subject('observation', bindings)(page, lane, 150, receipt),
    receipt,
    calls,
    lane,
    diagnostic,
    lifecycle,
    timings,
    paint,
  };
}

function unavailable(value: unknown, field: string): void {
  const fields = record(value).unavailableFields;
  assert.ok(Array.isArray(fields));
  const entry = fields.map(record).find((item) => item.field === field);
  assert.ok(entry, `Missing explicit unavailable field ${field}`);
  expect(entry.reason).toEqual(expect.stringMatching(/\S/));
}

describe('existing pileup journey diagnostic retention', () => {
  it('1 retains visible Files-panel awaits without changing the original opening', async () => {
    const f = openFixture(true);
    await f.run('cold', 'cold-open', '/unit/saved.json');
    expect(f.calls).toEqual([
      'savedFileRow',
      'dblclick',
      'waitForViewer',
      'getByRole',
      'isVisible',
      'getByTestId',
      'click',
      'hidden',
      'poll',
      'activeLane',
      'complete',
      'stat',
      'record',
    ]);
    expect(f.phases).toHaveLength(1);
    expect(f.phases[0].elapsedMs).toBe(145);
    const opening = f.openings[0];
    expect(record(opening).stages).toEqual([
      expect.objectContaining({ stage: 'before-dblclick', elapsedMs: 0 }),
      expect.objectContaining({ stage: 'after-dblclick', elapsedMs: 20 }),
      expect.objectContaining({ stage: 'viewer-visible', elapsedMs: 50 }),
      expect.objectContaining({ stage: 'files-hidden', elapsedMs: 100 }),
      expect.objectContaining({ stage: 'lane-ready', elapsedMs: 105 }),
      expect.objectContaining({ stage: 'first-complete', elapsedMs: 145 }),
    ]);
    const files = record(record(opening.retention).filesPanel);
    expect(files).toMatchObject({
      branch: 'hide',
      clickDisposition: 'executed',
      hiddenDisposition: 'executed',
      isVisible: { startMs: 1055, endMs: 1065, outcome: 'fulfilled', value: true },
      click: { startMs: 1065, endMs: 1080, outcome: 'fulfilled' },
      hidden: { startMs: 1080, endMs: 1105, outcome: 'fulfilled' },
    });
  });

  it('2 records the already-hidden branch without a fabricated click or hidden wait', async () => {
    const f = openFixture(false);
    await f.run('cold', 'cold-open', '/unit/saved.json');
    expect(f.calls).toEqual([
      'savedFileRow',
      'dblclick',
      'waitForViewer',
      'getByRole',
      'isVisible',
      'poll',
      'activeLane',
      'complete',
      'stat',
      'record',
    ]);
    expect(f.phases[0].elapsedMs).toBe(105);
    expect(record(record(f.openings[0].retention).filesPanel)).toMatchObject({
      branch: 'already-hidden',
      clickDisposition: 'not-taken',
      hiddenDisposition: 'not-taken',
      click: null,
      hidden: null,
      isVisible: { startMs: 1055, endMs: 1065, outcome: 'fulfilled', value: false },
    });
  });

  it.each(['isVisible', 'click', 'hidden'] as const)(
    '3 preserves the original %s rejection and reached-prefix receipt',
    async (operation) => {
      for (const error of [new Error('original rejection'), 'original primitive rejection']) {
        const f = openFixture(true, operation, error);
        expect(await rejection(() => f.run('cold', 'cold-open', '/unit/saved.json'))).toBe(error);
        expect(f.phases).toHaveLength(0);
        expect(f.openings).toHaveLength(1);
        const files = record(record(f.openings[0].retention).filesPanel);
        expect(record(files[operation]).outcome).toBe('rejected');
        expect(record(files[operation]).endMs).toBeGreaterThan(
          Number(record(files[operation]).startMs)
        );
        if (operation === 'isVisible') {
          expect(files).toMatchObject({
            branch: 'unresolved',
            click: null,
            hidden: null,
            clickDisposition: 'not-reached',
            hiddenDisposition: 'not-reached',
          });
          expect(f.calls.at(-1)).toBe('isVisible');
        } else if (operation === 'click') {
          expect(files).toMatchObject({
            branch: 'hide',
            hidden: null,
            hiddenDisposition: 'not-reached',
          });
          expect(f.calls.at(-1)).toBe('click');
        } else expect(f.calls.at(-1)).toBe('hidden');
      }
    }
  );

  it('4 preserves all120dispatches and the last-dispatch elapsed origin across later waits', async () => {
    const f = wheelFixture();
    const result = record(await f.run());
    expect(f.sends).toHaveLength(120);
    for (const send of f.sends) {
      expect(plain(send)).toEqual({
        method: 'Input.dispatchMouseEvent',
        args: {
          type: 'mouseWheel',
          x: 110,
          y: 70,
          deltaX: 0,
          deltaY: 25,
          modifiers: 2,
        },
      });
    }
    expect(f.calls).toEqual([
      'bounds',
      'move',
      'startCadence',
      ...Array(120).fill('dispatch'),
      'acknowledgment',
      'stopCadence',
    ]);
    expect(result.finalInput).toBe(1190);
    expect(result.inputStartEpochMs).toBe(900000);
    expect(result.inputEndEpochMs).toBe(902000);
    expect(result.cadence).toBe(f.cadence);
    expect(result.requestedWheel).toEqual({ eventCount: 120, deltaY: 3000, modifiers: 2 });
    expect(result.inputRetention).toBe(f.receipt);
    expect(f.receipt).toMatchObject({
      clock: 'nodeMonotonicMs',
      lastDispatchMs: 1190,
      acknowledgment: { startMs: 1190, endMs: 1390, outcome: 'fulfilled' },
      cadenceStop: { startMs: 1390, endMs: 1490, outcome: 'fulfilled' },
    });
  });

  it.each(['acknowledgment', 'cadenceStop'] as const)(
    '5 preserves the original %s rejection without retry or later work',
    async (operation) => {
      for (const error of [new Error('original wheel rejection'), 'primitive wheel rejection']) {
        const f = wheelFixture(operation, error);
        expect(await rejection(f.run)).toBe(error);
        expect(f.sends).toHaveLength(120);
        expect(record(f.receipt[operation]).outcome).toBe('rejected');
        expect(f.receipt.lastDispatchMs).toBe(1190);
        if (operation === 'acknowledgment') expect(f.calls).not.toContain('stopCadence');
        else expect(f.calls.filter((name) => name === 'stopCadence')).toHaveLength(1);
      }
    }
  );

  it('6 accounts for existing unchanged/null polls without altering sparse settlement', async () => {
    const f = completeFixture([null, state(false, 1), state(false, 2), state(true, 2)]);
    const result = record(await f.run());
    expect(f.delays).toEqual([50, 50, 50]);
    expect(f.failures).toEqual([]);
    expect(result.elapsedMs).toBe(190);
    expect((result.settlement as unknown[]).map((value) => record(value).elapsedMs)).toEqual([
      70, 190,
    ]);
    expect(result.observationRetention).toBe(f.receipt);
    expect(f.receipt).toMatchObject({
      clock: 'nodeMonotonicMs',
      attempts: 4,
      completed: 4,
      absent: 1,
      rejected: 0,
      unchanged: 1,
      signatureChanges: 2,
      distinctSignatures: 2,
    });
    const polls = (f.receipt.polls as unknown[]).map(record);
    expect(
      polls.map((poll) => [
        poll.index,
        poll.startMs,
        poll.endMs,
        poll.outcome,
        poll.signatureChanged,
      ])
    ).toEqual([
      [1, 0, 10, 'absent', null],
      [2, 60, 70, 'observed', true],
      [3, 120, 130, 'observed', false],
      [4, 180, 190, 'observed', true],
    ]);
    expect(polls.map((poll) => poll.evaluation)).toEqual([
      { startMs: 0, endMs: 10, outcome: 'fulfilled' },
      { startMs: 60, endMs: 70, outcome: 'fulfilled' },
      { startMs: 120, endMs: 130, outcome: 'fulfilled' },
      { startMs: 180, endMs: 190, outcome: 'fulfilled' },
    ]);
    expect(
      record(record(polls[1].retainedPreparation).diagnosticCounters)
        .rowsAssignmentBuildRecordsLastFrame
    ).toBe(1);
    expect(
      record(record(polls[2].retainedPreparation).diagnosticCounters)
        .rowsAssignmentBuildRecordsLastFrame
    ).toBe(2);
  });

  it('7 preserves the original timeout and rejected-observation semantics', async () => {
    const timed = completeFixture([null], 10001);
    const result = record(await timed.run());
    expect(result.elapsedMs).toBe(10051);
    expect(timed.delays).toEqual([50]);
    expect(timed.failures).toEqual(['Viewport did not settle: null']);
    expect(timed.receipt).toMatchObject({ attempts: 1, completed: 1, absent: 1, rejected: 0 });
    for (const error of [
      new Error('original observation rejection'),
      'primitive observation rejection',
    ]) {
      const failed = completeFixture([], 7, error);
      expect(await rejection(failed.run)).toBe(error);
      expect(failed.delays).toEqual([]);
      expect(failed.failures).toEqual([]);
      expect(failed.receipt).toMatchObject({ attempts: 1, completed: 0, absent: 0, rejected: 1 });
      const poll = record((failed.receipt.polls as unknown[])[0]);
      expect(poll).toMatchObject({
        startMs: 0,
        endMs: 7,
        outcome: 'rejected',
        signatureChanged: null,
        evaluation: { startMs: 0, endMs: 7, outcome: 'rejected' },
      });
    }
  });

  it('8 reads the actual existing observation chain and preserves the original fields', async () => {
    const f = observationFixture();
    const result = record(await f.run());
    expect(f.calls).toEqual(['evaluate', 'mapper', 'diagnostic', 'driver', 'coldSnapshot']);
    expect(result.viewport).toEqual({
      startBp: 0,
      endBp: 4000,
      sourceGenerationKey: 'expected-generation',
      sourceFraction: 1,
      meshFraction: 1,
      recordCount: 2,
      truncated: false,
      pendingTiles: 0,
      rowsAlpha: 1,
      densityAlpha: 0,
      physicalReadPx: 15,
      coverageStartBp: 0,
      coverageEndBp: 4000,
    });
    expect(result.checks).toEqual({
      sourceComplete: true,
      meshComplete: true,
      currentGeneration: true,
      untruncated: true,
      tilesComplete: true,
      visible: true,
      densityMatchesScale: true,
      lifecycleReady: true,
      lifecycleCurrentSource: true,
      lifecycleCurrentRequest: true,
      lifecycleCurrentPlan: true,
      presentationCommitted: true,
      gutterReady: true,
      densityCoversViewport: true,
      annotationsCurrent: false,
      lifecycleCurrentRange: true,
      lifecyclePresentedRange: true,
    });
    expect(result.preparation).toEqual({
      rowsAssignmentBuilding: false,
      rowsMeshBuilding: false,
      rowsMeshRecordCursor: 0,
      rowsMeshTargetRecordCount: 2,
      corridorFloorState: 'ready',
      residentBandReady: true,
      residentReadyTileCount: 4,
      residentExpectedTileCount: 4,
      lifecyclePhase: 'ready',
      lifecycleRequestSequence: 3,
      lifecyclePlanKey: 'plan-1',
      lifecycleCurrentPlanKey: 'plan-1',
      presentationPending: false,
      gutterPhase: 'ready',
    });
    expect(f.receipt.evaluation).toEqual({ startMs: 0, endMs: 10, outcome: 'fulfilled' });
    const retained = record(result.retainedPreparation);
    expect(plain(retained.recordsCommitTiming)).toEqual(f.timings);
    expect(plain(retained.paintTiming)).toEqual(f.paint);
    expect(retained.identity).toMatchObject({
      expectedLaneTrackId: 'reads',
      expectedGenerationKey: 'expected-generation',
      rowsMeshGenerationKey: 'mesh|expected-generation|records-1',
      sourceKey: 'source|expected-generation',
      generation: 2,
      requestSequence: 3,
      planKey: 'plan-1',
      currentPlanKey: 'plan-1',
      sourceGenerationKey: null,
      presentationOwnerKey: null,
    });
    unavailable(retained, 'identity.sourceGenerationKey');
    unavailable(retained, 'identity.presentationOwnerKey');
  });

  it('9 distinguishes unavailable values from measured zero or false', async () => {
    const f = observationFixture();
    f.timings.assignMs = Number.NaN;
    f.timings.totalMs = Number.POSITIVE_INFINITY;
    f.timings.recordCount = '2';
    f.timings.assignmentPending = 'false';
    delete f.timings.occupancyMs;
    f.diagnostic.rowsAssignmentBuildRecordsLastFrame = undefined;
    f.diagnostic.rowsMeshBuildChunkCount = 0;
    f.diagnostic.rowsMeshBuildTargetMatchesRecordsKey = false;
    f.lifecycle.sourceKey = '';
    f.lifecycle.planKey = '';
    f.lifecycle.generation = undefined;
    const result = record(await f.run());
    const retained = record(result.retainedPreparation);
    const timing = record(retained.recordsCommitTiming);
    for (const field of [
      'assignMs',
      'totalMs',
      'recordCount',
      'assignmentPending',
      'occupancyMs',
    ]) {
      expect(timing[field]).toBeNull();
      unavailable(retained, `recordsCommitTiming.${field}`);
    }
    expect(timing.finishAssignmentMs).toBe(0);
    expect(timing.retainScheduled).toBe(false);
    const counters = record(retained.diagnosticCounters);
    expect(counters.rowsAssignmentBuildRecordsLastFrame).toBeNull();
    unavailable(retained, 'diagnosticCounters.rowsAssignmentBuildRecordsLastFrame');
    expect(counters.rowsMeshBuildChunkCount).toBe(0);
    expect(counters.rowsMeshBuildTargetMatchesRecordsKey).toBe(false);
    expect(record(retained.identity)).toMatchObject({
      sourceKey: '',
      planKey: '',
      generation: null,
    });
    for (const field of ['sourceKey', 'planKey', 'generation'])
      unavailable(retained, `identity.${field}`);
    expect(record(result.checks)).toMatchObject({
      lifecycleCurrentSource: false,
      lifecycleCurrentRequest: false,
      lifecycleCurrentPlan: false,
    });
    const absent = observationFixture();
    absent.diagnostic.recordsCommitTiming = null;
    delete absent.diagnostic.paintTiming;
    const missing = record(record(await absent.run()).retainedPreparation);
    expect(missing.recordsCommitTiming).toBeNull();
    expect(missing.paintTiming).toBeNull();
    unavailable(missing, 'recordsCommitTiming');
    unavailable(missing, 'paintTiming');
  });

  it.each(['mapper', 'diagnostic', 'driver'] as const)(
    '9 keeps an absent %s observation null with an honest evaluation interval',
    async (missing) => {
      const f = observationFixture(missing);
      expect(await f.run()).toBeNull();
      expect(f.calls).toEqual(['evaluate', 'mapper', 'diagnostic', 'driver']);
      expect(f.receipt.evaluation).toEqual({ startMs: 0, endMs: 10, outcome: 'fulfilled' });
    }
  );

  it('9 preserves an evaluation rejection without certifying an absent observation', async () => {
    const error = new Error('original page evaluation rejection');
    const f = observationFixture(undefined, error);
    expect(await rejection(f.run)).toBe(error);
    expect(f.calls).toEqual(['evaluate']);
    expect(f.receipt.evaluation).toEqual({ startMs: 0, endMs: 10, outcome: 'rejected' });
  });

  it('10 copies retained primitives so later owner mutation cannot rewrite the observation', async () => {
    const f = observationFixture();
    const result = record(await f.run());
    const retained = record(result.retainedPreparation);
    const before = plain(retained);
    expect(retained.recordsCommitTiming).not.toBe(f.timings);
    expect(retained.paintTiming).not.toBe(f.paint);
    expect(retained.identity).not.toBe(f.lifecycle);
    f.timings.assignMs = 999;
    f.paint.totalMs = 999;
    f.diagnostic.rowsMeshBuildChunkCount = 999;
    f.lifecycle.sourceKey = 'later-source';
    f.lifecycle.requestSequence = 999;
    f.lifecycle.planKey = 'later-plan';
    f.lane.generationKey = 'later-expected-generation';
    expect(plain(retained)).toEqual(before);
  });
});

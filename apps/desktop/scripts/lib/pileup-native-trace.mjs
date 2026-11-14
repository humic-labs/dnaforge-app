import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { parseChromiumPresentationTrace } from './chromium-presentation-trace.mjs';
import { classifyChromiumSurfaceFrameBudget } from './chromium-surface-frame-budget.mjs';

const compress = promisify(gzip);
const categories =
  'cc,benchmark,gpu,viz,blink.user_timing,disabled-by-default-devtools.timeline.frame';

async function finishTrace(cdp) {
  let listener;
  let timer;
  const completion = new Promise((resolve, reject) => {
    listener = resolve;
    cdp.once('Tracing.tracingComplete', listener);
    timer = setTimeout(
      () => reject(new Error('Chromium did not finish the presentation trace.')),
      30_000
    );
  });
  try {
    await cdp.send('Tracing.end');
    const result = await completion;
    assert.ok(result.stream, 'Chromium omitted the trace stream.');
    const chunks = [];
    try {
      for (;;) {
        const chunk = await cdp.send('IO.read', { handle: result.stream });
        chunks.push(
          chunk.base64Encoded ? Buffer.from(chunk.data, 'base64').toString('utf8') : chunk.data
        );
        if (chunk.eof) break;
        assert.ok(chunk.data.length, 'Chromium trace reading made no progress.');
      }
    } finally {
      await cdp.send('IO.close', { handle: result.stream });
    }
    return { ...JSON.parse(chunks.join('')), dataLossOccurred: result.dataLossOccurred };
  } finally {
    clearTimeout(timer);
    cdp.off('Tracing.tracingComplete', listener);
  }
}

export function createPileupNativeTrace({ output, refreshHz, diagnosticOnly = false }) {
  assert.ok(path.isAbsolute(output), 'Native traces require an absolute evidence directory.');
  if (!diagnosticOnly)
    assert.ok([60, 120].includes(refreshHz), 'Declare the actual 60 Hz or 120 Hz display target.');
  const phases = [];
  let journeyCdp = null;
  let finalization = null;
  async function presentation(
    trace,
    { label, token, inputStartEpochMs, inputEndEpochMs, cadence }
  ) {
    const name = label.replace(/[^a-z0-9-]/giu, '_');
    const markers = (trace.traceEvents ?? []).filter(
      (event) =>
        event.name === token.rendererMarker &&
        Number.isSafeInteger(event.pid) &&
        Number.isFinite(event.ts)
    );
    const marker = markers.length === 1 ? markers[0] : null;
    if (!marker || !cadence)
      return { status: 'invalid', failures: ['exact-renderer-marker-or-input-window-missing'] };
    const parsed = parseChromiumPresentationTrace(trace, {
      measurementStartSyncId: token.startSyncId,
      measurementEndSyncId: token.endSyncId,
      targetPid: marker.pid,
    });
    const scoringWindowTraceTimestampsUs = {
      start: marker.ts + (inputStartEpochMs - token.markerEpochMs) * 1000,
      end: marker.ts + (inputEndEpochMs - token.markerEpochMs) * 1000,
    };
    const result = classifyChromiumSurfaceFrameBudget(parsed, {
      requestedMeasurementDurationMs: cadence.durationMs,
      budgetMs: refreshHz === 60 ? 16.7 : 8.3,
      scoringWindowTraceTimestampsUs,
    });
    const capturedToken = { ...token };
    delete capturedToken.result;
    await writeFile(
      path.join(output, `${name}.presentation.json`),
      JSON.stringify(
        { parsed, result, token: capturedToken, scoringWindowTraceTimestampsUs },
        null,
        2
      )
    );
    return {
      status: result.status === 'invalid' ? 'invalid' : 'valid',
      targetMatched: parsed.target?.pid === marker.pid && parsed.target?.surfaceId != null,
      target: parsed.target,
      refreshHz,
      durationMs: result.traceBoundaryDurationMs,
      requestedDurationMs: cadence.durationMs,
      expectedFrameCount: result.expectedRefreshOutcomeCount,
      observedFrameCount: result.refreshOutcomeCount,
      droppedFrames: result.droppedFrameCount,
      partialFrames: result.partialFrameCount,
      missingContentFrames: result.missingContentFrameCount,
      failures: result.failures,
    };
  }
  return {
    async beginJourney({ cdp }) {
      if (diagnosticOnly) return;
      assert.ok(!journeyCdp && !finalization, 'The native trace journey already started.');
      await cdp.send('Tracing.start', {
        traceConfig: {
          recordMode: 'recordUntilFull',
          traceBufferSizeInKb: 262144,
          includedCategories: categories.split(','),
        },
        transferMode: 'ReturnAsStream',
        streamFormat: 'json',
      });
      journeyCdp = cdp;
    },
    async finishJourney({ cdp, page }) {
      if (diagnosticOnly || !journeyCdp) return;
      assert.equal(cdp, journeyCdp, 'The native trace belongs to another CDP session.');
      finalization ??= (async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const trace = await finishTrace(cdp);
        await mkdir(output, { recursive: true });
        await writeFile(
          path.join(output, 'journey.trace.json.gz'),
          await compress(JSON.stringify(trace))
        );
        for (const phase of phases) {
          Object.assign(
            phase.token.result,
            phase.aborted || !phase.cadence
              ? { status: 'invalid', failures: ['native-input-window-aborted-or-missing'] }
              : await presentation(trace, phase)
          );
          await page.evaluate(
            (marker) => performance.clearMarks(marker),
            phase.token.rendererMarker
          );
        }
      })().catch((error) => {
        for (const phase of phases)
          Object.assign(phase.token.result, { status: 'invalid', failures: [String(error)] });
        throw error;
      });
      await finalization;
    },
    async start({ label, page, cdp }) {
      if (diagnosticOnly && label !== 'zoom-26612bp') return null;
      if (!diagnosticOnly)
        assert.ok(journeyCdp === cdp && !finalization, 'The native trace journey is not active.');
      const id = randomUUID();
      const token = {
        startSyncId: `pileup-start-${id}`,
        endSyncId: `pileup-end-${id}`,
        rendererMarker: `pileup-renderer-${id}`,
      };
      try {
        if (diagnosticOnly) {
          await cdp.send('Profiler.enable');
          await cdp.send('Profiler.setSamplingInterval', { interval: 1000 });
          await cdp.send('Profiler.start');
          token.cpuProfiling = true;
          await cdp.send('Tracing.start', {
            categories: `${categories},toplevel,devtools.timeline,v8,disabled-by-default-v8.gc`,
            transferMode: 'ReturnAsStream',
            streamFormat: 'json',
          });
          token.traceStarted = true;
        }
        await cdp.send('Tracing.recordClockSyncMarker', { syncId: token.startSyncId });
        token.markerEpochMs = await page.evaluate((marker) => {
          const mark = performance.mark(marker);
          return performance.timeOrigin + mark.startTime;
        }, token.rendererMarker);
        if (!diagnosticOnly) {
          token.result = {
            status: 'unqualified',
            failures: ['native-presentation-pending-finalization'],
          };
          phases.push({ label, token });
        }
        return token;
      } catch (error) {
        if (token.traceStarted) await finishTrace(cdp).catch(() => {});
        if (token.cpuProfiling) {
          await cdp.send('Profiler.stop').catch(() => {});
          await cdp.send('Profiler.disable').catch(() => {});
        }
        throw error;
      }
    },
    async stop({ label, token, page, cdp, inputStartEpochMs, inputEndEpochMs, cadence, aborted }) {
      if (!token) return null;
      if (!diagnosticOnly) {
        const phase = phases.find((candidate) => candidate.token === token);
        assert.ok(
          phase && !phase.stopped && !finalization,
          'The native input window is not active.'
        );
        Object.assign(phase, {
          inputStartEpochMs,
          inputEndEpochMs,
          cadence,
          aborted: Boolean(aborted),
          stopped: true,
        });
        await cdp.send('Tracing.recordClockSyncMarker', { syncId: token.endSyncId });
        return token.result;
      }
      let cpuProfile;
      if (token.cpuProfiling) {
        try {
          cpuProfile = (await cdp.send('Profiler.stop')).profile;
        } catch (error) {
          token.cpuProfileError = String(error);
        } finally {
          await cdp.send('Profiler.disable').catch((error) => {
            token.cpuProfileError = String(error);
          });
        }
      }
      await cdp.send('Tracing.recordClockSyncMarker', { syncId: token.endSyncId });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const trace = await finishTrace(cdp);
      await page.evaluate((marker) => performance.clearMarks(marker), token.rendererMarker);
      await mkdir(output, { recursive: true });
      const name = label.replace(/[^a-z0-9-]/giu, '_');
      await writeFile(
        path.join(output, `${name}.trace.json.gz`),
        await compress(JSON.stringify(trace))
      );
      if (diagnosticOnly) {
        if (cpuProfile)
          await writeFile(path.join(output, `${name}.cpuprofile`), JSON.stringify(cpuProfile));
        await writeFile(
          path.join(output, `${name}.diagnostic.json`),
          JSON.stringify({ token, inputStartEpochMs, inputEndEpochMs, cadence }, null, 2)
        );
        return {
          status: 'unqualified',
          failures: ['diagnostic-only-no-declared-display-target'],
          diagnosticFiles: [
            `${name}.trace.json.gz`,
            ...(cpuProfile ? [`${name}.cpuprofile`] : []),
            `${name}.diagnostic.json`,
          ],
        };
      }
    },
  };
}

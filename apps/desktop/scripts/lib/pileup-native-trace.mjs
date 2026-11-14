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
  return {
    async start({ label, page, cdp }) {
      if (diagnosticOnly && label !== 'zoom-26612bp') return null;
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
        }
        await cdp.send('Tracing.start', {
          categories: diagnosticOnly
            ? `${categories},toplevel,devtools.timeline,v8,disabled-by-default-v8.gc`
            : categories,
          transferMode: 'ReturnAsStream',
          streamFormat: 'json',
        });
        token.traceStarted = true;
        await cdp.send('Tracing.recordClockSyncMarker', { syncId: token.startSyncId });
        token.markerEpochMs = await page.evaluate((marker) => {
          const mark = performance.mark(marker);
          return performance.timeOrigin + mark.startTime;
        }, token.rendererMarker);
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
    async stop({ label, token, page, cdp, inputStartEpochMs, inputEndEpochMs, cadence }) {
      if (!token) return null;
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
      await writeFile(
        path.join(output, `${name}.presentation.json`),
        JSON.stringify({ parsed, result, token, scoringWindowTraceTimestampsUs }, null, 2)
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
    },
  };
}

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { createGzip, gzip } from 'node:zlib';
import { parseChromiumPresentationTrace } from './chromium-presentation-trace.mjs';
import { classifyChromiumSurfaceFrameBudget } from './chromium-surface-frame-budget.mjs';

const compress = promisify(gzip);
const categories =
  'cc,benchmark,gpu,viz,blink.user_timing,disabled-by-default-devtools.timeline.frame';

async function finishTrace(cdp, outputPath) {
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
    const compressed = outputPath ? createGzip() : null;
    const partialPath = outputPath ? `${outputPath}.partial` : null;
    const written = compressed ? pipeline(compressed, createWriteStream(partialPath)) : null;
    written?.catch(() => {});
    let rawBytes = 0;
    try {
      try {
        for (;;) {
          const chunk = await cdp.send('IO.read', { handle: result.stream });
          const bytes = Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8');
          rawBytes += bytes.length;
          if (compressed) {
            if (!compressed.write(bytes)) await Promise.race([once(compressed, 'drain'), written]);
          } else {
            chunks.push(bytes.toString('utf8'));
          }
          if (chunk.eof) break;
          assert.ok(chunk.data.length, 'Chromium trace reading made no progress.');
        }
      } finally {
        await cdp.send('IO.close', { handle: result.stream });
      }
      if (compressed) {
        compressed.end();
        await written;
        await rename(partialPath, outputPath);
        return { dataLossOccurred: result.dataLossOccurred, rawBytes };
      }
      return { ...JSON.parse(chunks.join('')), dataLossOccurred: result.dataLossOccurred };
    } catch (error) {
      compressed?.destroy(error);
      await written?.catch(() => {});
      throw error;
    }
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
  let diagnosticCapture = null;
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
  async function finishDiagnostic({ page, cdp, ...phase }) {
    if (!diagnosticCapture) return;
    assert.equal(cdp, journeyCdp, 'The diagnostic trace belongs to another CDP session.');
    finalization ??= (async () => {
      const token = diagnosticCapture.token ?? {};
      let cpuProfile;
      let error;
      try {
        cpuProfile = (await cdp.send('Profiler.stop')).profile;
      } catch (failure) {
        token.cpuProfileError = String(failure);
      } finally {
        await cdp.send('Profiler.disable').catch((failure) => {
          token.cpuProfileError = String(failure);
        });
      }
      let trace;
      try {
        trace = await finishTrace(cdp, path.join(output, 'zoom-26612bp.trace.json.gz'));
      } catch (failure) {
        error = failure;
        token.traceError = String(failure);
      }
      if (cpuProfile)
        await writeFile(path.join(output, 'zoom-26612bp.cpuprofile'), JSON.stringify(cpuProfile));
      if (token.rendererMarker)
        await page
          .evaluate((marker) => performance.clearMarks(marker), token.rendererMarker)
          .catch((failure) => {
            error ??= failure;
            token.markerCleanupError = String(failure);
          });
      await writeFile(
        path.join(output, 'zoom-26612bp.diagnostic.json'),
        JSON.stringify(
          {
            token,
            captureStartedAtEpochMs: diagnosticCapture.startedAtEpochMs,
            captureScope: 'after-fixture-admission-through-first-zoom',
            ...phase,
            trace,
          },
          null,
          2
        )
      );
      if (error) throw error;
      return {
        status: 'unqualified',
        failures: [
          'diagnostic-only-no-declared-display-target',
          ...(token.cpuProfileError ? ['diagnostic-cpu-profile-unavailable'] : []),
          ...(trace.dataLossOccurred ? ['diagnostic-trace-data-loss'] : []),
        ],
        diagnosticFiles: [
          'zoom-26612bp.trace.json.gz',
          ...(cpuProfile ? ['zoom-26612bp.cpuprofile'] : []),
          'zoom-26612bp.diagnostic.json',
        ],
      };
    })();
    return finalization;
  }

  return {
    async beginJourney({ cdp }) {
      assert.ok(!journeyCdp && !finalization, 'The native trace journey already started.');
      if (diagnosticOnly) {
        await mkdir(output, { recursive: true });
        let profiling = false;
        try {
          await cdp.send('Profiler.enable');
          await cdp.send('Profiler.setSamplingInterval', { interval: 1000 });
          await cdp.send('Profiler.start');
          profiling = true;
          await cdp.send('Tracing.start', {
            categories: `${categories},toplevel,devtools.timeline,v8,disabled-by-default-v8.gc`,
            transferMode: 'ReturnAsStream',
            streamFormat: 'json',
          });
          diagnosticCapture = { startedAtEpochMs: Date.now(), token: null };
          journeyCdp = cdp;
        } catch (error) {
          if (profiling) await cdp.send('Profiler.stop').catch(() => {});
          await cdp.send('Profiler.disable').catch(() => {});
          throw error;
        }
        return;
      }
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
      if (diagnosticOnly)
        return finishDiagnostic({ page, cdp, aborted: true, reason: 'first-zoom-not-completed' });
      if (!journeyCdp) return;
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
      assert.ok(journeyCdp === cdp && !finalization, 'The native trace journey is not active.');
      const id = randomUUID();
      const token = {
        startSyncId: `pileup-start-${id}`,
        endSyncId: `pileup-end-${id}`,
        rendererMarker: `pileup-renderer-${id}`,
      };
      try {
        if (diagnosticOnly) diagnosticCapture.token = token;
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
        if (diagnosticOnly)
          await finishDiagnostic({ page, cdp, aborted: true, reason: String(error) }).catch(
            () => {}
          );
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
      await cdp.send('Tracing.recordClockSyncMarker', { syncId: token.endSyncId });
      return finishDiagnostic({
        page,
        cdp,
        inputStartEpochMs,
        inputEndEpochMs,
        cadence,
        aborted: Boolean(aborted),
      });
    },
  };
}

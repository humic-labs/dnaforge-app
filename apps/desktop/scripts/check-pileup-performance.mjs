import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { runPileupPerformanceJourney } from './lib/pileup-performance-journey.mjs';
import { classifyPileupPerformance } from './lib/pileup-performance.mjs';
import { createPileupNativeTrace } from './lib/pileup-native-trace.mjs';

const { values } = parseArgs({
  options: {
    'debug-port': { type: 'string' },
    'api-port': { type: 'string' },
    'renderer-port': { type: 'string' },
    output: { type: 'string' },
    fixture: { type: 'string' },
    profile: { type: 'string', default: 'portable-dense' },
    'native-refresh-hz': { type: 'string' },
  },
});
const port = (name) => {
  const value = Number(values[name]);
  assert.ok(
    Number.isInteger(value) && value > 0 && value < 65536,
    `--${name} must identify the running task-owned app.`
  );
  return value;
};
const debugPort = port('debug-port');
const apiPort = port('api-port');
const rendererPort = port('renderer-port');
assert.ok(values.output, '--output is required.');
const output = path.resolve(values.output);
await mkdir(output, { recursive: true });
const fixture = values.fixture ? JSON.parse(await readFile(values.fixture, 'utf8')) : undefined;
const nativeTrace = values['native-refresh-hz']
  ? createPileupNativeTrace({
      output: path.join(output, 'native'),
      refreshHz: Number(values['native-refresh-hz']),
    })
  : undefined;
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
try {
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) =>
      new RegExp(`^http://(localhost|127\\.0\\.0\\.1):${rendererPort}/`, 'u').test(candidate.url())
    );
  assert.ok(page, 'The requested desktop renderer is missing.');
  const report = await runPileupPerformanceJourney({
    page,
    output,
    apiPort,
    profile: values.profile,
    fixture,
    nativeTrace,
  });
  const result = classifyPileupPerformance(report);
  await writeFile(
    path.join(output, 'pileup-performance-result.json'),
    JSON.stringify(result, null, 2)
  );
  console.log(JSON.stringify(result));
  if (result.status !== 'pass') process.exitCode = 1;
} finally {
  await browser.close();
}

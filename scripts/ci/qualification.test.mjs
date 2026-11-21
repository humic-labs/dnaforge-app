import assert from 'node:assert/strict';
import test from 'node:test';
import {
  inspectDesktopReports,
  inspectNativeReports,
  isMainBootstrapEvent,
} from './qualification.mjs';

const journeys = ['workspace', 'track', 'genome', 'canvas', 'chat', 'palettes'];

test('main bootstrap uses the event target even when the queue ref names a temporary branch', () => {
  const queueRef = 'refs/heads/gh-readonly-queue/main/pr-97-example';
  const event = { merge_group: { base_ref: 'refs/heads/main' } };
  assert.equal(isMainBootstrapEvent('merge_group', event, queueRef), true);
  assert.equal(
    isMainBootstrapEvent('merge_group', { merge_group: { base_ref: 'refs/heads/dev' } }, queueRef),
    false
  );
  assert.equal(isMainBootstrapEvent('pull_request', event, queueRef), false);
  assert.equal(isMainBootstrapEvent('push', {}, 'refs/heads/main'), true);
  assert.equal(
    isMainBootstrapEvent(
      'pull_request',
      { pull_request: { base: { ref: 'main' } } },
      'refs/pull/97/merge'
    ),
    true
  );
  assert.equal(isMainBootstrapEvent('workflow_dispatch', {}, 'refs/heads/main'), false);
});

function manifest() {
  return {
    sourceSha: '1'.repeat(40),
    sourceTree: '2'.repeat(40),
    controlSha: '3'.repeat(40),
    runId: '123456',
    attempt: 1,
    desktopShards: [1, 2, 3, 4, 5, 6, 7, 8],
  };
}

function desktopFixture() {
  const source = manifest();
  const expectedFiles = source.desktopShards.map(
    (shard) => `apps/desktop/src/feature-${shard}.test.ts`
  );
  const reports = source.desktopShards.map((shard) => {
    const name = expectedFiles[shard - 1];
    return {
      kind: 'desktop',
      ...source,
      shard,
      shards: source.desktopShards.length,
      expectedFiles: [name],
      result: {
        success: true,
        numTotalTestSuites: 1,
        numPassedTestSuites: 1,
        numFailedTestSuites: 0,
        numPendingTestSuites: 0,
        numRuntimeErrorTestSuites: 0,
        numTotalTests: 1,
        numPassedTests: 1,
        numFailedTests: 0,
        numPendingTests: 0,
        numTodoTests: 0,
        testResults: [
          {
            name,
            status: 'passed',
            message: '',
            assertionResults: [
              {
                ancestorTitles: ['document'],
                fullName: 'document persists a save',
                title: 'persists a save',
                status: 'passed',
                failureMessages: [],
              },
            ],
          },
        ],
      },
    };
  });
  return { manifest: source, reports, expectedFiles, skipBudget: {} };
}

function nativeFixture() {
  const source = manifest();
  return {
    manifest: source,
    journeys: [...journeys],
    reports: journeys.map((journey) => ({
      kind: 'native',
      ...source,
      journey,
      status: 'passed',
    })),
  };
}

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function addPendingTest(input, count = 1) {
  const report = input.reports[0];
  report.result.numTotalTests += count;
  report.result.numPendingTests += count;
  for (let index = 0; index < count; index += 1) {
    report.result.testResults[0].assertionResults.push({
      ancestorTitles: ['document'],
      fullName: `document requires native fixture ${index}`,
      title: `requires native fixture ${index}`,
      status: 'pending',
      failureMessages: [],
    });
  }
}

test('desktop qualification accepts a complete source-bound eight-shard run without mutating it', () => {
  const input = desktopFixture();
  const original = structuredClone(input);
  assert.doesNotThrow(() => inspectDesktopReports(freeze(input)));
  assert.deepEqual(input, original);
});

test('desktop qualification accepts reports in a different arrival order', () => {
  const input = desktopFixture();
  input.reports.reverse();
  assert.doesNotThrow(() => inspectDesktopReports(input));
});

test('desktop qualification preserves an explicit existing per-file skip allowance', () => {
  const input = desktopFixture();
  addPendingTest(input);
  input.skipBudget[input.expectedFiles[0]] = 1;
  assert.doesNotThrow(() => inspectDesktopReports(input));
});

const invalidDesktopCases = [
  ['missing shard', (input) => input.reports.pop()],
  ['duplicate shard', (input) => input.reports.push(structuredClone(input.reports[0]))],
  [
    'unexpected shard number',
    (input) => {
      input.reports[0].shard = 9;
    },
  ],
  [
    'wrong shard count',
    (input) => {
      input.reports[0].shards = 9;
    },
  ],
  [
    'different source commit',
    (input) => {
      input.reports[0].sourceSha = '4'.repeat(40);
    },
  ],
  [
    'different source tree',
    (input) => {
      input.reports[0].sourceTree = '4'.repeat(40);
    },
  ],
  [
    'different control revision',
    (input) => {
      input.reports[0].controlSha = '4'.repeat(40);
    },
  ],
  [
    'different run',
    (input) => {
      input.reports[0].runId = '123457';
    },
  ],
  [
    'different run attempt',
    (input) => {
      input.reports[0].attempt = 2;
    },
  ],
  [
    'missing source identity',
    (input) => {
      delete input.reports[0].sourceSha;
    },
  ],
  [
    'wrong report kind',
    (input) => {
      input.reports[0].kind = 'native';
    },
  ],
  [
    'empty independent inventory',
    (input) => {
      input.expectedFiles = [];
    },
  ],
  [
    'duplicate independent inventory entry',
    (input) => {
      input.expectedFiles.push(input.expectedFiles[0]);
    },
  ],
  [
    'empty shard selection',
    (input) => {
      input.reports[0].expectedFiles = [];
    },
  ],
  [
    'duplicate shard selection entry',
    (input) => {
      input.reports[0].expectedFiles.push(input.expectedFiles[0]);
    },
  ],
  [
    'unreported selected file',
    (input) => {
      input.reports[0].result.testResults = [];
    },
  ],
  [
    'file missing from independent inventory',
    (input) => {
      input.expectedFiles.pop();
    },
  ],
  [
    'independent file omitted by all shards',
    (input) => {
      input.expectedFiles.push('apps/desktop/src/omitted.test.ts');
    },
  ],
  [
    'unselected result file',
    (input) => {
      input.reports[0].result.testResults[0].name = 'apps/desktop/src/unselected.test.ts';
    },
  ],
  [
    'file executed by two shards',
    (input) => {
      input.reports[1].expectedFiles = [...input.reports[0].expectedFiles];
      input.reports[1].result = structuredClone(input.reports[0].result);
    },
  ],
  [
    'absent test report',
    (input) => {
      delete input.reports[0].result;
    },
  ],
  [
    'failed test report',
    (input) => {
      input.reports[0].result.success = false;
    },
  ],
  [
    'failed test count despite claimed success',
    (input) => {
      input.reports[0].result.numFailedTests = 1;
    },
  ],
  [
    'runtime error despite claimed success',
    (input) => {
      input.reports[0].result.numRuntimeErrorTestSuites = 1;
    },
  ],
  [
    'failed suite despite claimed success',
    (input) => {
      input.reports[0].result.testResults[0].status = 'failed';
    },
  ],
  [
    'failed assertion despite claimed success',
    (input) => {
      input.reports[0].result.testResults[0].assertionResults[0].status = 'failed';
    },
  ],
  [
    'zero collected tests',
    (input) => {
      input.reports[0].result.numTotalTests = 0;
      input.reports[0].result.numPassedTests = 0;
      input.reports[0].result.testResults[0].assertionResults = [];
    },
  ],
  [
    'claimed tests without assertions',
    (input) => {
      input.reports[0].result.testResults[0].assertionResults = [];
    },
  ],
  [
    'unexpected pending test',
    (input) => {
      addPendingTest(input);
    },
  ],
  [
    'pending tests exceeding allowance',
    (input) => {
      addPendingTest(input, 2);
      input.skipBudget[input.expectedFiles[0]] = 1;
    },
  ],
  [
    'another file cannot donate its skip allowance',
    (input) => {
      addPendingTest(input);
      input.skipBudget[input.expectedFiles[1]] = 1;
    },
  ],
  [
    'malformed source identity',
    (input) => {
      input.manifest.sourceSha = 'not-a-commit';
    },
  ],
  [
    'duplicate manifest shard',
    (input) => {
      input.manifest.desktopShards[1] = 1;
    },
  ],
];

for (const [name, mutate] of invalidDesktopCases) {
  test(`desktop qualification rejects ${name}`, () => {
    const input = desktopFixture();
    mutate(input);
    assert.throws(() => inspectDesktopReports(input));
  });
}

test('native qualification accepts exactly the required six journeys without mutating them', () => {
  const input = nativeFixture();
  const original = structuredClone(input);
  assert.doesNotThrow(() => inspectNativeReports(freeze(input)));
  assert.deepEqual(input, original);
});

test('native qualification accepts journey reports in a different arrival order', () => {
  const input = nativeFixture();
  input.reports.reverse();
  assert.doesNotThrow(() => inspectNativeReports(input));
});

const invalidNativeCases = [
  ['missing journey', (input) => input.reports.pop()],
  ['duplicate journey', (input) => input.reports.push(structuredClone(input.reports[0]))],
  [
    'unexpected journey',
    (input) => {
      input.reports[0].journey = 'unselected';
    },
  ],
  [
    'empty required roster',
    (input) => {
      input.journeys = [];
    },
  ],
  ['duplicate required journey', (input) => input.journeys.push(input.journeys[0])],
  [
    'failed journey',
    (input) => {
      input.reports[0].status = 'failed';
    },
  ],
  [
    'skipped journey',
    (input) => {
      input.reports[0].status = 'skipped';
    },
  ],
  [
    'cancelled journey',
    (input) => {
      input.reports[0].status = 'cancelled';
    },
  ],
  [
    'pending journey',
    (input) => {
      input.reports[0].status = 'pending';
    },
  ],
  [
    'missing journey status',
    (input) => {
      delete input.reports[0].status;
    },
  ],
  [
    'wrong report kind',
    (input) => {
      input.reports[0].kind = 'desktop';
    },
  ],
  [
    'different source commit',
    (input) => {
      input.reports[0].sourceSha = '4'.repeat(40);
    },
  ],
  [
    'different source tree',
    (input) => {
      input.reports[0].sourceTree = '4'.repeat(40);
    },
  ],
  [
    'different control revision',
    (input) => {
      input.reports[0].controlSha = '4'.repeat(40);
    },
  ],
  [
    'different run',
    (input) => {
      input.reports[0].runId = '123457';
    },
  ],
  [
    'different run attempt',
    (input) => {
      input.reports[0].attempt = 2;
    },
  ],
  [
    'missing source identity',
    (input) => {
      delete input.reports[0].sourceSha;
    },
  ],
];

for (const [name, mutate] of invalidNativeCases) {
  test(`native qualification rejects ${name}`, () => {
    const input = nativeFixture();
    mutate(input);
    assert.throws(() => inspectNativeReports(input));
  });
}

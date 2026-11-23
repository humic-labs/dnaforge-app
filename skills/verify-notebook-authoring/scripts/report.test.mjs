import assert from 'node:assert/strict';
import test from 'node:test';
import { reportFailures } from './report.mjs';

const file = '/task/required.test.ts';
const suite = {
  name: file,
  status: 'passed',
  assertionResults: [{ fullName: 'required behavior', status: 'passed' }],
};
test('accepts complete passing execution', () => {
  assert.deepEqual(reportFailures({ success: true, testResults: [suite] }, [file]), []);
});
test('rejects exit-success with a missing required file', () => {
  assert.ok(reportFailures({ success: true, testResults: [] }, [file]).length);
});
test('rejects duplicate file reports', () => {
  assert.ok(reportFailures({ success: true, testResults: [suite, suite] }, [file]).length);
});
test('rejects an empty suite', () => {
  assert.ok(
    reportFailures({ success: true, testResults: [{ ...suite, assertionResults: [] }] }, [file])
      .length
  );
});
for (const status of ['skipped', 'pending', 'todo', 'failed'])
  test(`rejects ${status} required behavior`, () => {
    assert.ok(
      reportFailures(
        {
          success: true,
          testResults: [
            { ...suite, assertionResults: [{ fullName: 'required behavior', status }] },
          ],
        },
        [file]
      ).length
    );
  });
test('rejects a failed or missing report', () => {
  assert.ok(reportFailures(undefined, [file]).length);
  assert.ok(reportFailures({ success: false, testResults: [suite] }, [file]).length);
});

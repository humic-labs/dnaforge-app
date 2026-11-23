import { resolve } from 'node:path';

export function reportFailures(report, requiredFiles) {
  if (report?.success !== true || !Array.isArray(report.testResults))
    return ['The test runner did not report success with file results.'];
  const failures = [];
  for (const file of requiredFiles) {
    const matches = report.testResults.filter((suite) => resolve(suite.name) === resolve(file));
    if (matches.length !== 1) {
      failures.push(`Expected one executed suite for ${file}; received ${matches.length}.`);
      continue;
    }
    const suite = matches[0];
    if (suite.status !== 'passed' || !suite.assertionResults?.length)
      failures.push(`No passing tests executed for ${file}.`);
    for (const test of suite.assertionResults ?? [])
      if (test.status !== 'passed') failures.push(`${file}: ${test.fullName} is ${test.status}.`);
  }
  return failures;
}

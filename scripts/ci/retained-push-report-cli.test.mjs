import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repository = 'humic-labs/dnaforge-app';
const branch = 'staging';
const sha = '0123456789abcdef0123456789abcdef01234567';
const runId = '19472';
const runUrl = `https://github.com/${repository}/actions/runs/${runId}`;
const runPath = `repos/${repository}/actions/runs/${runId}`;
const jobsPath = `${runPath}/attempts/3/jobs?per_page=100&page=1`;
const pullsPath = `repos/${repository}/commits/${sha}/pulls?per_page=100`;
const reporter = fileURLToPath(new URL('./report-main-result.mjs', import.meta.url));

function report(t, conclusion) {
  const directory = mkdtempSync(join(tmpdir(), 'retained-push-report-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const responses = {
    [runPath]: { event: 'push', head_branch: branch, head_sha: sha, run_attempt: 3, html_url: runUrl },
    [jobsPath]: { total_count: 3, jobs: [
      { name: 'Promotion qualification', conclusion },
      { name: 'Native workspace', conclusion },
      { name: 'Package inventory', conclusion: 'success' },
    ] },
    [pullsPath]: [{ number: 72, title: 'Associated change' }],
  };
  writeFileSync(join(directory, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync('calls.jsonl', JSON.stringify(args) + '\\n');
const responses = ${JSON.stringify(responses)};
if (args.length !== 2 || args[0] !== 'api' || !Object.hasOwn(responses, args[1])) process.exit(2);
console.log(JSON.stringify(responses[args[1]]));
`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [reporter], {
    cwd: directory, encoding: 'utf8',
    env: {
      PATH: directory, GITHUB_EVENT_NAME: 'push', GITHUB_REPOSITORY: repository,
      GITHUB_REF: `refs/heads/${branch}`, GITHUB_SHA: sha, GITHUB_RUN_ID: runId, GITHUB_RUN_ATTEMPT: '3',
    },
  });
  assert.ifError(result.error);
  const expected = conclusion === 'success' ? [runPath, jobsPath] : [runPath, jobsPath, pullsPath];
  const calls = readFileSync(join(directory, 'calls.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(calls, expected.map((path) => ['api', path]));
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('a successful retained push reports its exact branch and source without querying contributions', (t) => {
  const output = report(t, 'success');
  assert.ok(output.includes(`on ${branch} commit \`${sha}\``));
  assert.match(output, /passed/u);
});

test('a failed retained push reports its exact attempt, failed jobs and contribution using read-only calls', (t) => {
  const output = report(t, 'failure');
  assert.ok(output.includes(`[CI run](${runUrl}/attempts/3)`));
  assert.ok(output.includes(`on ${branch} commit \`${sha}\``));
  assert.match(output, /^- Native workspace: failure$/mu);
  assert.match(output, /^- Promotion qualification: failure$/mu);
  assert.match(output, /^- Contribution #72$/mu);
  assert.doesNotMatch(output, /Package inventory/u);
});

test('the retained-push workflow writes only its job summary with a read-only token', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const job = workflow.match(/^  main-result:\s*\n((?:^ {4}.*(?:\n|$))+)/mu)?.[1];
  assert.ok(job, 'Missing retained-push reporting job');
  const permissions = job.match(/^    permissions:\s*\n((?:^ {6}.*(?:\n|$))+)/mu)?.[1];
  assert.ok(permissions, 'The reporting job must declare its permissions');
  const scopes = permissions.trim().split('\n').map((line) => line.trim()).sort();
  assert.deepEqual(scopes, ['actions: read', 'contents: read', 'pull-requests: read']);
  const commands = [...job.matchAll(/^        run: (.*)$/gmu)].map((match) => match[1]);
  assert.deepEqual(commands, ['node .ci-control/scripts/ci/report-main-result.mjs >> "$GITHUB_STEP_SUMMARY"']);
});

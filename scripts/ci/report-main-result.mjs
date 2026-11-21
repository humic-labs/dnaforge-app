import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function failureReport({ repository, branch = 'dev', sha, runUrl, pullRequests, jobs }) {
  assert.match(repository, /^[\w.-]+\/[\w.-]+$/u);
  assert.ok(['dev', 'staging', 'prod', 'main'].includes(branch), 'Unknown integration branch');
  assert.match(sha, /^[a-f0-9]{40}$/u);
  assert.ok(runUrl.startsWith(`https://github.com/${repository}/actions/runs/`));
  const failed = jobs.filter((job) =>
    ['failure', 'cancelled', 'timed_out', 'action_required'].includes(job.conclusion)
  );
  assert.ok(failed.length > 0, 'No failed jobs to report');
  return {
    title: `${branch} qualification failed at ${sha.slice(0, 12)}`,
    body: [
      `The retained [CI run](${runUrl}) failed on ${branch} commit \`${sha}\`.`,
      '',
      ...pullRequests.map((pr) => `- Contribution #${pr.number}`),
      '',
      ...failed.map((job) => `- ${job.name}: ${job.conclusion}`),
    ].join('\n'),
  };
}

export { failureReport as failureIssue };

export function retainedPushBranch(env, run) {
  assert.equal(env.GITHUB_EVENT_NAME, 'push');
  const branch = env.GITHUB_REF?.replace(/^refs\/heads\//u, '');
  assert.equal(env.GITHUB_REF, `refs/heads/${branch}`);
  assert.ok(['dev', 'staging', 'prod', 'main'].includes(branch), 'Unknown integration branch');
  assert.equal(run.head_branch, branch, 'Run belongs to another branch');
  assert.equal(run.head_sha, env.GITHUB_SHA, 'Run belongs to another source');
  assert.equal(run.event, 'push');
  assert.equal(run.run_attempt, Number(env.GITHUB_RUN_ATTEMPT));
  return branch;
}

function api(endpoint) {
  return JSON.parse(
    execFileSync('gh', ['api', endpoint], {
      encoding: 'utf8',
    })
  );
}

function main() {
  assert.equal(process.env.GITHUB_EVENT_NAME, 'push');
  const repository = process.env.GITHUB_REPOSITORY;
  assert.equal(repository, 'humic-labs/dnaforge-app');
  const sha = process.env.GITHUB_SHA;
  const runId = process.env.GITHUB_RUN_ID;
  const run = api(`repos/${repository}/actions/runs/${runId}`);
  const branch = retainedPushBranch(process.env, run);
  const jobs = [];
  for (let page = 1; ; page += 1) {
    const result = api(
      `repos/${repository}/actions/runs/${runId}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`
    );
    jobs.push(...result.jobs);
    if (jobs.length >= result.total_count) break;
    assert.ok(result.jobs.length > 0, 'Incomplete job inventory');
  }
  const qualification = jobs.filter(({ name }) => name === 'Promotion qualification');
  assert.equal(qualification.length, 1, 'Missing qualification job');
  if (qualification[0].conclusion === 'success')
    return console.log(`Qualification passed on ${branch} commit \`${sha}\`.`);
  const pulls = api(`repos/${repository}/commits/${sha}/pulls?per_page=100`);
  const report = failureReport({
    repository,
    branch,
    sha,
    runUrl: `${run.html_url}/attempts/${run.run_attempt}`,
    pullRequests: pulls,
    jobs,
  });
  console.log(`## ${report.title}\n\n${report.body}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

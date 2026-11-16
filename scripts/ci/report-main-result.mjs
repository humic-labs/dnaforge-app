import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function failureIssue({ repository, sha, runUrl, pullRequests, jobs }) {
  assert.match(repository, /^[\w.-]+\/[\w.-]+$/u);
  assert.match(sha, /^[a-f0-9]{40}$/u);
  assert.ok(runUrl.startsWith(`https://github.com/${repository}/actions/runs/`));
  const failed = jobs.filter((job) =>
    ['failure', 'cancelled', 'timed_out', 'action_required'].includes(job.conclusion)
  );
  assert.ok(failed.length > 0, 'No failed jobs to report');
  return {
    title: `Main qualification failed at ${sha.slice(0, 12)}`,
    body: [
      `The retained [CI run](${runUrl}) failed on main commit \`${sha}\`.`,
      '',
      'Delivery ownership remains with the maintainers of the associated contribution until the failure is classified and repaired. This report identifies the merged change; it does not establish that it caused every failure.',
      '',
      ...pullRequests.map((pr) => `- Contribution #${pr.number}: ${pr.title}`),
      '',
      ...failed.map((job) => `- ${job.name}: ${job.conclusion}`),
      '',
      'Retain the original failing attempt. Record a diagnosed regression, a separately evidenced pre-existing failure, or an infrastructure failure before resolving this issue. Do not rerun until green as a substitute for diagnosis.',
    ].join('\n'),
  };
}

function api(endpoint, body) {
  return JSON.parse(
    execFileSync('gh', ['api', endpoint, ...(body ? ['--method', 'POST', '--input', '-'] : [])], {
      encoding: 'utf8',
      input: body ? JSON.stringify(body) : undefined,
    })
  );
}

function main() {
  assert.equal(process.env.GITHUB_EVENT_NAME, 'push');
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main');
  const repository = process.env.GITHUB_REPOSITORY;
  assert.equal(repository, 'humic-labs/dnaforge-app');
  const sha = process.env.GITHUB_SHA;
  const runId = process.env.GITHUB_RUN_ID;
  const run = api(`repos/${repository}/actions/runs/${runId}`);
  assert.equal(run.head_sha, sha);
  assert.equal(run.event, 'push');
  assert.equal(run.run_attempt, Number(process.env.GITHUB_RUN_ATTEMPT));
  const jobs = [];
  for (let page = 1; ; page += 1) {
    const result = api(
      `repos/${repository}/actions/runs/${runId}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`
    );
    jobs.push(...result.jobs);
    if (jobs.length >= result.total_count) break;
    assert.ok(result.jobs.length > 0, 'Incomplete job inventory');
  }
  const qualification = jobs.filter(({ name }) => name === 'Merge qualification');
  assert.equal(qualification.length, 1, 'Missing qualification job');
  if (qualification[0].conclusion === 'success')
    return console.log('Main qualification passed; no failure issue needed.');
  const pulls = api(`repos/${repository}/commits/${sha}/pulls?per_page=100`);
  const issue = failureIssue({ repository, sha, runUrl: run.html_url, pullRequests: pulls, jobs });
  const existing = api(
    `search/issues?q=${encodeURIComponent(`repo:${repository} is:issue in:title "${issue.title}"`)}`
  );
  const match = existing.items.find(({ title }) => title === issue.title);
  if (match) return console.log(`Retained failure issue ${match.html_url}`);
  if (!process.argv.includes('--publish')) return console.log(JSON.stringify(issue, null, 2));
  console.log(api(`repos/${repository}/issues`, issue).html_url);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

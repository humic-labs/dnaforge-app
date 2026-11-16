#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assessQualification, policy, proposedRules } from './merge-policy.mjs';

const repositoryRoute = `repos/${policy.repository.name}`;
const SHA = /^[a-f0-9]{40}$/u;

export function githubApi(route, { method = 'GET', body } = {}) {
  const args = ['api', '--method', method, route];
  if (body !== undefined) args.push('--input', '-');
  return JSON.parse(execFileSync('gh', args, {
    encoding: 'utf8', input: body === undefined ? undefined : JSON.stringify(body),
    timeout: 60_000, maxBuffer: 32 * 1024 * 1024,
  }));
}

function inventory(api, route, key) {
  const rows = [];
  for (let page = 1; page <= 20; page += 1) {
    const response = api(`${route}${route.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    const entries = key ? response[key] : response;
    if (!Array.isArray(entries)) throw new Error(`GitHub returned an invalid inventory for ${route}`);
    rows.push(...entries);
    if (entries.length < 100) return rows;
  }
  throw new Error(`GitHub inventory exceeded its bounded page count: ${route}`);
}

export function readQualificationArtifact(run, api = githubApi) {
  const artifacts = inventory(api, `${repositoryRoute}/actions/runs/${run.id}/artifacts`, 'artifacts')
    .filter((artifact) => /^qualification-[a-f0-9]{40}$/u.test(artifact.name) && !artifact.expired);
  if (artifacts.length !== 1) throw new Error('Expected one current source-bound qualification artifact');
  const directory = mkdtempSync(join(tmpdir(), 'dnaforge-qualification-'));
  try {
    execFileSync('gh', ['run', 'download', String(run.id), '--repo', policy.repository.name, '--name', artifacts[0].name, '--dir', directory], {
      encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024,
    });
    const files = readdirSync(directory);
    if (files.length !== 1 || files[0] !== 'qualification.json') throw new Error('Qualification artifact has an unexpected file inventory');
    const path = join(directory, 'qualification.json');
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 5 * 1024 * 1024) throw new Error('Qualification artifact is not a bounded regular JSON file');
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (artifacts[0].name !== `qualification-${value.sourceSha}`) throw new Error('Qualification artifact name and source disagree');
    return { value, artifact: { id: artifacts[0].id, name: artifacts[0].name, digest: artifacts[0].digest } };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function identity(pr) {
  return JSON.stringify({ state: pr.state, head: pr.head?.sha, base: pr.base?.sha, draft: pr.draft,
    labels: pr.labels?.map((label) => label.name).sort(), autoMerge: pr.auto_merge });
}

export function inspectPullRequest(number, { expectedHead, api = githubApi, readArtifact = readQualificationArtifact } = {}) {
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('A positive pull request number is required');
  if (expectedHead !== undefined && !SHA.test(expectedHead)) throw new Error('Expected head must be a full commit SHA');
  const repository = api(repositoryRoute);
  const candidate = api(`${repositoryRoute}/pulls/${number}`);
  const initialIdentity = identity(candidate);
  candidate.expectedHead = expectedHead;
  const currentMain = api(`${repositoryRoute}/branches/${policy.repository.target}`).commit.sha;
  const observation = {
    repository: { id: repository.id, full_name: repository.full_name }, currentMain,
    rules: api(`${repositoryRoute}/rules/branches/${policy.repository.target}`), errors: [],
    changedPaths: inventory(api, `${repositoryRoute}/pulls/${number}/files`).flatMap((file) => [file.filename, file.previous_filename].filter(Boolean)),
    runs: inventory(api, `${repositoryRoute}/actions/runs?head_sha=${candidate.head.sha}&event=pull_request`, 'workflow_runs'),
    checks: inventory(api, `${repositoryRoute}/commits/${candidate.head.sha}/check-runs`, 'check_runs'),
    jobs: {}, ancestry: {},
  };
  const latestRuns = [policy.authority.workflow, policy.authority.claWorkflow].map((path) =>
    observation.runs.filter((run) => run.path === path).sort((a, b) => b.id - a.id || b.run_attempt - a.run_attempt)[0]);
  for (const run of latestRuns.filter(Boolean)) {
    observation.jobs[run.id] = inventory(api, `${repositoryRoute}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`, 'jobs');
  }
  const ci = latestRuns[0];
  if (ci?.status === 'completed' && ci.conclusion === 'success') {
    try {
      const { value, artifact } = readArtifact(ci, api);
      observation.qualification = value;
      observation.artifact = artifact;
      if (![value.sourceSha, value.baseSha, value.controlSha].every((sha) => SHA.test(sha ?? ''))) throw new Error('Qualification revisions are malformed');
      observation.sourceCommit = api(`${repositoryRoute}/commits/${value.sourceSha}`);
      observation.ancestry.base = api(`${repositoryRoute}/compare/${value.baseSha}...${currentMain}`).status;
      observation.ancestry.control = api(`${repositoryRoute}/compare/${value.controlSha}...${currentMain}`).status;
    } catch (error) {
      observation.errors.push(`Qualification evidence unavailable: ${error.message}`);
    }
  }
  const reread = api(`${repositoryRoute}/pulls/${number}`);
  if (identity(reread) !== initialIdentity) observation.errors.push('Pull request changed during inspection; this observation cannot admit it');
  const decision = assessQualification(candidate, observation);
  return { version: 1, observedAt: new Date().toISOString(), decision, candidate, observation };
}

export function enqueueQualifiedPullRequest(number, options = {}) {
  if (options.authorizeMerge !== true) throw new Error('Queue admission requires explicit merge authority; preparation never grants it');
  if (!SHA.test(options.expectedHead ?? '')) throw new Error('Queue admission requires --expected-head with a full commit SHA');
  const api = options.api ?? githubApi;
  const receipt = inspectPullRequest(number, { ...options, api });
  if (receipt.decision.state !== 'qualified') return receipt;
  const localHead = options.localHead ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const localStatus = options.localStatus ?? execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
  if (localHead !== options.expectedHead || localStatus.trim()) throw new Error('Queue admission requires the clean local checkout of the exact expected head');
  const result = api('graphql', { method: 'POST', body: {
    query: 'mutation($id:ID!,$head:GitObjectID!){enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$head}){mergeQueueEntry{id state position}}}',
    variables: { id: receipt.candidate.node_id, head: options.expectedHead },
  } });
  if (result.errors?.length || !result.data?.enqueuePullRequest?.mergeQueueEntry?.id) throw new Error('GitHub refused exact-head queue admission: ' + JSON.stringify(result.errors ?? result));
  return { ...receipt, admission: { state: 'enqueued', expectedHead: options.expectedHead, queueEntry: result.data.enqueuePullRequest.mergeQueueEntry } };
}

export function parseArguments(args) {
  const command = args[0] && !args[0].startsWith('--') ? args.shift() : 'inspect';
  if (!['inspect', 'prepare', 'enqueue', 'propose-rules'].includes(command)) throw new Error('Command must be inspect, prepare, enqueue or propose-rules');
  const options = {};
  while (args.length) {
    const flag = args.shift();
    if (flag === '--authorize-merge') {
      if (options.authorizeMerge) throw new Error('Duplicate merge authorization flag');
      options.authorizeMerge = true;
    } else {
      const names = { '--pr': 'number', '--expected-head': 'expectedHead', '--out': 'out' };
      const key = names[flag];
      if (!key || options[key] !== undefined || !args[0] || args[0].startsWith('--')) throw new Error(`Invalid option: ${flag}`);
      options[key] = args.shift();
    }
  }
  if (command !== 'enqueue' && options.authorizeMerge) throw new Error('Merge authorization is valid only for the enqueue command');
  if (command !== 'propose-rules') {
    options.number = Number(options.number);
    if (!Number.isSafeInteger(options.number) || options.number < 1) throw new Error('--pr must name a positive pull request number');
  }
  return { command, options };
}

export function main(args = process.argv.slice(2)) {
  const { command, options } = parseArguments([...args]);
  const receipt = command === 'propose-rules' ? proposedRules()
    : command === 'enqueue' ? enqueueQualifiedPullRequest(options.number, options)
      : inspectPullRequest(options.number, options);
  const output = JSON.stringify(receipt, null, 2) + '\n';
  if (options.out) {
    const path = resolve(options.out);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, output);
  }
  process.stdout.write(output);
  return receipt.decision?.state === 'rejected' ? 1 : receipt.decision?.state === 'pending' ? 2 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = main(); }
  catch (error) { console.error(error.message); process.exitCode = 2; }
}

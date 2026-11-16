#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assessQualification, branchPolicy, policy, proposedRules, selectWorkflowRun } from './merge-policy.mjs';

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
  return JSON.stringify({ state: pr.state, head: pr.head?.sha, base: pr.base?.sha, target: pr.base?.ref,
    repository: pr.base?.repo?.id, draft: pr.draft,
    labels: pr.labels?.map((label) => label.name).sort(), autoMerge: pr.auto_merge });
}

export function inspectPullRequest(number, { expectedHead, sourceSha, api = githubApi, readArtifact = readQualificationArtifact } = {}) {
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('A positive pull request number is required');
  if (expectedHead !== undefined && !SHA.test(expectedHead)) throw new Error('Expected head must be a full commit SHA');
  if (sourceSha !== undefined && !SHA.test(sourceSha)) throw new Error('Selected source must be a full commit SHA');
  const repository = api(repositoryRoute);
  const candidate = api(`${repositoryRoute}/pulls/${number}`);
  const initialIdentity = identity(candidate);
  candidate.expectedHead = expectedHead;
  candidate.expectedSource = sourceSha;
  const config = branchPolicy(candidate.base.ref);
  const currentTarget = api(`${repositoryRoute}/branches/${candidate.base.ref}`).commit.sha;
  const observation = {
    repository: { id: repository.id, full_name: repository.full_name }, currentTarget,
    rules: api(`${repositoryRoute}/rules/branches/${candidate.base.ref}`), errors: [],
    changedPaths: inventory(api, `${repositoryRoute}/pulls/${number}/files`).flatMap((file) => [file.filename, file.previous_filename].filter(Boolean)),
    runs: inventory(api, `${repositoryRoute}/actions/runs?head_sha=${candidate.head.sha}&event=pull_request`, 'workflow_runs'),
    checks: inventory(api, `${repositoryRoute}/commits/${candidate.head.sha}/check-runs`, 'check_runs'),
    jobs: {}, ancestry: {},
  };
  const latestRuns = [config.workflow, policy.authority.claWorkflow].map((path) =>
    selectWorkflowRun(observation.runs, path, candidate.head.sha));
  for (const run of latestRuns.filter(Boolean)) {
    observation.jobs[run.id] = inventory(api, `${repositoryRoute}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`, 'jobs');
  }
  const ci = latestRuns[0];
  if (config.role === 'promotion') {
    const selectedSource = sourceSha ?? candidate.head.sha;
    const source = api(`${repositoryRoute}/commits/${selectedSource}`);
    const headCommit = selectedSource === candidate.head.sha ? source : api(`${repositoryRoute}/commits/${candidate.head.sha}`);
    const upstream = api(`${repositoryRoute}/branches/${config.upstream}`).commit.sha;
    observation.promotion = {
      sourceSha: source.sha, sourceTree: source.commit.tree.sha, headTree: headCommit.commit.tree.sha,
      upstreamSha: upstream, ancestry: api(`${repositoryRoute}/compare/${selectedSource}...${upstream}`).status,
      headAncestry: selectedSource === candidate.head.sha ? 'identical'
        : api(`${repositoryRoute}/compare/${selectedSource}...${candidate.head.sha}`).status,
    };
    if (ci?.status === 'completed' && ci.conclusion === 'success') {
      try {
        const { value, artifact } = readArtifact(ci, api);
        observation.qualification = value;
        observation.artifact = artifact;
        if (![value.sourceSha, value.baseSha, value.controlSha].every((sha) => SHA.test(sha ?? ''))) throw new Error('Qualification revisions are malformed');
        observation.sourceCommit = api(`${repositoryRoute}/commits/${value.sourceSha}`);
        observation.ancestry.base = api(`${repositoryRoute}/compare/${value.baseSha}...${currentTarget}`).status;
        const controlHead = api(`${repositoryRoute}/branches/${policy.repository.defaultBranch}`).commit.sha;
        observation.ancestry.control = api(`${repositoryRoute}/compare/${value.controlSha}...${controlHead}`).status;
      } catch (error) {
        observation.errors.push(`Qualification evidence unavailable: ${error.message}`);
      }
    }
  }
  const reread = api(`${repositoryRoute}/pulls/${number}`);
  if (identity(reread) !== initialIdentity) observation.errors.push('Pull request changed during inspection; this observation cannot admit it');
  const decision = assessQualification(candidate, observation);
  return { version: 2, observedAt: new Date().toISOString(), decision, candidate, observation };
}

function localCandidate(options) {
  const localHead = options.localHead ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const localStatus = options.localStatus ?? execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
  const expectedHead = options.expectedHead ?? localHead;
  if (!SHA.test(expectedHead)) throw new Error('Delivery requires an exact full head SHA');
  if (localHead !== expectedHead || localStatus.trim()) throw new Error('Delivery requires the clean local checkout of the exact expected head');
  return expectedHead;
}

function requireDevelopment(candidate, expectedHead) {
  if (candidate.base?.ref !== policy.repository.defaultBranch) throw new Error('Development delivery only targets dev; promotion is a separate command');
  if (candidate.head?.sha !== expectedHead) throw new Error('Expected head differs from the current pull request head');
  if (candidate.state !== 'open') throw new Error('Pull request is not open');
  if (candidate.labels?.some((label) => policy.delivery.holdLabels.includes(String(label.name).toLowerCase()))) throw new Error('Pull request has an explicit merge hold');
}

export function enqueueQualifiedPullRequest(number, options = {}) {
  if (!SHA.test(options.expectedHead ?? '')) throw new Error('Queue admission requires --expected-head with a full commit SHA');
  localCandidate(options);
  const api = options.api ?? githubApi;
  const receipt = inspectPullRequest(number, { ...options, api });
  requireDevelopment(receipt.candidate, options.expectedHead);
  if (receipt.decision.state !== 'qualified') return receipt;
  return admitQualifiedReceipt(receipt, options.expectedHead, api);
}

function admitQualifiedReceipt(receipt, expectedHead, api) {
  const result = api('graphql', { method: 'POST', body: {
    query: 'mutation($id:ID!,$head:GitObjectID!){enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$head}){mergeQueueEntry{id state position enqueuedAt}}}',
    variables: { id: receipt.candidate.node_id, head: expectedHead },
  } });
  if (result.errors?.length || !result.data?.enqueuePullRequest?.mergeQueueEntry?.id) throw new Error('GitHub refused exact-head queue admission: ' + JSON.stringify(result.errors ?? result));
  return { ...receipt, admission: { state: 'enqueued', expectedHead, queueEntry: result.data.enqueuePullRequest.mergeQueueEntry } };
}

export function readDeliveryState(number, api = githubApi) {
  const [owner, name] = policy.repository.name.split('/');
  const result = api('graphql', { method: 'POST', body: {
    query: 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){state headRefOid merged mergeCommit{oid} mergeQueueEntry{id state}}}}',
    variables: { owner, name, number },
  } });
  if (result.errors?.length || !result.data?.repository?.pullRequest) throw new Error('GitHub delivery state is unavailable');
  return result.data.repository.pullRequest;
}

function verifiedMerge(number, expectedHead, target, state, api) {
  if (state.headRefOid !== expectedHead) throw new Error('Pull request head changed while delivery was running');
  if (!state.merged || !SHA.test(state.mergeCommit?.oid ?? '')) throw new Error('GitHub has not verified a merge');
  const targetSha = api(`${repositoryRoute}/branches/${target}`).commit.sha;
  const comparison = api(`${repositoryRoute}/compare/${state.mergeCommit.oid}...${targetSha}`);
  if (!['ahead', 'identical'].includes(comparison.status)) throw new Error('Merged commit is not on the intended target');
  return { state: 'merged', number, headSha: expectedHead, target, mergeCommit: state.mergeCommit.oid, targetSha };
}

export async function deliverPullRequest(number, options = {}) {
  const expectedHead = localCandidate(options);
  const provider = options.api ?? githubApi;
  const maxRequests = options.maxRequests ?? policy.delivery.maxRequests;
  const maxWaitMs = options.maxWaitMs ?? policy.delivery.maxWaitMs;
  const pollIntervalMs = options.pollIntervalMs ?? policy.delivery.pollIntervalMs;
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > policy.delivery.maxRequests ||
      !Number.isSafeInteger(maxWaitMs) || maxWaitMs < 0 || maxWaitMs > policy.delivery.maxWaitMs ||
      !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 60000) throw new Error('Invalid bounded delivery limits');
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)));
  const deadline = now() + maxWaitMs;
  let requests = 0;
  const api = (...args) => {
    if (++requests > maxRequests) throw new Error('Delivery request budget exhausted; inspect the existing admission before continuing');
    return provider(...args);
  };
  const candidate = api(`${repositoryRoute}/pulls/${number}`);
  requireDevelopment(candidate, expectedHead);
  let readyAfterRunId = null;
  if (candidate.draft) {
    const runs = inventory(api, `${repositoryRoute}/actions/runs?head_sha=${expectedHead}&event=pull_request`, 'workflow_runs');
    readyAfterRunId = selectWorkflowRun(runs, branchPolicy(candidate.base.ref).workflow, expectedHead)?.id ?? 0;
    const ready = api('graphql', { method: 'POST', body: {
      query: 'mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{id isDraft headRefOid}}}',
      variables: { id: candidate.node_id },
    } });
    const state = ready.data?.markPullRequestReadyForReview?.pullRequest;
    if (ready.errors?.length || state?.isDraft !== false || state.headRefOid !== expectedHead) throw new Error('GitHub did not confirm readiness for the expected head');
  }
  let admission;
  while (now() <= deadline) {
    const receipt = inspectPullRequest(number, { ...options, expectedHead, api });
    requireDevelopment(receipt.candidate, expectedHead);
    if (receipt.decision.state === 'rejected') return { ...receipt, requests };
    const run = receipt.decision.runs[branchPolicy(candidate.base.ref).workflow];
    const freshReadyRun = readyAfterRunId === null || run?.id > readyAfterRunId;
    if (receipt.decision.state === 'qualified' && freshReadyRun) {
      const existing = readDeliveryState(number, api);
      if (existing.headRefOid !== expectedHead) throw new Error('Pull request head changed before admission');
      if (existing.merged) return { ...receipt, delivery: verifiedMerge(number, expectedHead, candidate.base.ref, existing, api), requests };
      admission = existing.mergeQueueEntry
        ? { ...receipt, admission: { state: 'observing', expectedHead, queueEntry: existing.mergeQueueEntry } }
        : admitQualifiedReceipt(receipt, expectedHead, api);
      if (!admission.admission) return { ...admission, requests };
      break;
    }
    await sleep(pollIntervalMs);
  }
  if (!admission) throw new Error('Delivery timed out before queue admission');
  while (now() <= deadline) {
    const state = readDeliveryState(number, api);
    if (state.headRefOid !== expectedHead) throw new Error('Pull request head changed while delivery was running');
    if (state.merged) return { ...admission, delivery: verifiedMerge(number, expectedHead, candidate.base.ref, state, api), requests };
    if (state.state !== 'OPEN' || !state.mergeQueueEntry) throw new Error('Pull request left the queue without a verified merge; refusing automatic re-enqueue');
    if (state.mergeQueueEntry.id !== admission.admission.queueEntry.id) throw new Error('Queue admission changed; refusing to take ownership of another admission');
    await sleep(pollIntervalMs);
  }
  throw new Error('Delivery watch timed out; the existing queue entry was left unchanged');
}

export function promoteQualifiedPullRequest(number, options = {}) {
  const expectedHead = localCandidate(options);
  if (!SHA.test(options.sourceSha ?? '')) throw new Error('Promotion requires --source with an exact selected source SHA');
  const api = options.api ?? githubApi;
  const receipt = inspectPullRequest(number, { ...options, expectedHead, api });
  if (branchPolicy(receipt.candidate.base.ref).role !== 'promotion') throw new Error('Promotion only targets staging or prod');
  if (receipt.decision.state !== 'qualified') return receipt;
  if (receipt.observation.rules.some((rule) => rule.type === 'merge_queue')) throw new Error('Promotion target unexpectedly requires a queue; do not bypass it');
  const result = api(`${repositoryRoute}/pulls/${number}/merge`, { method: 'PUT', body: { sha: expectedHead, merge_method: 'merge' } });
  if (!result.merged || !SHA.test(result.sha ?? '')) throw new Error('GitHub did not confirm the exact-head promotion merge');
  const merged = api(`${repositoryRoute}/pulls/${number}`);
  if (!merged.merged || merged.head.sha !== expectedHead || merged.merge_commit_sha !== result.sha) throw new Error('Promotion merge readback differs from the request');
  const commit = api(`${repositoryRoute}/commits/${result.sha}`);
  if (commit.commit.tree.sha !== receipt.observation.promotion.sourceTree) throw new Error('Promoted tree differs from the qualified selected source');
  return { ...receipt, delivery: verifiedMerge(number, expectedHead, merged.base.ref,
    { merged: true, headRefOid: merged.head.sha, mergeCommit: { oid: result.sha } }, api), publication: 'not-requested' };
}

export function parseArguments(args) {
  let command = args[0] && !args[0].startsWith('--') ? args.shift() : 'inspect';
  if (!['inspect', 'prepare', 'enqueue', 'deliver', 'promote', 'propose-rules'].includes(command)) throw new Error('Unsupported delivery command');
  const options = {};
  while (args.length) {
    const flag = args.shift();
    if (flag === '--deliver') {
      if (command !== 'inspect') throw new Error('Duplicate delivery command');
      command = 'deliver';
      continue;
    }
    const names = { '--pr': 'number', '--expected-head': 'expectedHead', '--source': 'sourceSha', '--out': 'out', '--max-wait-ms': 'maxWaitMs', '--max-requests': 'maxRequests' };
    const key = names[flag];
    if (!key || options[key] !== undefined || !args[0] || args[0].startsWith('--')) throw new Error(`Invalid option: ${flag}`);
    options[key] = args.shift();
  }
  for (const key of ['number', 'maxWaitMs', 'maxRequests']) if (options[key] !== undefined) options[key] = Number(options[key]);
  if (command !== 'propose-rules' && !(command === 'deliver' && options.number === undefined) && (!Number.isSafeInteger(options.number) || options.number < 1)) throw new Error('--pr must name a positive pull request number');
  if (command === 'promote' && !SHA.test(options.sourceSha ?? '')) throw new Error('Promotion requires --source with an exact selected source SHA');
  return { command, options };
}

export async function main(args = process.argv.slice(2)) {
  const { command, options } = parseArguments([...args]);
  if (command === 'deliver' && options.number === undefined) {
    options.number = JSON.parse(execFileSync('gh', ['pr', 'view', '--repo', policy.repository.name, '--json', 'number'], { encoding: 'utf8' })).number;
  }
  const receipt = command === 'propose-rules' ? proposedRules()
    : command === 'deliver' ? await deliverPullRequest(options.number, options)
      : command === 'promote' ? promoteQualifiedPullRequest(options.number, options)
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
  main().then((code) => { process.exitCode = code; }).catch((error) => { console.error(error.message); process.exitCode = 2; });
}

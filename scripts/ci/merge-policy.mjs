import { readFileSync } from 'node:fs';

export const policy = JSON.parse(readFileSync(new URL('../../.ci/merge-policy.json', import.meta.url), 'utf8'));
const SHA = /^[a-f0-9]{40}$/u;

export function branchPolicy(target) {
  if (!Object.hasOwn(policy.branches, target)) throw new Error(`Unsupported delivery target: ${target}`);
  return policy.branches[target];
}

export function selectWorkflowRun(runs, path, headSha) {
  const prefix = `https://api.github.com/repos/${policy.repository.name}/actions/`;
  return runs.filter((run) => run.path === path && run.head_sha === headSha && run.event === 'pull_request' &&
    run.repository?.id === policy.repository.id && run.workflow_url?.startsWith(prefix) &&
    /^(?:workflows|required_workflows)\/[1-9][0-9]*$/u.test(run.workflow_url.slice(prefix.length)))
    .sort((a, b) => b.id - a.id || b.run_attempt - a.run_attempt)[0];
}

export function selectRequiredWork(changedPaths) {
  if (!Array.isArray(changedPaths) || changedPaths.length === 0 ||
      changedPaths.some((path) => typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\0') || path.split('/').includes('..'))) {
    throw new Error('Coverage requires a nonempty list of repository-relative changed paths');
  }
  const documentation = changedPaths.every((path) =>
    /^(?:AGENTS|README|CONTRIBUTING|MAINTAINING|CHANGELOG|CODE_OF_CONDUCT|SECURITY|NOTICE)\.md$/u.test(path) ||
    /^(?:docs|skills)\/.+\.md$/u.test(path));
  return {
    kind: documentation ? 'documentation' : 'code',
    nativeRequired: !documentation,
    journeys: documentation ? [] : [...policy.native.journeys],
    reason: documentation ? 'Only documentation paths changed; native application journeys are unneeded.' : 'Code or unclassified paths changed; every native journey is required.',
  };
}

export function proposedRules() {
  return {
    state: 'proposal-only',
    repositories: Object.entries(policy.branches).map(([target, config]) => ({
      target,
      endpoint: `repos/${policy.repository.name}/rulesets`,
      body: {
        name: `Public ${target} qualification`, target: 'branch', enforcement: 'active', bypass_actors: [],
        conditions: { ref_name: { include: [`refs/heads/${target}`], exclude: [] } },
        rules: [
          { type: 'deletion' },
          { type: 'non_fast_forward' },
          { type: 'pull_request', parameters: {
            required_approving_review_count: 0, dismiss_stale_reviews_on_push: false,
            require_code_owner_review: false, require_last_push_approval: false,
            required_review_thread_resolution: false, require_extra_approval_for_unattributed_changes: false,
            allowed_merge_methods: [config.queue ? 'squash' : 'merge'],
          } },
          { type: 'required_status_checks', parameters: {
            strict_required_status_checks_policy: !config.queue, do_not_enforce_on_create: false,
            required_status_checks: config.requiredChecks.map((context) => ({ context,
              integration_id: policy.externalChecks[context]?.appId ?? policy.authority.appId })),
          } },
          ...(config.queue ? [{ type: 'merge_queue', parameters: {
            merge_method: policy.queue.mergeMethod, grouping_strategy: policy.queue.groupingStrategy,
            max_entries_to_build: policy.queue.maxEntriesToBuild,
            min_entries_to_merge: policy.queue.minEntriesToMerge,
            max_entries_to_merge: policy.queue.maxEntriesToMerge,
            min_entries_to_merge_wait_minutes: 0,
            check_response_timeout_minutes: policy.queue.checkResponseTimeoutMinutes,
          } }] : []),
        ],
      },
    })),
  };
}

export function assessQualification(candidate, observation) {
  const rejected = [], pending = [];
  const reject = (condition, reason) => { if (!condition) rejected.push(reason); };
  const { repository, rules = [], runs = [], checks = [], jobs = {}, qualification, sourceCommit, ancestry = {} } = observation;
  const target = candidate?.base?.ref;
  const config = Object.hasOwn(policy.branches, target ?? '') ? branchPolicy(target) : null;
  reject(repository?.id === policy.repository.id && repository?.full_name === policy.repository.name, 'Repository identity does not match public DNAForge');
  reject(candidate?.state === 'open', 'Pull request is not open');
  reject(config && candidate?.base?.repo?.id === policy.repository.id, 'Pull request target is not a supported public branch');
  reject(candidate?.draft === false, 'Pull request is held as a draft');
  reject(!candidate?.labels?.some((label) => policy.delivery.holdLabels.includes(String(label.name).toLowerCase())), 'Pull request has an explicit merge hold');
  reject(!candidate?.expectedHead || candidate.expectedHead === candidate?.head?.sha, 'Expected head differs from the current pull request head');
  reject(SHA.test(candidate?.head?.sha ?? ''), 'Pull request head is missing or malformed');
  const selectedRuns = {};
  if (config) {
    if (config.queue) reject(rules.some((rule) => rule.type === 'merge_queue' && rule.parameters?.grouping_strategy === 'ALLGREEN'), 'Required ALLGREEN merge queue is absent');
    const prRules = rules.filter((rule) => rule.type === 'pull_request');
    reject(prRules.length > 0, 'Required pull-request rule is absent');
    for (const rule of prRules) {
      reject(rule.parameters?.required_approving_review_count === 0 && rule.parameters?.require_code_owner_review !== true && rule.parameters?.require_last_push_approval !== true && rule.parameters?.require_extra_approval_for_unattributed_changes !== true, 'An approving-review requirement is forbidden');
    }
    const required = rules.filter((rule) => rule.type === 'required_status_checks').flatMap((rule) => rule.parameters?.required_status_checks ?? []);
    for (const name of config.requiredChecks) {
      reject(required.some((check) => check.context === name && check.integration_id === (policy.externalChecks[name]?.appId ?? policy.authority.appId)), `Required check is absent or publisher is unbound: ${name}`);
    }
    for (const path of [config.workflow, policy.authority.claWorkflow]) {
      const run = selectWorkflowRun(runs, path, candidate?.head?.sha);
      selectedRuns[path] = run;
      if (!run || run.status !== 'completed') pending.push(`Current workflow is missing or pending: ${path}`);
      else reject(run.conclusion === 'success', `Current workflow did not succeed: ${path} (${run.conclusion})`);
    }
    for (const name of config.requiredChecks) {
      const external = policy.externalChecks[name];
      const run = selectedRuns[name === 'Every commit agrees to the CLA' ? policy.authority.claWorkflow : config.workflow];
      const matching = checks.filter((check) => check.name === name && check.head_sha === candidate?.head?.sha &&
        check.app?.id === (external?.appId ?? policy.authority.appId) && (external || check.check_suite?.id === run?.check_suite_id))
        .sort((a, b) => b.id - a.id);
      const check = matching[0];
      if (!check || check.status !== 'completed') pending.push(`Required current check is missing or pending: ${name}`);
      else reject(check.conclusion === 'success', `Required check did not succeed: ${name} (${check.conclusion})`);
      if (!external && run) {
        const job = jobs[run.id]?.find((entry) => entry.check_run_url?.endsWith(`/${check?.id}`));
        if (!job) pending.push(`Required check has no job in the current run attempt: ${name}`);
        else reject(job.status === 'completed' && job.conclusion === 'success', `Required job did not succeed: ${name} (${job.conclusion})`);
      }
    }
    if (config.role === 'promotion') {
      const promotion = observation.promotion;
      if (!promotion) pending.push('Exact promotion source and upstream evidence are missing');
      else {
        reject([promotion.sourceSha, promotion.sourceTree, promotion.upstreamSha].every((sha) => SHA.test(sha ?? '')), 'Promotion source identity is invalid');
        reject(!candidate.expectedSource || candidate.expectedSource === promotion.sourceSha, 'Promotion selected source differs from the expected source');
        reject(['ahead', 'identical'].includes(promotion.ancestry), `Promotion source is not contained by ${config.upstream}`);
        reject(candidate.head.sha === promotion.sourceSha || ['ahead', 'identical'].includes(promotion.headAncestry), 'Promotion PR does not preserve selected source ancestry');
        reject(promotion.headTree === promotion.sourceTree, 'Promotion PR contains changes outside the selected source');
      }
      const run = selectedRuns[config.workflow];
      if (!qualification) pending.push('Source-bound qualification artifact is missing');
      else {
        reject(qualification.version === 1 && qualification.status === 'passed', 'Qualification receipt is not a passing supported result');
        reject(String(qualification.runId) === String(run?.id) && qualification.attempt === run?.run_attempt, 'Qualification receipt belongs to another run or attempt');
        reject(sourceCommit?.sha === qualification.sourceSha && sourceCommit?.commit?.tree?.sha === qualification.sourceTree, 'Qualification source commit or tree differs from GitHub');
        reject(sourceCommit?.parents?.[0]?.sha === qualification.baseSha && sourceCommit?.parents?.some((parent) => parent.sha === candidate?.head?.sha), 'Qualification is not the test merge of this pull request head');
        reject(qualification.baseSha === candidate.base.sha && ['ahead', 'identical'].includes(ancestry.base), 'Qualification base differs from the current promotion target');
        reject(['ahead', 'identical'].includes(ancestry.control) && SHA.test(qualification.controlSha ?? ''), 'Qualification control source is not a protected development ancestor');
        reject(qualification.controlRef === `${policy.repository.name}/${config.workflow}@${policy.authority.ref}`, 'Qualification control workflow is not from protected development');
        reject(qualification.sourceTree === promotion?.sourceTree, 'Qualified combined tree differs from the selected promotion source');
        const coverage = selectRequiredWork(observation.changedPaths);
        reject(JSON.stringify(qualification.coverage?.journeys) === JSON.stringify(coverage.journeys) && qualification.coverage?.nativeRequired === coverage.nativeRequired && qualification.coverage?.kind === coverage.kind, 'Qualification coverage differs from the required changed-path selection');
        reject(qualification.desktop?.files > 0 && qualification.desktop?.passed > 0, 'Desktop qualification contains no executed tests');
      }
    }
  }
  if (observation.errors?.length) pending.push(...observation.errors);
  return {
    state: rejected.length ? 'rejected' : pending.length ? 'pending' : 'qualified',
    reasons: [...rejected, ...pending],
    candidate: { number: candidate?.number, headSha: candidate?.head?.sha, target },
    runs: Object.fromEntries(Object.entries(selectedRuns).map(([path, value]) => [path, value ? { id: value.id, attempt: value.run_attempt, url: value.html_url } : null])),
  };
}

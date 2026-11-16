import { readFileSync } from 'node:fs';

export const policy = JSON.parse(readFileSync(new URL('../../.ci/merge-policy.json', import.meta.url), 'utf8'));

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
    repository: {
      endpoint: `repos/${policy.repository.name}/rulesets`,
      body: {
        name: 'Public main qualification', target: 'branch', enforcement: 'active', bypass_actors: [],
        conditions: { ref_name: { include: [policy.authority.ref], exclude: [] } },
        rules: [
          { type: 'deletion' },
          { type: 'non_fast_forward' },
          { type: 'pull_request', parameters: {
            required_approving_review_count: 0, dismiss_stale_reviews_on_push: false,
            require_code_owner_review: false, require_last_push_approval: false,
            required_review_thread_resolution: false, require_extra_approval_for_unattributed_changes: false,
            allowed_merge_methods: ['merge'],
          } },
          { type: 'required_status_checks', parameters: {
            strict_required_status_checks_policy: false, do_not_enforce_on_create: false,
            required_status_checks: policy.requiredChecks.map((context) => ({ context, integration_id: policy.authority.appId })),
          } },
          { type: 'merge_queue', parameters: {
            merge_method: policy.queue.mergeMethod, grouping_strategy: policy.queue.groupingStrategy,
            max_entries_to_build: policy.queue.maxEntriesToBuild,
            min_entries_to_merge: policy.queue.minEntriesToMerge,
            max_entries_to_merge: policy.queue.maxEntriesToMerge,
            min_entries_to_merge_wait_minutes: 0,
            check_response_timeout_minutes: policy.queue.checkResponseTimeoutMinutes,
          } },
        ],
      },
    },
    organization: {
      endpoint: `orgs/${policy.repository.name.split('/')[0]}/rulesets`,
      body: {
        name: 'Public main trusted workflow', target: 'branch', enforcement: 'active', bypass_actors: [],
        conditions: {
          repository_id: { repository_ids: [policy.repository.id] },
          ref_name: { include: [policy.authority.ref], exclude: [] },
        },
        rules: [{ type: 'workflows', parameters: { do_not_enforce_on_create: false, workflows: [{
          repository_id: policy.repository.id, path: policy.authority.workflow, ref: policy.authority.ref,
        }] } }],
      },
    },
  };
}

export function assessQualification(candidate, observation) {
  const rejected = [];
  const pending = [];
  const reject = (condition, reason) => { if (!condition) rejected.push(reason); };
  const { repository, rules = [], runs = [], checks = [], jobs = {}, qualification, sourceCommit, ancestry = {} } = observation;
  reject(repository?.id === policy.repository.id && repository?.full_name === policy.repository.name, 'Repository identity does not match public DNAForge');
  reject(candidate?.state === 'open', 'Pull request is not open');
  reject(candidate?.base?.ref === policy.repository.target && candidate?.base?.repo?.id === policy.repository.id, 'Pull request target is not public main');
  reject(candidate?.draft === false, 'Pull request is held as a draft');
  reject(!candidate?.labels?.some((label) => policy.delivery.holdLabels.includes(String(label.name).toLowerCase())), 'Pull request has an explicit merge hold');
  reject(!candidate?.expectedHead || candidate.expectedHead === candidate?.head?.sha, 'Expected head differs from the current pull request head');
  reject(/^[a-f0-9]{40}$/u.test(candidate?.head?.sha ?? ''), 'Pull request head is missing or malformed');
  const queue = rules.find((rule) => rule.type === 'merge_queue');
  reject(queue?.parameters?.grouping_strategy === 'ALLGREEN', 'Required ALLGREEN merge queue is absent');
  const prRules = rules.filter((rule) => rule.type === 'pull_request');
  reject(prRules.length > 0, 'Required pull-request rule is absent');
  for (const rule of prRules) {
    reject(rule.parameters?.required_approving_review_count === 0 && rule.parameters?.require_code_owner_review !== true && rule.parameters?.require_last_push_approval !== true && rule.parameters?.require_extra_approval_for_unattributed_changes !== true, 'An approving-review requirement is forbidden');
  }
  const required = rules.filter((rule) => rule.type === 'required_status_checks')
    .flatMap((rule) => rule.parameters?.required_status_checks ?? []);
  for (const name of policy.requiredChecks) {
    reject(required.some((check) => check.context === name && check.integration_id === policy.authority.appId), `Required check is absent or publisher is unbound: ${name}`);
  }
  reject(rules.some((rule) => rule.type === 'workflows' && ['Organization', 'Enterprise'].includes(rule.ruleset_source_type) &&
    rule.parameters?.workflows?.some((workflow) => workflow.repository_id === policy.repository.id && workflow.path === policy.authority.workflow && workflow.ref === policy.authority.ref)),
  'Organization-required trusted CI workflow is absent');
  const selectedRuns = {};
  for (const path of [policy.authority.workflow, policy.authority.claWorkflow]) {
    const matching = runs.filter((run) => run.path === path && run.head_sha === candidate?.head?.sha && run.event === 'pull_request' && run.repository?.id === policy.repository.id)
      .sort((a, b) => b.id - a.id || b.run_attempt - a.run_attempt);
    const run = matching[0];
    selectedRuns[path] = run;
    if (!run || run.status !== 'completed') pending.push(`Current workflow is missing or pending: ${path}`);
    else reject(run.conclusion === 'success', `Current workflow did not succeed: ${path} (${run.conclusion})`);
  }
  for (const name of policy.requiredChecks) {
    const run = selectedRuns[name === policy.requiredChecks[0] ? policy.authority.claWorkflow : policy.authority.workflow];
    if (!run) continue;
    const matching = checks.filter((check) => check.name === name && check.check_suite?.id === run.check_suite_id && check.head_sha === candidate?.head?.sha && check.app?.id === policy.authority.appId)
      .sort((a, b) => b.id - a.id);
    const check = matching[0];
    const job = jobs[run.id]?.find((entry) => entry.check_run_url?.endsWith(`/${check?.id}`));
    if (!check || check.status !== 'completed') pending.push(`Required current check is missing or pending: ${name}`);
    else reject(check.conclusion === 'success', `Required check did not succeed: ${name} (${check.conclusion})`);
    if (!job) pending.push(`Required check has no job in the current run attempt: ${name}`);
    else reject(job.status === 'completed' && job.conclusion === 'success', `Required job did not succeed: ${name} (${job.conclusion})`);
  }
  const run = selectedRuns[policy.authority.workflow];
  if (!qualification) pending.push('Source-bound qualification artifact is missing');
  else {
    reject(qualification.version === 1 && qualification.status === 'passed', 'Qualification receipt is not a passing supported result');
    reject(String(qualification.runId) === String(run?.id) && qualification.attempt === run?.run_attempt, 'Qualification receipt belongs to another run or attempt');
    reject(sourceCommit?.sha === qualification.sourceSha && sourceCommit?.commit?.tree?.sha === qualification.sourceTree, 'Qualification source commit or tree differs from GitHub');
    reject(sourceCommit?.parents?.[0]?.sha === qualification.baseSha && sourceCommit?.parents?.some((parent) => parent.sha === candidate?.head?.sha), 'Qualification is not the test merge of this pull request head');
    reject(['ahead', 'identical'].includes(ancestry.base), 'Qualification base is not an ancestor of current main');
    reject(['ahead', 'identical'].includes(ancestry.control), 'Qualification control source is not an ancestor of current main');
    reject(/^[a-f0-9]{40}$/u.test(qualification.controlSha ?? ''), 'Qualification control revision is missing');
    const coverage = selectRequiredWork(observation.changedPaths);
    reject(JSON.stringify(qualification.coverage?.journeys) === JSON.stringify(coverage.journeys) && qualification.coverage?.nativeRequired === coverage.nativeRequired && qualification.coverage?.kind === coverage.kind, 'Qualification coverage differs from the required changed-path selection');
    reject(qualification.desktop?.files > 0 && qualification.desktop?.passed > 0, 'Desktop qualification contains no executed tests');
  }
  if (observation.errors?.length) pending.push(...observation.errors);
  return {
    state: rejected.length ? 'rejected' : pending.length ? 'pending' : 'qualified',
    reasons: [...rejected, ...pending],
    candidate: { number: candidate?.number, headSha: candidate?.head?.sha, target: candidate?.base?.ref },
    runs: Object.fromEntries(Object.entries(selectedRuns).map(([path, value]) => [path, value ? { id: value.id, attempt: value.run_attempt, url: value.html_url } : null])),
  };
}

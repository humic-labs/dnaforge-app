import { policy, proposedRules, selectRequiredWork } from './merge-policy.mjs';

export function qualifiedFixture() {
  const head = '1'.repeat(40), base = '2'.repeat(40), source = '3'.repeat(40), tree = '4'.repeat(40);
  const candidate = { number: 99, node_id: 'PR_example', state: 'open', draft: false, labels: [],
    head: { sha: head }, base: { ref: 'main', sha: base, repo: { id: policy.repository.id } } };
  const proposal = proposedRules();
  const runs = [policy.authority.workflow, policy.authority.claWorkflow].map((path, index) => ({
    id: 10 + index, run_attempt: 2, event: 'pull_request', path, head_sha: head,
    workflow_url: `https://api.github.com/repos/${policy.repository.name}/actions/${index === 0 ? 'required_workflows' : 'workflows'}/${10 + index}`,
    check_suite_id: 20 + index, repository: { id: policy.repository.id }, status: 'completed', conclusion: 'success',
  }));
  const checks = policy.requiredChecks.map((name, index) => ({ id: 30 + index, name, head_sha: head,
    check_suite: { id: name === policy.requiredChecks[0] ? 21 : 20 }, app: { id: policy.authority.appId }, status: 'completed', conclusion: 'success' }));
  const jobs = Object.fromEntries(runs.map((run) => [run.id, checks.filter((check) => check.check_suite.id === run.check_suite_id)
    .map((check) => ({ name: check.name, check_run_url: `https://api.github.com/check-runs/${check.id}`, status: 'completed', conclusion: 'success' }))]));
  const observation = {
    repository: { id: policy.repository.id, full_name: policy.repository.name },
    rules: [...proposal.repository.body.rules, ...proposal.organization.body.rules.map((rule) => ({ ...rule, ruleset_source_type: 'Organization' }))],
    changedPaths: ['apps/desktop/src/App.tsx'], runs, checks, jobs, errors: [],
    qualification: { version: 1, status: 'passed', runId: '10', attempt: 2,
      sourceSha: source, sourceTree: tree, baseSha: base, controlSha: base,
      controlRef: `${policy.repository.name}/${policy.authority.workflow}@${policy.authority.ref}`,
      coverage: selectRequiredWork(['apps/desktop/src/App.tsx']), desktop: { files: 5, passed: 20 } },
    sourceCommit: { sha: source, commit: { tree: { sha: tree } }, parents: [{ sha: base }, { sha: head }] },
    ancestry: { base: 'identical', control: 'identical' },
  };
  return { candidate, observation };
}

import { createHash } from 'node:crypto';
import { branchPolicy, policy, proposedRules, selectRequiredWork } from './merge-policy.mjs';

export function qualifiedFixture(target = 'staging') {
  const head = '1'.repeat(40), base = '2'.repeat(40), source = '3'.repeat(40), tree = '4'.repeat(40);
  const config = branchPolicy(target);
  const candidate = { number: 99, node_id: 'PR_example', state: 'open', draft: false, labels: [],
    head: { sha: head, repo: { id: policy.repository.id } }, base: { ref: target, sha: base, repo: { id: policy.repository.id } } };
  const proposal = proposedRules().repositories.find((entry) => entry.target === target);
  const runs = [config.workflow, policy.authority.claWorkflow].map((path, index) => ({
    id: 10 + index, run_attempt: 2, event: 'pull_request', path, head_sha: head,
    workflow_url: `https://api.github.com/repos/${policy.repository.name}/actions/workflows/${10 + index}`,
    check_suite_id: 20 + index, repository: { id: policy.repository.id }, status: 'completed', conclusion: 'success',
  }));
  const checks = config.requiredChecks.map((name, index) => ({ id: 30 + index, name, head_sha: head,
    check_suite: { id: name === 'Every commit agrees to the CLA' ? 21 : policy.externalChecks[name] ? 22 : 20 },
    app: { id: policy.authority.appId }, status: 'completed', conclusion: 'success' }));
  const jobs = Object.fromEntries(runs.map((run) => [run.id, checks.filter((check) => check.check_suite.id === run.check_suite_id)
    .map((check) => ({ name: check.name, check_run_url: `https://api.github.com/check-runs/${check.id}`, status: 'completed', conclusion: 'success' }))]));
  const observation = {
    repository: { id: policy.repository.id, full_name: policy.repository.name },
    rules: proposal.body.rules,
    changedPaths: ['apps/desktop/src/App.tsx'], runs, checks, jobs, errors: [],
    qualification: { version: 1, status: 'passed', runId: '10', attempt: 2,
      sourceSha: source, sourceTree: tree, baseSha: base, controlSha: base,
      controlRef: `${policy.repository.name}/${config.workflow}@${policy.authority.ref}`,
      coverage: selectRequiredWork(['apps/desktop/src/App.tsx']), desktop: { files: 5, passed: 20 } },
    sourceCommit: { sha: source, commit: { tree: { sha: tree } }, parents: [{ sha: base }, { sha: head }] },
    promotion: { sourceSha: head, sourceTree: tree, headTree: tree, upstreamSha: head, ancestry: 'identical' },
    ancestry: { base: 'identical', control: 'identical' },
  };
  const external = checks.find((check) => check.name === 'Electron E2E');
  if (external) {
    const receipt = {
      schema: 'dnaforge.public-electron-qualification.v1',
      repository: policy.repository.name, repositoryId: policy.repository.id,
      pullRequest: candidate.number, target, headSha: head, baseSha: base,
      mergeSha: source, treeSha: tree,
      controller: { commit: 'c'.repeat(40), tree: 'd'.repeat(40) },
      run: { id: 700, attempt: 1, workflow: '.github/workflows/e2e-electron.yml' },
      rosterSha256: 'a'.repeat(64), evidenceSha256: 'b'.repeat(64), status: 'passed',
      counts: { passed: 20, skipped: 0, flaky: 0, failedAttempts: 0, reports: 2 },
    };
    const text = JSON.stringify(receipt);
    external.app.id = policy.externalChecks['Electron E2E'].appId;
    external.output = { text };
    external.external_id = `${receipt.schema}:${createHash('sha256').update(text).digest('hex')}`;
    external.details_url = 'https://github.com/humic-labs/dnaforge/actions/runs/700/attempts/1';
  }
  return { candidate, observation };
}

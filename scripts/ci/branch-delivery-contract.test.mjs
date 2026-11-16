import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const root =
  process.env.DNAFORGE_DELIVERY_SUBJECT_ROOT || fileURLToPath(new URL('../..', import.meta.url));
const subject = (name) => import(pathToFileURL(resolve(root, 'scripts/ci', name)).href);
const policyModule = await subject('merge-policy.mjs');
const delivery = await subject('deliver.mjs');
const preflight = await subject('preflight.mjs').catch((error) => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const repository = { id: 1454956566, full_name: 'humic-labs/dnaforge-app' };
const route = `repos/${repository.full_name}`;
const head = '1'.repeat(40);
const base = '2'.repeat(40);
const source = '3'.repeat(40);
const tree = '4'.repeat(40);
const merged = '5'.repeat(40);
const cla = 'Every commit agrees to the CLA';
const preflightPath = '.github/workflows/pr-preflight.yml';
const broadPath = '.github/workflows/ci.yml';
const claPath = '.github/workflows/cla.yml';

function fixture(target = 'dev') {
  const development = target === 'dev';
  const names = development
    ? [cla, 'PR Preflight']
    : [cla, 'Promotion qualification', 'Electron E2E'];
  const paths = [claPath, development ? preflightPath : broadPath];
  const candidate = {
    number: 99,
    node_id: 'PR_contract',
    state: 'open',
    draft: false,
    labels: [],
    auto_merge: null,
    head: { sha: head, ref: 'feature/example', repo: { id: repository.id } },
    base: { ref: target, sha: base, repo: { id: repository.id } },
    expectedHead: head,
  };
  const rules = [
    { type: 'deletion' },
    { type: 'non_fast_forward' },
    {
      type: 'pull_request',
      parameters: {
        required_approving_review_count: 0,
        require_code_owner_review: false,
        require_last_push_approval: false,
        require_extra_approval_for_unattributed_changes: false,
        allowed_merge_methods: [development ? 'squash' : 'merge'],
      },
    },
    {
      type: 'required_status_checks',
      parameters: {
        strict_required_status_checks_policy: false,
        required_status_checks: names.map((context) => ({ context,
          integration_id: policyModule.policy.externalChecks[context]?.appId ?? 15368 })),
      },
    },
    ...(development
      ? [
          {
            type: 'merge_queue',
            parameters: { grouping_strategy: 'ALLGREEN', merge_method: 'SQUASH' },
          },
        ]
      : []),
  ];
  const runs = paths.map((path, index) => ({
    id: 10 + index,
    run_attempt: 2,
    event: 'pull_request',
    path,
    head_sha: head,
    workflow_url: `https://api.github.com/${route}/actions/workflows/${501 + index}`,
    check_suite_id: 20 + index,
    repository,
    status: 'completed',
    conclusion: 'success',
    html_url: `https://github.com/${repository.full_name}/actions/runs/${10 + index}`,
  }));
  const checks = names.map((name, index) => ({
    id: 30 + index,
    name,
    head_sha: head,
    check_suite: { id: index === 0 ? 20 : 21 },
    app: { id: policyModule.policy.externalChecks[name]?.appId ?? 15368 },
    status: 'completed',
    conclusion: 'success',
    details_url: `https://github.com/${repository.full_name}/actions/runs/${index === 0 ? 10 : 11}/job/${30 + index}`,
  }));
  const jobs = Object.fromEntries(
    runs.map((run) => [
      run.id,
      checks
        .filter((check) => check.check_suite.id === run.check_suite_id)
        .map((check) => ({
          name: check.name,
          check_run_url: `https://api.github.com/check-runs/${check.id}`,
          status: 'completed',
          conclusion: 'success',
        })),
    ])
  );
  const observation = {
    repository,
    rules,
    runs,
    checks,
    jobs,
    errors: [],
    changedPaths: ['apps/desktop/src/App.tsx'],
    sourceCommit: {
      sha: source,
      commit: { tree: { sha: tree } },
      parents: [{ sha: base }, { sha: head }],
    },
    ancestry: { base: 'identical', control: 'identical' },
    promotion: {
      sourceSha: head,
      sourceTree: tree,
      headTree: tree,
      upstreamSha: head,
      ancestry: 'identical',
    },
  };
  return { candidate, observation };
}

function assess(f) {
  return policyModule.assessQualification(f.candidate, f.observation);
}

function apiHarness(target = 'dev') {
  const f = fixture(target);
  const writes = [];
  let queued = false;
  const api = (path, options = {}) => {
    const method = options.method ?? 'GET';
    if (method !== 'GET') writes.push({ path, method, body: options.body });
    if (path === 'graphql') {
      const query = options.body?.query ?? '';
      if (query.includes('markPullRequestReadyForReview')) {
        f.candidate.draft = false;
        const previousRun = f.observation.runs.find((run) => run.path === preflightPath);
        const freshRun = {
          ...previousRun,
          id: previousRun.id + 1,
          check_suite_id: previousRun.check_suite_id + 1,
          html_url: `https://github.com/${repository.full_name}/actions/runs/${previousRun.id + 1}`,
        };
        const previousCheck = f.observation.checks.find((check) => check.name === 'PR Preflight');
        const freshCheck = {
          ...previousCheck,
          id: previousCheck.id + 1,
          check_suite: { id: freshRun.check_suite_id },
          details_url: `${freshRun.html_url}/job/${previousCheck.id + 1}`,
        };
        f.observation.runs.push(freshRun);
        f.observation.checks.push(freshCheck);
        f.observation.jobs[freshRun.id] = [
          {
            name: freshCheck.name,
            check_run_url: `https://api.github.com/check-runs/${freshCheck.id}`,
            status: 'completed',
            conclusion: 'success',
          },
        ];
        return {
          data: {
            markPullRequestReadyForReview: {
              pullRequest: { id: f.candidate.node_id, isDraft: false, headRefOid: head },
            },
          },
        };
      }
      if (query.includes('enqueuePullRequest')) {
        queued = true;
        return {
          data: {
            enqueuePullRequest: {
              mergeQueueEntry: {
                id: 'QUEUE_contract',
                state: 'QUEUED',
                position: 1,
                enqueuedAt: '2026-01-01T00:00:00Z',
              },
            },
          },
        };
      }
      return {
        data: {
          repository: {
            pullRequest: {
              state: queued ? 'MERGED' : 'OPEN',
              headRefOid: head,
              merged: queued,
              mergedAt: queued ? '2026-01-01T00:01:00Z' : null,
              mergeCommit: queued ? { oid: merged } : null,
              mergeQueueEntry: queued ? { id: 'QUEUE_contract' } : null,
            },
          },
        },
      };
    }
    if (path === route) return f.observation.repository;
    if (path === `${route}/pulls/99`)
      return {
        ...structuredClone(f.candidate),
        ...(queued ? { state: 'closed', merged: true, merge_commit_sha: merged } : {}),
      };
    if (path.startsWith(`${route}/branches/`)) return { commit: { sha: queued ? merged : base } };
    if (path.startsWith(`${route}/rules/branches/`)) return f.observation.rules;
    if (path.includes('/files?'))
      return f.observation.changedPaths.map((filename) => ({ filename }));
    if (path.includes('/actions/runs?')) return { workflow_runs: f.observation.runs };
    if (path.includes('/check-runs?')) return { check_runs: f.observation.checks };
    const job = /\/runs\/(\d+)\/attempts\/2\/jobs\?/u.exec(path);
    if (job) return { jobs: f.observation.jobs[job[1]] };
    if (path.includes('/compare/'))
      return { status: 'identical', merge_base_commit: { sha: merged } };
    if (path.includes('/commits/')) return f.observation.sourceCommit;
    throw new Error(`Unexpected provider operation ${method} ${path}`);
  };
  return {
    ...f,
    api,
    writes,
    readArtifact: () => {
      throw new Error('Development admission must not download broad qualification');
    },
    expectedHead: head,
    localHead: head,
    localStatus: '',
    sleep: async () => {},
    now: () => 0,
    pollIntervalMs: 1,
    maxWaitMs: 10,
    maxRequests: 100,
  };
}

function requireFunction(module, name) {
  assert.equal(typeof module[name], 'function', `Missing public operation ${name}`);
  return module[name];
}

test('branch policy distinguishes development from both promotion boundaries', () => {
  assert.equal(policyModule.policy.repository.defaultBranch, 'dev');
  const branchPolicy = requireFunction(policyModule, 'branchPolicy');
  assert.deepEqual(branchPolicy('dev').requiredChecks, [cla, 'PR Preflight']);
  assert.equal(branchPolicy('dev').queue, true);
  for (const [target, upstream] of [
    ['staging', 'dev'],
    ['prod', 'staging'],
  ]) {
    assert.equal(branchPolicy(target).upstream, upstream);
    assert.equal(branchPolicy(target).queue, false);
    assert.deepEqual(branchPolicy(target).requiredChecks, [
      cla,
      'Promotion qualification',
      'Electron E2E',
    ]);
  }
  assert.throws(() => branchPolicy('stable'));
  assert.throws(() => branchPolicy('main'));
});

test('proposed rules require automated checks without any approving-review or bypass actor', () => {
  const proposal = policyModule.proposedRules();
  assert.deepEqual(proposal.repositories.map((r) => r.target).sort(), ['dev', 'prod', 'staging']);
  for (const { target, body } of proposal.repositories) {
    assert.deepEqual(body.bypass_actors, []);
    assert.deepEqual(body.conditions.ref_name.include, [`refs/heads/${target}`]);
    const pr = body.rules.find((r) => r.type === 'pull_request').parameters;
    assert.equal(pr.required_approving_review_count, 0);
    assert.equal(pr.require_code_owner_review, false);
    assert.equal(pr.require_last_push_approval, false);
    assert.equal(pr.require_extra_approval_for_unattributed_changes, false);
    assert.equal(
      body.rules.some((r) => r.type === 'merge_queue'),
      target === 'dev'
    );
  }
});

test('qualified development needs fast checks but no broad report or private tracker', () => {
  const f = fixture();
  assert.equal('qualification' in f.observation, false);
  assert.equal(assess(f).state, 'qualified');
});

for (const [name, mutate] of [
  ['missing fast check', (f) => f.observation.checks.pop()],
  [
    'skipped fast check',
    (f) => {
      f.observation.checks[1].conclusion = 'skipped';
    },
  ],
  [
    'wrong check publisher',
    (f) => {
      f.observation.checks[1].app.id = 1;
    },
  ],
  [
    'old attempt without current job',
    (f) => {
      f.observation.jobs[11] = [];
    },
  ],
  [
    'missing queue',
    (f) => {
      f.observation.rules = f.observation.rules.filter((r) => r.type !== 'merge_queue');
    },
  ],
  [
    'wrong branch',
    (f) => {
      f.candidate.base.ref = 'main';
    },
  ],
  [
    'explicit hold',
    (f) => {
      f.candidate.labels = [{ name: 'DO-NOT-MERGE' }];
    },
  ],
  [
    'stale head',
    (f) => {
      f.candidate.expectedHead = 'f'.repeat(40);
    },
  ],
  [
    'new failing run',
    (f) => {
      f.observation.runs.push({ ...f.observation.runs[1], id: 100, conclusion: 'failure' });
    },
  ],
]) {
  test(`development refuses ${name}`, () => {
    const f = fixture();
    mutate(f);
    assert.notEqual(assess(f).state, 'qualified');
  });
}

test('prepare preserves a draft without writing GitHub state', () => {
  const h = apiHarness();
  h.candidate.draft = true;
  const result = delivery.inspectPullRequest(99, h);
  assert.notEqual(result.decision.state, 'qualified');
  assert.equal(h.candidate.draft, true);
  assert.deepEqual(h.writes, []);
});

test('deliver is an ordinary CLI operation without a separate authorization flag', () => {
  const parsed = delivery.parseArguments(['deliver', '--pr', '99', '--expected-head', head]);
  assert.equal(parsed.command, 'deliver');
  assert.equal(parsed.options.expectedHead, head);
});

test('ordinary delivery readies the exact development PR, queues once and verifies its merge', async () => {
  const deliver = requireFunction(delivery, 'deliverPullRequest');
  const h = apiHarness();
  h.candidate.draft = true;
  const result = await deliver(99, h);
  assert.equal(result.delivery.state, 'merged');
  assert.equal(result.delivery.mergeCommit, merged);
  const mutations = h.writes.filter((w) => /mutation/u.test(w.body?.query ?? ''));
  assert.equal(mutations.length, 2);
  assert.match(mutations[0].body.query, /markPullRequestReadyForReview/u);
  assert.match(mutations[1].body.query, /enqueuePullRequest/u);
  assert.equal(mutations[1].body.variables.head, head);
  assert.doesNotMatch(JSON.stringify(mutations), /autoMerge|jump|bypass/u);
});

for (const [name, change] of [
  [
    'held development',
    (h) => {
      h.candidate.labels = [{ name: 'hold' }];
    },
  ],
  [
    'staging promotion',
    (h) => {
      h.candidate.base.ref = 'staging';
    },
  ],
  [
    'production promotion',
    (h) => {
      h.candidate.base.ref = 'prod';
    },
  ],
  [
    'stale local head',
    (h) => {
      h.localHead = 'a'.repeat(40);
    },
  ],
  [
    'dirty checkout',
    (h) => {
      h.localStatus = ' M source.ts';
    },
  ],
]) {
  test(`ordinary delivery cannot mutate ${name}`, async () => {
    const deliver = requireFunction(delivery, 'deliverPullRequest');
    const h = apiHarness();
    change(h);
    try {
      const result = await deliver(99, h);
      assert.notEqual(result.delivery?.state, 'merged');
    } catch (error) {
      assert.match(error.message, /hold|development|target|head|checkout|clean|staging|prod/iu);
    }
    assert.deepEqual(h.writes, []);
  });
}

function promotionFixture(target = 'staging') {
  const f = fixture(target);
  f.candidate.expectedSource = head;
  f.observation.qualification = {
    version: 1,
    status: 'passed',
    runId: '11',
    attempt: 2,
    sourceSha: source,
    sourceTree: tree,
    baseSha: base,
    controlSha: base,
    controlRef: `${repository.full_name}/${broadPath}@refs/heads/dev`,
    coverage: {
      kind: 'code',
      nativeRequired: true,
      journeys: ['workspace', 'track', 'genome', 'canvas', 'chat', 'palettes'],
    },
    desktop: { files: 5, passed: 20 },
  };
  const receipt = {
    schema: 'dnaforge.public-electron-qualification.v1',
    repository: repository.full_name, repositoryId: repository.id,
    pullRequest: f.candidate.number, target, headSha: head, baseSha: base,
    mergeSha: source, treeSha: tree,
    controller: { commit: 'c'.repeat(40), tree: 'd'.repeat(40) },
    run: { id: 700, attempt: 1, workflow: '.github/workflows/e2e-electron.yml' },
    rosterSha256: 'a'.repeat(64), evidenceSha256: 'b'.repeat(64), status: 'passed',
    counts: { passed: 20, skipped: 0, flaky: 0, failedAttempts: 0, reports: 2 },
  };
  const text = JSON.stringify(receipt);
  const external = f.observation.checks.find((check) => check.name === 'Electron E2E');
  external.output = { text };
  external.external_id = `${receipt.schema}:${createHash('sha256').update(text).digest('hex')}`;
  external.details_url = 'https://github.com/humic-labs/dnaforge/actions/runs/700/attempts/1';
  return f;
}

for (const target of ['staging', 'prod']) {
  test(`${target} qualifies the exact upstream source with broad and external Electron evidence`, () => {
    assert.equal(assess(promotionFixture(target)).state, 'qualified');
  });
  for (const [name, mutate] of [
    [
      'only public native journeys',
      (f) => {
        f.observation.checks = f.observation.checks.filter((c) => c.name !== 'Electron E2E');
      },
    ],
    [
      'failed external Electron check',
      (f) => {
        f.observation.checks.find((c) => c.name === 'Electron E2E').conclusion = 'failure';
      },
    ],
    [
      'skipped external Electron check',
      (f) => {
        f.observation.checks.find((c) => c.name === 'Electron E2E').conclusion = 'skipped';
      },
    ],
    [
      'wrong external publisher',
      (f) => {
        f.observation.checks.find((c) => c.name === 'Electron E2E').app.id = 7;
      },
    ],
    [
      'another source tested externally',
      (f) => {
        f.observation.checks.find((c) => c.name === 'Electron E2E').head_sha = 'a'.repeat(40);
      },
    ],
    [
      'source outside upstream',
      (f) => {
        f.observation.promotion.ancestry = 'diverged';
      },
    ],
    [
      'changed candidate tree',
      (f) => {
        f.observation.promotion.headTree = 'a'.repeat(40);
      },
    ],
    [
      'changed tested tree',
      (f) => {
        f.observation.qualification.sourceTree = 'a'.repeat(40);
      },
    ],
    [
      'different requested source',
      (f) => {
        f.candidate.expectedSource = 'a'.repeat(40);
      },
    ],
  ]) {
    test(`${target} refuses ${name}`, () => {
      const f = promotionFixture(target);
      mutate(f);
      assert.notEqual(assess(f).state, 'qualified');
    });
  }
}

const lanes = [
  [
    'pull_request',
    { pull_request: { base: { ref: 'dev' }, draft: true } },
    'refs/pull/99/merge',
    'draft',
  ],
  [
    'pull_request',
    { pull_request: { base: { ref: 'dev' }, draft: false } },
    'refs/pull/99/merge',
    'development',
  ],
  [
    'merge_group',
    { merge_group: { base_ref: 'refs/heads/dev' } },
    'refs/heads/gh-readonly-queue/dev/example',
    'development',
  ],
  [
    'pull_request',
    { pull_request: { base: { ref: 'staging' }, draft: false } },
    'refs/pull/99/merge',
    'qualification',
  ],
  [
    'pull_request',
    { pull_request: { base: { ref: 'prod' }, draft: false } },
    'refs/pull/99/merge',
    'qualification',
  ],
  ['push', {}, 'refs/heads/dev', 'qualification'],
  ['push', {}, 'refs/heads/staging', 'qualification'],
  ['push', {}, 'refs/heads/prod', 'qualification'],
  ['schedule', {}, 'refs/heads/dev', 'qualification'],
  ['workflow_dispatch', {}, 'refs/heads/dev', 'qualification'],
];
for (const [eventName, event, ref, expected] of lanes) {
  test(`${eventName} ${event.pull_request?.base.ref ?? ref} selects ${expected}`, () => {
    assert.equal(requireFunction(preflight, 'ciLane')(eventName, event, ref), expected);
  });
}
for (const [eventName, event, ref] of [
  ['pull_request', {}, 'refs/pull/99/merge'],
  ['merge_group', {}, 'refs/heads/gh-readonly-queue/dev/example'],
  ['push', {}, 'refs/heads/main'],
  ['workflow_dispatch', {}, 'refs/heads/unclassified'],
  ['unknown', {}, 'refs/heads/dev'],
]) {
  test(`refuses ambiguous CI lane ${eventName} ${ref}`, () => {
    const lane = requireFunction(preflight, 'ciLane');
    assert.throws(() => lane(eventName, event, ref));
  });
}

const projects = [
  {
    name: '@waypoint/desktop',
    path: 'apps/desktop',
    dependencies: ['@waypoint/core'],
    typecheck: true,
  },
  { name: '@waypoint/core', path: 'packages/core/example', dependencies: [], typecheck: true },
  { name: '@waypoint/other', path: 'packages/core/other', dependencies: [], typecheck: true },
];

test('affected type selection includes reverse dependents and desktop coverage', () => {
  const select = requireFunction(preflight, 'selectPreflightWork');
  const result = select(['packages/core/example/src/index.ts'], projects);
  assert.deepEqual([...result.typecheckProjects].sort(), ['@waypoint/core', '@waypoint/desktop']);
  assert.equal(result.desktopRequired, true);
});

test('unknown or global input changes conservatively select all type projects and desktop', () => {
  const select = requireFunction(preflight, 'selectPreflightWork');
  for (const path of ['pnpm-lock.yaml', 'unexpected/new-build-input']) {
    const result = select([path], projects);
    assert.deepEqual([...result.typecheckProjects].sort(), projects.map((p) => p.name).sort());
    assert.equal(result.desktopRequired, true);
  }
});

test('documentation and Python-only changes explicitly omit unrelated desktop checks', () => {
  const select = requireFunction(preflight, 'selectPreflightWork');
  for (const path of ['docs/example.md', 'apps/api/example.py']) {
    const result = select([path], projects);
    assert.equal(result.desktopRequired, false);
    assert.deepEqual(result.typecheckProjects, []);
  }
  assert.throws(() => select([], projects));
});

function preflightReports() {
  const identity = {
    sourceSha: source,
    sourceTree: tree,
    baseSha: base,
    controlSha: base,
    controlRef: 'humic-labs/dnaforge-app/.github/workflows/pr-preflight.yml@refs/heads/dev',
    runId: '10',
    attempt: 2,
  };
  const file = 'apps/desktop/src/example.test.ts';
  const manifest = {
    ...identity,
    desktopShards: ['1/1'],
    preflight: {
      draft: false,
      desktopRequired: true,
      typecheckProjects: ['@waypoint/desktop'],
    },
  };
  const needs = Object.fromEntries(
    ['plan', 'syntax', 'typecheck', 'desktop-discovery', 'desktop-tests', 'controls'].map(
      (name) => [name, { result: 'success' }]
    )
  );
  const reports = [
    { ...identity, kind: 'inventory', files: [file] },
    { ...identity, kind: 'syntax', status: 'passed', files: ['apps/desktop/src/example.ts'] },
    { ...identity, kind: 'typecheck', status: 'passed', projects: ['@waypoint/desktop'] },
    {
      ...identity,
      kind: 'desktop',
      shard: '1/1',
      shards: 1,
      expectedFiles: [file],
      result: {
        success: true,
        numFailedTests: 0,
        numFailedTestSuites: 0,
        numPassedTests: 1,
        numPendingTests: 0,
        numTodoTests: 0,
        numTotalTests: 1,
        testResults: [
          {
            name: file,
            status: 'passed',
            assertionResults: [{ status: 'passed', fullName: 'works' }],
          },
        ],
      },
    },
  ];
  return { manifest, needs, reports, expectedFiles: [file], skipBudget: {} };
}

test('preflight accepts complete actual reports for every selected boundary', () => {
  const result = requireFunction(preflight, 'assessPreflight')(preflightReports());
  assert.equal(result.status, 'passed');
  assert.equal(result.desktop.passed, 1);
});
for (const [name, mutate] of [
  [
    'missing desktop report',
    (f) => {
      f.reports = f.reports.filter((r) => r.kind !== 'desktop');
    },
  ],
  [
    'empty inventory',
    (f) => {
      f.reports.find((r) => r.kind === 'inventory').files = [];
      f.expectedFiles = [];
    },
  ],
  [
    'empty passed tests',
    (f) => {
      f.reports.find((r) => r.kind === 'desktop').result.numPassedTests = 0;
    },
  ],
  [
    'missing selected typecheck',
    (f) => {
      f.reports.find((r) => r.kind === 'typecheck').projects = [];
    },
  ],
  [
    'stale report source',
    (f) => {
      f.reports[0].sourceSha = head;
    },
  ],
  [
    'skipped required job',
    (f) => {
      f.needs['desktop-tests'].result = 'skipped';
    },
  ],
]) {
  test(`preflight refuses ${name}`, () => {
    const assessPreflight = requireFunction(preflight, 'assessPreflight');
    const f = preflightReports();
    mutate(f);
    assert.throws(() => assessPreflight(f));
  });
}

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  fetchQueuedHead,
  queueContributionCommits,
  readContributionQueue,
} from './check-queue-cla.mjs';
import { unsignedCommits } from './check-cla-sign-off.mjs';

test('queue sign-off checks contribution merges but excludes only synthetic queue commits', () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'queue-cla-'));
  const git = (...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init', '-b', 'main');
    git('config', 'user.name', 'Fixture Contributor');
    git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'core.hooksPath', path.join(cwd, 'empty-hooks'));
    git('commit', '--allow-empty', '-s', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    git('switch', '-c', 'contribution');
    writeFileSync(path.join(cwd, 'file'), 'content');
    git('add', 'file');
    git('commit', '-s', '-m', 'signed change');
    const signed = git('rev-parse', 'HEAD');
    git('commit', '--allow-empty', '-m', 'unsigned change');
    const unsigned = git('rev-parse', 'HEAD');
    git('switch', 'main');
    git('merge', '--no-ff', 'contribution', '-m', 'synthetic queue merge');
    const head = git('rev-parse', 'HEAD');
    const commits = queueContributionCommits(base, head, { cwd });
    assert.deepEqual(new Set(commits.map(({ sha }) => sha)), new Set([signed, unsigned]));
    assert.deepEqual(
      unsignedCommits(commits).map(({ sha }) => sha),
      [unsigned]
    );
    assert.throws(() => queueContributionCommits(base, base, { cwd }));
    assert.throws(() => queueContributionCommits(base, signed, { cwd }));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

function fixture(t) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'queue-cla-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init', '-b', 'dev');
  git('config', 'user.name', 'Fixture Contributor');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', path.join(cwd, 'empty-hooks'));
  git('commit', '--allow-empty', '-s', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  const commit = (file, signed = true) => {
    writeFileSync(path.join(cwd, file), file);
    git('add', file);
    git('commit', ...(signed ? ['-s'] : []), '-m', file);
    return git('rev-parse', 'HEAD');
  };
  const entry = (head, previous, prHead, number = 1) => ({
    id: `entry-${number}`,
    baseCommit: { oid: previous },
    headCommit: { oid: head },
    pullRequest: {
      number,
      state: 'OPEN',
      headRefOid: prHead,
      baseRefOid: base,
      baseRefName: 'dev',
    },
  });
  const squash = (previous, prHead) => {
    git('switch', '--detach', previous);
    git('merge', '--squash', prHead);
    git('commit', '-m', 'generated candidate');
    return git('rev-parse', 'HEAD');
  };
  return { cwd, git, base, commit, entry, squash };
}

test('a queued contribution keeps its original PR base when the target advances', (t) => {
  const f = fixture(t);
  f.git('switch', '-c', 'feature');
  const prHead = f.commit('contributor change');
  f.git('switch', 'dev');
  const advancedBase = f.commit('unrelated accepted change');
  const squash = f.squash(advancedBase, prHead);
  const entry = f.entry(squash, advancedBase, prHead);
  entry.pullRequest.baseRefOid = f.base;
  assert.deepEqual(
    queueContributionCommits(advancedBase, squash, { cwd: f.cwd, entries: [entry] }).map(
      ({ sha }) => sha
    ),
    [prHead]
  );
});

test('squash discovery checks every original commit, including unsigned contribution merges', (t) => {
  const f = fixture(t);
  f.git('switch', '-c', 'feature');
  const signed = f.commit('feature');
  f.git('switch', '-c', 'side', f.base);
  const side = f.commit('side');
  f.git('switch', 'feature');
  f.git('merge', '--no-ff', 'side', '-m', 'unsigned contribution merge');
  const prHead = f.git('rev-parse', 'HEAD');
  const head = f.squash(f.base, prHead);
  const entries = [f.entry(head, f.base, prHead)];
  const commits = queueContributionCommits(f.base, head, { cwd: f.cwd, entries });
  assert.deepEqual(new Set(commits.map(({ sha }) => sha)), new Set([signed, side, prHead]));
  assert.deepEqual(
    unsignedCommits(commits).map(({ sha }) => sha),
    [prHead]
  );
});

test('a multi-PR squash group checks both exact original heads', (t) => {
  const f = fixture(t);
  f.git('switch', '-c', 'first');
  const first = f.commit('first');
  f.git('switch', '-c', 'second', f.base);
  const second = f.commit('second', false);
  const step = f.squash(f.base, first);
  const head = f.squash(step, second);
  const entries = [f.entry(head, step, second, 2), f.entry(step, f.base, first)];
  const commits = queueContributionCommits(f.base, head, { cwd: f.cwd, entries });
  assert.deepEqual(new Set(commits.map(({ sha }) => sha)), new Set([first, second]));
  assert.deepEqual(
    unsignedCommits(commits).map(({ sha }) => sha),
    [second]
  );
});

test('squash discovery refuses absent, ambiguous, stale or altered queue contributions', async (t) => {
  const f = fixture(t);
  f.git('switch', '-c', 'feature');
  const prHead = f.commit('feature');
  const head = f.squash(f.base, prHead);
  const entry = f.entry(head, f.base, prHead);
  for (const [name, change, error] of [
    ['absent', () => [], /no unique live queue entry/u],
    ['duplicate', () => [entry, entry], /no unique live queue entry/u],
    [
      'missing identity',
      (e) => {
        delete e.id;
      },
      /identity is missing/u,
    ],
    [
      'stale queue base',
      (e) => {
        e.baseCommit.oid = prHead;
      },
      /entry base is stale/u,
    ],
    [
      'stale queue head',
      (e) => {
        e.headCommit.oid = prHead;
      },
      /no unique live queue entry/u,
    ],
    [
      'closed PR',
      (e) => {
        e.pullRequest.state = 'CLOSED';
      },
      /not open/u,
    ],
    [
      'different target',
      (e) => {
        e.pullRequest.baseRefName = 'staging';
      },
      /does not target dev/u,
    ],
    [
      'stale PR base',
      (e) => {
        e.pullRequest.baseRefOid = prHead;
      },
      /request base is stale/u,
    ],
    [
      'missing PR head',
      (e) => {
        e.pullRequest.headRefOid = null;
      },
      /head is missing/u,
    ],
    [
      'wrong PR head',
      (e) => {
        e.pullRequest.headRefOid = f.base;
      },
      /tree differs/u,
    ],
    [
      'invalid PR number',
      (e) => {
        e.pullRequest.number = '../other';
      },
      /Invalid queued/u,
    ],
  ]) {
    await t.test(name, () => {
      const changed = structuredClone(entry);
      const entries = change(changed) ?? [changed];
      assert.throws(() => queueContributionCommits(f.base, head, { cwd: f.cwd, entries }), error);
    });
  }
  f.git('switch', '--detach', head);
  const altered = f.commit('unexpected-tree');
  const tree = f.git('rev-parse', `${altered}^{tree}`);
  const wrong = f.git('commit-tree', tree, '-p', f.base, '-m', 'generated candidate');
  assert.throws(
    () =>
      queueContributionCommits(f.base, wrong, {
        cwd: f.cwd,
        entries: [f.entry(wrong, f.base, prHead)],
      }),
    /tree differs/u
  );
});

test('bound two-parent candidates retain original commits and reject a different PR head', (t) => {
  const f = fixture(t);
  f.git('switch', '-c', 'feature');
  const prHead = f.commit('feature');
  f.git('switch', 'dev');
  f.git('merge', '--no-ff', 'feature', '-m', 'generated merge');
  const head = f.git('rev-parse', 'HEAD');
  const entry = f.entry(head, f.base, prHead);
  assert.deepEqual(
    queueContributionCommits(f.base, head, { cwd: f.cwd, entries: [entry] }).map(({ sha }) => sha),
    [prHead]
  );
  entry.pullRequest.headRefOid = head;
  assert.throws(
    () => queueContributionCommits(f.base, head, { cwd: f.cwd, entries: [entry] }),
    /does not contain the queued head/u
  );
});

test('a fresh candidate checkout fetches the fork PR ref and rejects a moved original head', (t) => {
  const f = fixture(t);
  f.git('switch', '-c', 'fork-contribution');
  const prHead = f.commit('fork-change');
  f.git('update-ref', 'refs/pull/1/head', prHead);
  const head = f.squash(f.base, prHead);
  f.git('update-ref', 'refs/heads/dev', head);
  const clone = path.join(f.cwd, 'fresh');
  f.git('clone', '--no-local', '--single-branch', '--branch', 'dev', f.cwd, clone);
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: clone,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  assert.throws(() => git('cat-file', '-e', prHead));
  const entry = f.entry(head, f.base, prHead);
  const commits = queueContributionCommits(f.base, head, {
    cwd: clone,
    entries: [entry],
    fetchHead: (pr) => fetchQueuedHead(pr, { cwd: clone }),
  });
  assert.deepEqual(
    commits.map(({ sha }) => sha),
    [prHead]
  );
  assert.equal(git('rev-parse', 'FETCH_HEAD'), prHead);
  f.git('update-ref', 'refs/pull/1/head', f.base);
  assert.throws(
    () => fetchQueuedHead(entry.pullRequest, { cwd: clone }),
    /head changed while fetching/u
  );
  f.git('update-ref', '-d', 'refs/pull/1/head');
  assert.throws(() => fetchQueuedHead(entry.pullRequest, { cwd: clone }));
});

const event = {
  repository: { id: 123, full_name: 'example/project' },
  merge_group: { base_ref: 'refs/heads/dev', base_sha: 'a'.repeat(40), head_sha: 'b'.repeat(40) },
};
function response(nodes, hasNextPage = false, endCursor = null) {
  return {
    data: {
      repository: {
        databaseId: 123,
        nameWithOwner: 'example/project',
        mergeQueue: { entries: { nodes, pageInfo: { hasNextPage, endCursor } } },
      },
    },
  };
}

test('development discovery reads all authenticated queue pages for the exact event repository', async () => {
  const calls = [];
  const entries = await readContributionQueue(
    event,
    event.merge_group.base_sha,
    event.merge_group.head_sha,
    async (body) => {
      calls.push(body);
      return body.variables.after === null
        ? response([{ id: 'first' }], true, 'next')
        : response([{ id: 'second' }]);
    }
  );
  assert.deepEqual(entries, [{ id: 'first' }, { id: 'second' }]);
  assert.deepEqual(
    calls.map(({ variables }) => variables),
    [
      { owner: 'example', name: 'project', branch: 'dev', after: null },
      { owner: 'example', name: 'project', branch: 'dev', after: 'next' },
    ]
  );
  assert.match(calls[0].query, /baseCommit\{oid\} headCommit\{oid\}/u);
  assert.match(calls[0].query, /pullRequest\{number state headRefOid baseRefOid baseRefName\}/u);
});

test('main queue entries bind the original pull request to main', async (t) => {
  const f = fixture(t);
  f.git('switch', '-c', 'feature');
  const topic = f.commit('signed');
  const squash = f.squash(f.base, topic);
  const entry = f.entry(squash, f.base, topic);
  entry.pullRequest.baseRefName = 'main';
  const group = {
    ...event,
    merge_group: { base_ref: 'refs/heads/main', base_sha: f.base, head_sha: squash },
  };
  const entries = await readContributionQueue(
    group,
    f.base,
    squash,
    async ({ query, variables }) => {
      assert.equal(variables.branch, 'main');
      assert.match(query, /mergeQueue\(branch:\$branch\)/u);
      return response([entry]);
    }
  );
  const options = { cwd: f.cwd, entries, branch: 'main' };
  assert.deepEqual(
    queueContributionCommits(f.base, squash, options).map((c) => c.sha),
    [topic]
  );
  entry.pullRequest.baseRefName = 'dev';
  assert.throws(() => queueContributionCommits(f.base, squash, options), /does not target main/u);
});

test('development discovery fails closed on API errors, wrong repositories and incomplete pagination', async (t) => {
  for (const [name, value] of [
    ['API error', { errors: [{ message: 'denied' }] }],
    [
      'missing queue',
      { data: { repository: { databaseId: 123, nameWithOwner: 'example/project' } } },
    ],
    [
      'wrong repository',
      { data: { repository: { databaseId: 999, nameWithOwner: 'example/project' } } },
    ],
    [
      'wrong repository name',
      { data: { repository: { databaseId: 123, nameWithOwner: 'other/project' } } },
    ],
    ['missing cursor', response([], true)],
    ['repeated cursor', response([], true, 'again')],
  ]) {
    await t.test(name, () =>
      assert.rejects(
        readContributionQueue(
          event,
          event.merge_group.base_sha,
          event.merge_group.head_sha,
          async () => value
        )
      )
    );
  }
  for (const change of [
    (e) => {
      e.merge_group.base_ref = 'refs/heads/staging';
    },
    (e) => {
      e.merge_group.base_sha = 'c'.repeat(40);
    },
    (e) => {
      e.merge_group.head_sha = 'c'.repeat(40);
    },
  ]) {
    const changed = structuredClone(event);
    change(changed);
    await assert.rejects(
      readContributionQueue(changed, event.merge_group.base_sha, event.merge_group.head_sha, () =>
        assert.fail('Must reject before network')
      )
    );
  }
});

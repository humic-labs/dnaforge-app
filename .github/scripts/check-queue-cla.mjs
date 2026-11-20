import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readCommits, unsignedCommits } from './check-cla-sign-off.mjs';

const SHA = /^[a-f0-9]{40}$/u;
const contributionQueues = new Map([
  ['refs/heads/dev', 'dev'],
  ['refs/heads/main', 'main'],
]);

export function queueContributionCommits(
  base,
  head,
  { cwd, entries, fetchHead, branch = 'dev' } = {}
) {
  assert.ok(SHA.test(base) && SHA.test(head), 'Queue requires exact base and head commits');
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('merge-base', '--is-ancestor', base, head);
  const synthetic = git('rev-list', '--first-parent', `${base}..${head}`)
    .split('\n')
    .filter(Boolean);
  assert.ok(synthetic.length > 0, 'Empty queue candidate');
  const commits = new Map();
  let previous = base;
  for (const sha of synthetic.reverse()) {
    const parents = git('show', '-s', '--format=%P', sha).split(' ');
    assert.equal(parents[0], previous, 'Queue candidate has an unexpected first parent');
    let contributions = parents.slice(1);
    if (entries !== undefined) {
      const matches = entries.filter((entry) => entry?.headCommit?.oid === sha);
      assert.equal(matches.length, 1, 'Queue candidate has no unique live queue entry');
      const entry = matches[0];
      const pr = entry.pullRequest;
      assert.ok(entry.id, 'Queue entry identity is missing');
      assert.equal(entry.baseCommit?.oid, previous, 'Queue entry base is stale');
      assert.equal(pr?.state, 'OPEN', 'Queued pull request is not open');
      assert.equal(pr.baseRefName, branch, 'Queued pull request does not target ' + branch);
      assert.ok(SHA.test(pr.baseRefOid), 'Queued pull request base is missing');
      assert.equal(
        git('merge-base', pr.baseRefOid, base),
        pr.baseRefOid,
        'Pull request base is stale'
      );
      assert.ok(Number.isSafeInteger(pr.number) && pr.number > 0, 'Invalid queued pull request');
      assert.ok(SHA.test(pr.headRefOid), 'Queued pull request head is missing');
      assert.ok(parents.length === 1 || parents.length === 2, 'Unexpected queue parent count');
      if (parents.length === 2) {
        assert.equal(parents[1], pr.headRefOid, 'Queue merge does not contain the queued head');
      }
      fetchHead?.(pr);
      const tree = git('merge-tree', '--write-tree', previous, pr.headRefOid);
      assert.equal(
        tree,
        git('rev-parse', `${sha}^{tree}`),
        'Queue tree differs from the queued contribution'
      );
      contributions = [pr.headRefOid];
    } else {
      assert.ok(parents.length >= 2, 'Queue candidate is not a synthesized merge');
    }
    for (const parent of contributions) {
      for (const commit of readCommits(base, parent, { cwd })) commits.set(commit.sha, commit);
    }
    previous = sha;
  }
  assert.ok(commits.size > 0, 'Queue has no contribution commits');
  return [...commits.values()];
}

export async function readContributionQueue(event, base, head, graphql) {
  const branch = contributionQueues.get(event.merge_group?.base_ref);
  assert.ok(branch, 'Unknown contribution queue');
  assert.equal(event.merge_group.base_sha, base, 'Queue event base differs');
  assert.equal(event.merge_group.head_sha, head, 'Queue event head differs');
  const repository = event.repository;
  assert.ok(Number.isSafeInteger(repository?.id), 'Queue repository identity is missing');
  assert.match(repository.full_name, /^[\w.-]+\/[\w.-]+$/u, 'Invalid queue repository');
  const [owner, name] = repository.full_name.split('/');
  const entries = [];
  const cursors = new Set();
  let after = null;
  do {
    const result = await graphql({
      query: `query($owner:String!,$name:String!,$branch:String!,$after:String){
        repository(owner:$owner,name:$name){databaseId nameWithOwner
          mergeQueue(branch:$branch){entries(first:100,after:$after){
            nodes{id baseCommit{oid} headCommit{oid}
              pullRequest{number state headRefOid baseRefOid baseRefName}}
            pageInfo{hasNextPage endCursor}
          }}
        }
      }`,
      variables: { owner, name, branch, after },
    });
    assert.ok(!result.errors?.length, 'GitHub queue lookup failed');
    const found = result.data?.repository;
    assert.equal(found?.databaseId, repository.id, 'Queue repository differs');
    assert.equal(found?.nameWithOwner, repository.full_name, 'Queue repository name differs');
    const page = found.mergeQueue?.entries;
    assert.ok(
      Array.isArray(page?.nodes) && typeof page.pageInfo?.hasNextPage === 'boolean',
      'GitHub queue entries are unavailable'
    );
    entries.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) break;
    after = page.pageInfo.endCursor;
    assert.ok(after && !cursors.has(after) && cursors.size < 20, 'Queue pagination did not finish');
    cursors.add(after);
  } while (true);
  return entries;
}

export function fetchQueuedHead(pr, { cwd } = {}) {
  execFileSync('git', ['fetch', '--no-tags', 'origin', `refs/pull/${pr.number}/head`], {
    cwd,
    stdio: 'pipe',
  });
  const fetched = execFileSync('git', ['rev-parse', 'FETCH_HEAD'], {
    cwd,
    encoding: 'utf8',
  }).trim();
  assert.equal(fetched, pr.headRefOid, 'Queued pull request head changed while fetching');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [base, head] = process.argv.slice(2);
  const event = process.env.GITHUB_EVENT_PATH
    ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
    : {};
  let entries;
  const branch = contributionQueues.get(event.merge_group?.base_ref);
  if (branch) {
    entries = await readContributionQueue(event, base, head, async (body) => {
      assert.ok(process.env.GH_TOKEN, 'Queue lookup requires a GitHub token');
      const response = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${process.env.GH_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      assert.ok(response.ok, `GitHub queue lookup returned ${response.status}`);
      return response.json();
    });
  }
  const missing = unsignedCommits(
    queueContributionCommits(base, head, {
      entries,
      branch,
      fetchHead: fetchQueuedHead,
    })
  );
  assert.equal(
    missing.length,
    0,
    `Unsigned contribution commits: ${missing.map(({ sha }) => sha).join(', ')}`
  );
  console.log('Every queued contribution commit agrees to the CLA.');
}

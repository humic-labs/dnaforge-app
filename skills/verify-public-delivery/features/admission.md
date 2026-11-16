# Public development delivery

## Sub-features

- Inspect a candidate without changing GitHub state.
- Preserve explicit holds and refuse stale heads or incomplete results.
- Require the public repository, development queue, PR rule and current checks.
- Prepare rules without activating them.
- Ready a completed draft, admit its exact head once and verify the actual merge.

## How to get to it (user POV)

Open a public pull request against `dev`. Keep incomplete work as a draft. Use
`inspect` for a read-only decision. Use `--deliver` when the assigned change is
complete and delivery is intended. Ordinary development assignments include
that route. Explicit no-merge or draft-only instructions still apply. No private
ticket or private repository access is needed.

## Driving it with the CLI

1. Read the PR with `gh pr view NUMBER --repo humic-labs/dnaforge-app --json
   number,state,isDraft,headRefOid,baseRefName,autoMergeRequest`. Read queue
   membership with the GraphQL command below; `gh pr view` does not expose it.
2. Run `inspect --pr NUMBER --out /absolute/evidence/before.json`. Compare the
   exact candidate with GitHub and read every refusal reason.
3. Read the same PR fields again. Inspection must preserve draft, head,
   auto-merge and queue state. A draft or held PR must not qualify for admission.
4. Run `prepare` with an intentionally incorrect `--expected-head` and preserve
   the refusal. Use the existing PR; do not push an artificial failure.
5. Run `propose-rules` and verify zero required approvals and no bypass actors.
   Re-read live rules and confirm this command changed nothing. Development and
   promotion targets must have their own declared checks and merge methods.
6. After activation, inspect a real development task PR and compare its exact
   preflight run, attempt, workflow, check publisher and source with GitHub.
   Broad promotion artifacts are not prerequisites for development admission.
7. Once the complete task is ready to land, run `--deliver --pr NUMBER --out
   /absolute/evidence/delivery.json` from its clean exact checkout. For a draft,
   observe the ready transition and a new ready preflight run before admission.
   Observe one exact-head queue entry and the actual merge on `dev`.
8. Read the merged commit's broad CI. A newer merged commit must not cancel it.
   Retain its original failures and repair any regression owned by this task.

```sh
gh api graphql -F number=NUMBER -f 'query=query($number:Int!){repository(owner:"humic-labs",name:"dnaforge-app"){pullRequest(number:$number){number headRefOid merged mergeCommit{oid} mergeQueueEntry{id state}}}}'
```

## Gotchas

Draft preflight checks syntax only. A green draft result cannot substitute for
the newly triggered ready run. `--deliver` expresses intent to ready and deliver
the completed change; it cannot infer whether the assignment was draft-only.
Honor that instruction and use `inspect` instead.

An explicit hold label refuses delivery even when checks pass. A timeout or
removed queue entry is not permission to re-enqueue automatically. Read the
current state and fix the cause before resuming. The CLI never jumps the queue.

The candidate's check name, publisher, run and attempt all matter. The control
code comes from the protected base. The external full Electron matrix belongs
to promotion qualification; the public native journeys cannot replace it.

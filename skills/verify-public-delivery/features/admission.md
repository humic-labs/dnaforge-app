# Public merge admission

## Sub-features

- Inspect a candidate without changing GitHub state.
- Refuse a draft or explicit hold, stale expected head or incomplete result.
- Require the actual public repository, queue, PR rule and trusted workflow.
- Prepare rules without activating them.
- Admit an explicitly authorized, fully qualified exact head once.

## How to get to it (user POV)

Open a public pull request against `main`. Keep incomplete or held work as a
draft. Use the delivery CLI from its owned public checkout. No private ticket
or private repository access is needed.

## Driving it with the CLI

1. Read the PR with `gh pr view NUMBER --repo humic-labs/dnaforge-app --json
   number,state,isDraft,headRefOid,baseRefName,autoMergeRequest`. Read queue
   membership with the GraphQL command below; `gh pr view` does not expose it.
2. Run `inspect --pr NUMBER --out /absolute/evidence/before.json`. Compare the
   exact candidate with GitHub and read every refusal reason.
3. Read the same PR fields again. An inspection must preserve draft, head,
   auto-merge and queue state. A held PR must be rejected even if tests pass.
4. Run `prepare` with an intentionally incorrect `--expected-head` and preserve
   the refusal. Use the existing PR; do not push an artificial failure to main.
5. Run `propose-rules` and verify the output has zero required approvals and no
   bypass actors. Re-read live rules and confirm this command changed nothing.
6. After authorized activation, inspect a genuinely qualified task PR and
   compare the exact run, attempt, workflow, check publisher and source with
   GitHub. Missing, skipped or cancelled required results cannot qualify it.
7. Only within actual merge authority, run `enqueue` with the observed head.
   Read its queue entry, actual eventual merge and post-merge result. A second
   merged commit must not cancel the first commit's post-merge run.

```sh
gh api graphql -F number=NUMBER -f 'query=query($number:Int!){repository(owner:"humic-labs",name:"dnaforge-app"){pullRequest(number:$number){number mergeQueueEntry{id}}}}'
```

## Gotchas

GitHub Actions publisher identity alone does not bind a check to a particular
workflow. The required-workflow rule and run provenance are separate evidence.
Creating that organization rule needs organization authority. A missing rule
is a refusal, even when the repository's ordinary required contexts pass.

`gh pr merge` can arm auto-merge while checks are pending. The delivery CLI uses
the exact-head queue mutation instead. Draft holds, unknown evidence and stale
heads are not instructions to retry with weaker checks.

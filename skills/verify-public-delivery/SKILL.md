---
name: verify-public-delivery
description:
  Verify public DNAForge development delivery and source promotion through the
  real CLI and GitHub records, preserving holds, exact source and retained CI
  evidence.
---

# Verify public delivery

## Launch

Use a checkout of `humic-labs/dnaforge-app` and Node from `.nvmrc`. The CLI is
`node scripts/ci/deliver.mjs`; it starts no server and needs no dependency
install. GitHub inspection uses authenticated `gh api` calls. Read
[the feature map](features/README.md) and the affected feature before driving
it. [The delivery policy](../../docs/ci/merge-policy.md) owns branch roles and
authority; this skill does not introduce additional gates.

## Doctor

Record `git rev-parse --show-toplevel`, `git branch --show-current`,
`git rev-parse HEAD` and `git status --porcelain`. Confirm the intended
checkout. Run
`gh api repos/humic-labs/dnaforge-app --jq '{id,full_name,default_branch}'`. The
repository ID must match `.ci/merge-policy.json`. Read the live rules for the
candidate's target and identify whether migration has activated that branch. Do
not print credentials.

## Drive

Run
`node scripts/ci/deliver.mjs inspect --pr NUMBER --out /absolute/evidence/inspect.json`
against the actual task PR. `inspect` and `prepare` only read GitHub. They do
not mark a draft ready, enqueue a PR or alter rules. Exit 0 means qualified, 1
means rejected, and 2 means pending or unavailable evidence.

Run
`node scripts/ci/deliver.mjs propose-rules --out /absolute/evidence/rules.json`
to produce reviewable configuration. This command does not activate it. Compare
it with the actual target rules before claiming live enforcement.

Run `node --test scripts/ci/merge-policy.test.mjs scripts/ci/deliver.test.mjs`
for bounded negative controls. These supplement actual GitHub inspection.

To deliver a completed development pull request, run
`node scripts/ci/deliver.mjs --deliver --pr NUMBER --out /absolute/evidence/delivery.json`.
The clean local head must match the PR. The command readies the draft, waits for
fresh preflight, queues once and verifies the merged commit on `dev`. Preserve
an explicit hold. Do not use delivery as a harmless probe; `inspect` is the
read-only command. A watcher exit leaves ownership with the task owner. Read
GitHub before resuming; never blindly re-enqueue or jump the queue.

Use the [promotion feature](features/promotion.md) for an assigned `staging` or
`prod` promotion. A source promotion does not publish a production release.

## Evidence

Preserve the original command, exit status and JSON receipt outside the
worktree. Receipts include the candidate, live rules, check/run identities and
reasons for refusal. Record before and after PR state when testing read-only
commands. Record actual merged commit, target ancestry and post-merge CI for
delivery. Do not claim server enforcement from a local fixture result.

## Cleanup

The CLI creates no persistent process or application state. Preserve receipts
after temporary worktrees are removed. Do not remove a PR, queue entry or rule
unless the task explicitly owns that change.

## Helpers

`scripts/ci/deliver.mjs` owns live inspection, rules proposals and delivery.
`scripts/ci/merge-policy.mjs` owns policy loading and decisions. Required work
comes from `.ci/merge-policy.json`; this skill does not define a second policy.
Use the maintenance skill when the commands or feature map drift.

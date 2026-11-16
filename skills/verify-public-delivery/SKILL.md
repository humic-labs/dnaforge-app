---
name: verify-public-delivery
description:
  Verify public DNAForge merge admission through its real delivery CLI and
  GitHub records, including draft holds, exact source, required workflows and
  retained CI evidence.
---

# Verify public delivery

## Launch

Use a checkout of `humic-labs/dnaforge-app` and Node from `.nvmrc`. The CLI is
`node scripts/ci/deliver.mjs`; it starts no server and needs no dependency
install. GitHub inspection uses authenticated `gh api` calls. Read
[the feature map](features/README.md) and the affected feature before driving
it.

## Doctor

Record `git rev-parse --show-toplevel`, `git branch --show-current`,
`git rev-parse HEAD` and `git status --porcelain`. Confirm the intended
checkout. Run
`gh api repos/humic-labs/dnaforge-app --jq '{id,full_name,default_branch}'`. The
repository ID must match `.ci/merge-policy.json`. Do not print credentials.

## Drive

Run
`node scripts/ci/deliver.mjs inspect --pr NUMBER --out /absolute/evidence/inspect.json`
against the actual task PR. `inspect` and `prepare` only read GitHub. They do
not mark a draft ready, enable auto-merge, enqueue a PR or alter rules. Exit 0
means qualified, 1 means rejected, and 2 means pending or unavailable evidence.

Run
`node scripts/ci/deliver.mjs propose-rules --out /absolute/evidence/rules.json`
to produce reviewable configuration. This command does not activate it. A
configuration file is not evidence of live enforcement.

Run `node --test scripts/ci/merge-policy.test.mjs scripts/ci/deliver.test.mjs`
for the bounded negative controls. These supplement actual GitHub inspection.

Only an explicitly authorized, complete change may use `enqueue`, with both
`--expected-head SHA` and `--authorize-merge`. Never use it as a harmless probe.
The CLI requests queue admission once and reads the result; admission is not a
merge. Observe the actual merge, its tree and its post-merge CI separately.

## Evidence

Preserve the original command, exit status and JSON receipt outside the
worktree. Receipts include the candidate, live rules, check/run identities and
reasons for refusal. Record before and after PR state when testing read-only
commands. Do not claim server enforcement from a local fixture result.

## Cleanup

The CLI creates no persistent process or application state. Preserve receipts
after temporary worktrees are removed. Do not remove a PR, queue entry or rule
unless the task explicitly owns that change.

## Helpers

`scripts/ci/deliver.mjs` owns live inspection, rules proposals and admission.
`scripts/ci/merge-policy.mjs` owns policy loading and decisions. Required suite
selection comes from `.ci/merge-policy.json`; this skill does not define a
second policy. Use the maintenance skill when the commands or feature map drift.

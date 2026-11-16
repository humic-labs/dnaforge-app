# Retained integration results

## Sub-features

- Each integration push retains its own broad CI run.
- Failures identify the actual branch, commit, run and attempt.
- A later push cannot erase the earlier failure or its ownership.

## How to get to it (user POV)

Open the CI runs for the affected public `dev`, `staging` or `prod` branch.
Inspect the exact source and the `Promotion qualification` result. The
temporary `main` bootstrap path is separate from normal development delivery.

## Driving it with GitHub and the reporter

Read two consecutive actual push runs. Require distinct run IDs, the correct
branch and source commit for each, and a terminal result retained for both.
A later push must not cancel its predecessor. Preserve the original job logs.

For a failed run, inspect the failure issue produced by
`scripts/ci/report-main-result.mjs --publish` in that run. The title and body
must name the actual branch and source. Associated PRs identify owners, not
proof that every failure was caused by that PR. Local execution without the
real CI event and run identities cannot qualify this behavior.

Run `node --test scripts/ci/report-main-result.test.mjs scripts/ci/retained-branch-results.test.mjs`
for bounded identity and refusal controls. These supplement the actual push
observations; they do not establish CI retention by themselves.

## Gotchas

Retain failed attempts. A successful retry does not erase a failure or prove
that its cause was fixed. Do not post a synthetic failure issue as live proof
or cancel another task's run. These commands create no persistent processes.

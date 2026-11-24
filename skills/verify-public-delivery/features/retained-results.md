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

For a failed push, open the integration job summary. Check its branch, commit,
link to the exact run attempt, failed jobs and associated PR numbers. Use the
linked PRs to find the maintainers responsible for investigating the failure.

Run `node --test scripts/ci/report-main-result.test.mjs scripts/ci/retained-branch-results.test.mjs`
for bounded identity and refusal controls. These supplement the actual push
observations; they do not establish CI retention by themselves.

## Gotchas

Retain failed attempts and their original logs. Verify a repair on the source
that contains it.

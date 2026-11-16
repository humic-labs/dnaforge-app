# Source promotion

## Sub-features

- Ordinary task delivery targets `dev` and cannot promote or publish a release.
- Staging selects an exact development revision; production selects staging.
- Promotion preserves the destination history and verifies the combined tree.
- Broad qualification and full Electron evidence belong to the actual candidate.
- Source acceptance and public installer publication remain separate outcomes.

## How to get to it (user POV)

Read [the release policy](../../../docs/ci/releases.md) and the executable
branch policy. Use the public delivery CLI on the actual promotion PR. Inspect
the PR's source branch, target branch, immutable head and GitHub test-merge
commit before any mutation.

## Driving it with the delivery CLI and GitHub

Run `node scripts/ci/deliver.mjs inspect --pr NUMBER --out /absolute/evidence/promotion.json`.
Read the candidate, source tree, upstream relationship and every required
check. Missing or unavailable full Electron qualification is incomplete even
when the smaller public native-journey suite passes.

Use an owned draft PR to prove read-only refusal. Retain its before and after
head, base, draft state and merge state. Exercise stale-head and wrong-target
refusals through the independent branch-delivery controls; never enqueue or
merge an unqualified candidate to probe server behavior.

An authorized real promotion needs passing source-bound qualification and
the expected branch relationship before it can merge. After merging, read the
actual commit and tree from GitHub and compare them with the tested candidate.
Record the immutable source selected for release separately from the latest
development branch head.

## Gotchas

The check named `Electron E2E` must represent the full maintained Electron
matrix. Six focused desktop journeys do not replace that matrix. A test run
against private application source cannot qualify the public application.

Promotion does not authorize customer publication. Verify installer staging,
production approval, rollout and live update acceptance through the release
owner's existing workflow. Preserve explicit task holds and original failures.
Never change a tag, discard evidence or remove unrelated PRs during cleanup.

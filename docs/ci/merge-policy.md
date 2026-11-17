# Public delivery policy

`.ci/merge-policy.json` is the executable authority for public branch roles,
required checks, check publishers and delivery limits.
`scripts/ci/merge-policy.mjs` assesses that policy against GitHub. Contributor
and agent instructions point here instead of maintaining another list of checks.

```text
feature PR ── fast checks + merge queue ──> dev
                                           │ broad CI after each merge
                                           │ selected source + broad qualification
                                           ▼
                                        staging
                                           │ selected source + broad qualification
                                           ▼
                                          prod ──> Stable release process
```

## Development

Completed development changes land on `dev`. Finish the change and its focused
acceptance before requesting delivery. Keep incomplete work in draft and
preserve explicit holds even when checks pass. Maintainers use the same public
development commands as contributors; private trackers and release credentials
are not prerequisites.

Development admission requires the CLA and PR Preflight checks named in the
policy. Draft preflight checks changed-source syntax. Ready pull requests and
queue candidates also run affected type checks and affected desktop unit tests.
Unknown dependency impact selects conservatively. Empty, missing, cancelled or
unexpectedly skipped required results cannot pass. The development merge queue
combines changes and validates the combined candidate before landing it.

Broad desktop, package, Python, Rust and native-journey work runs after each
`dev` merge and on promotion candidates. Post-merge runs remain attached to
their own commits; newer pushes do not cancel them. The owner repairs a
regression or reverts its identified cause when it blocks other work. Broad CI
is promotion evidence, not an extra development admission gate.

## Promotion

A release owner selects an immutable upstream commit for `staging` or `prod`.
The policy declares each target's upstream. The selected source must belong to
that upstream. The pull request must preserve its ancestry and file tree, and
the qualified combined result must have exactly that tree. Promotion merges
preserve history; they do not use the development squash queue.

Promotion requires the checks named for that target, including the full
`Electron E2E` matrix published by the trusted producer. The public native
journeys supplement that matrix. A successful subset cannot stand in for the
full result. The actual check must belong to the exact candidate commit and
expected GitHub app. Missing, stale, failed, cancelled or skipped evidence
refuses promotion.

The Electron check includes a digest-bound receipt for the current PR head,
target base, tested merge commit and tree. It binds the complete test roster and
evidence without publishing the producer's operational records. A head check
from an earlier target base cannot qualify a new combined candidate.

The broad qualification artifact binds the repository, combined candidate commit
and tree, target base, protected control revision, workflow run and attempt,
worker roster and coverage. Original reports and failures remain attached to
that run. Before reports describe the base separately; a failing base does not
disqualify a passing fix. Setup failures do not demonstrate a product defect.

A merge into `prod` changes accepted source. It does not publish installers or
update feeds. The [release policy](releases.md) owns staged artifact
qualification and production rollout.

## Protection and control

Every active target requires a pull request, its policy checks bound to their
expected publisher, and force-push and deletion protection. No approving review,
code-owner approval, last-push approval or review receipt is required. Reviews
remain advisory. Development uses the declared ALLGREEN queue; promotion uses a
history-preserving merge with current target checks.

Check names alone are insufficient evidence. The CLI verifies the public
repository, exact head, current workflow run and attempt, check suite, job
result and publisher. Preflight uses the candidate's protected base revision for
its control code. Broad qualification pins protected `dev` control code
separately from the tested source and actual workflow revision. The final
verdict reads candidate reports as data. External Electron qualification is
assessed as its own actual check, without pretending it is a public CI job.

## Commands

```sh
node scripts/ci/deliver.mjs prepare --pr NUMBER --out /absolute/evidence/preparation.json
node scripts/ci/deliver.mjs propose-rules --out /absolute/evidence/proposed-rules.json
node scripts/ci/deliver.mjs --deliver --pr NUMBER --out /absolute/evidence/delivery.json
node scripts/ci/deliver.mjs promote --pr NUMBER --source FULL_UPSTREAM_SHA --out /absolute/evidence/promotion.json
```

`inspect` and `prepare` only read GitHub. `propose-rules` produces the
repository payloads without applying them. A configuration file does not prove
that rules are active.

`--deliver` requires the clean local checkout of the exact PR head. It readies a
completed draft, waits for the resulting ready preflight, requests exact-head
queue admission once, and observes the actual merge on `dev`. Existing hold
labels refuse delivery. There is no recurring authorization flag. It never jumps
the queue, changes its selected head or automatically re-enqueues a removed
entry. A bounded timeout leaves an existing queue entry unchanged. The owner
reads that state, resolves the failure and resumes deliberately.

`enqueue --pr NUMBER --expected-head FULL_SHA` performs admission only, for an
already-ready qualified development PR. It does not observe completion.
`promote` requires an explicitly selected source and verifies the actual merged
tree and target after GitHub confirms the history-preserving merge.

## Activation and maintenance

Create and validate branch workflows before switching the default branch or
activating their checks. Retain legacy `main` and its protections during the
migration. Existing `main` work follows the migration owner's existing route
until retargeted; `main` is not an alternate delivery bypass. Read back live
rules, default branch and workflow behavior before claiming activation.

Measure suite duration and flaky failures from real runs. Improve sharding and
setup reuse without deleting coverage or retrying until green. Policy changes
name the observed failure and the condition for removing a temporary mechanism.
Keep activation within the maintainer's established process-change cadence.

Use [verify-public-delivery](../../skills/verify-public-delivery/SKILL.md) for
the reproducible CLI and live GitHub acceptance path.

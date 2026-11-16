# Public merge qualification

`.ci/merge-policy.json` is the executable policy for public `main`.
`scripts/ci/merge-policy.mjs` selects required work and assesses live admission.
Contributor and agent instructions point here instead of maintaining another
check list. Private `dev` policy does not control public `main`.

## Before admission

Prepare the complete requested outcome on a task branch. Keep previews,
unfinished integration and explicit holds as draft PRs. An implementation
request, a green check or a completed subtask does not remove a stated hold. The
default delivery command only inspects. Queue admission requires explicit merge
authority for the complete feature and its exact current head.

The existing desktop, package and Python suites remain required. Rust helper
tests and source startup accompany them. Desktop tests run in the declared
number of shards without reducing the discovered inventory. Every code change
also runs the native journeys declared in the policy. Documentation-only paths
have an explicit selection result that omits native journeys; an unknown path
selects all of them. A failed, cancelled or unexpectedly skipped required job,
missing report, empty test selection or stale receipt cannot qualify a change.
Existing skipped test cases remain visible in the reports; they are not silently
counted as executed tests or removed from the inventory.

The final qualification binds the repository, tested commit and tree, base,
trusted control revision, workflow run and attempt, worker roster and coverage.
Tests run against the combined candidate, not a different convenient checkout.
Original failure logs and native evidence remain attached to that run. Before
reports describe the base separately; a failing base does not disqualify a
passing fix. A setup failure is not evidence that the product defect was
reproduced.

## Authority

The required configuration for main is a pull request and an ALLGREEN merge
queue. No approving review, code-owner approval or last-push approval is
required. Force pushes and branch deletion remain blocked. Required checks bind
to their expected publisher.

Publisher binding alone cannot stop a candidate from replacing its own workflow.
An organization ruleset must require the existing CI workflow from protected
public `main`. Its trusted final job evaluates required results independently of
the candidate's workflow edits. The job reads reports as data and does not
execute downloaded candidate code. Public contributions need no private source,
issue tracker, signing credential or hosted release infrastructure.

The CLI verifies the effective queue, PR rule, required contexts, publisher and
trusted workflow before it can request admission. The actual required-workflow
rule is a separate requirement from a file describing the desired rule.

## Commands

```sh
node scripts/ci/deliver.mjs prepare --pr NUMBER --out /absolute/evidence/preparation.json
node scripts/ci/deliver.mjs propose-rules --out /absolute/evidence/proposed-rules.json
```

Both commands preserve GitHub state. The proposal includes exact repository and
organization payloads but never applies them. Establish supported workflow
execution before enabling the rules. Retain existing protection throughout
activation and read back the effective rules. Missing organization capability is
an incomplete activation, not a reason to substitute context-name checks.

When the complete change is explicitly authorized and qualified:

```sh
node scripts/ci/deliver.mjs enqueue --pr NUMBER --expected-head FULL_SHA --authorize-merge --out /absolute/evidence/admission.json
```

The command requires a clean checkout of that head. It sends one exact-head
queue request. It never changes a draft to ready, enables auto-merge, bypasses
rules, jumps the queue or substitutes a newer head. A refusal returns to the
owner. Admission is not a verified merge.

## After merge and release

Each `main` commit retains its own CI run. Later pushes do not cancel earlier
post-merge runs. The owner reads the actual merged commit and tree and the
normal post-merge result. A regression remains owned until repaired, or until a
certain culprit that blocks other work is deliberately reverted.

Full platform, packaging, installation and update qualification remains a
release responsibility. Native journey acceptance is not exhaustive release
qualification. Stable releases bind the exact public source they build; private
control-code revisions remain separate.

Measure suite duration and flaky failures from real runs. Improve sharding and
setup reuse without deleting coverage or retrying until green. Policy changes
name the observed failure and the condition for removing a temporary mechanism.
Keep activation within the maintainer's established process-change cadence.

Use [verify-public-delivery](../../skills/verify-public-delivery/SKILL.md) for
the reproducible live CLI and GitHub acceptance path.

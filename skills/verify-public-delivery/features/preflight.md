# Development preflight

## Sub-features

- Development pull requests and queue candidates use `PR Preflight`.
- Drafts parse changed source. Ready candidates also check the changed
  workspaces and their dependents, and run desktop tests when desktop or shared
  inputs change.
- Unknown inputs select every typecheck project and the desktop suite. The first
  implementation conservatively retains every desktop shard for affected desktop
  changes; actual CI timing is required before calling this fast.
- A documentation or sidecar-only change records its explicit desktop exclusion.
  An empty inventory, absent selected report or stale source cannot pass.
- Selection and the verdict run from the exact protected development base.
  Candidate source, control revision and workflow revision remain distinct.

## How to get to it (user POV)

Open a draft pull request targeting the development branch declared in
`.ci/merge-policy.json`. Read its Development preflight run. Mark the complete
change ready and inspect the new run before admission to the merge queue.

## Driving it with Node and GitHub Actions

Run the focused delivery controls:

```sh
node --test scripts/ci/branch-delivery-contract.test.mjs
```

Then inspect the actual draft, ready and merge-group runs. Download each
`preflight-candidate` manifest, `preflight-report-*` original and final
`preflight-COMMIT` receipt. Record run ID, attempt, candidate commit/tree, base,
control and workflow revisions outside the checkout. Confirm the draft has no
typecheck or desktop execution, then confirm the ready run's selected typecheck
projects and complete desktop inventory match its results. The queue run must
describe its tested merge-group commit, not the earlier PR head.

Drive a failing syntax change and a missing selected report through the actual
workflow, retaining both failures before repair. Local fixture results establish
the rejection contract; they do not establish GitHub execution or enforcement.

For a focused parser investigation, use the actual manifest and exact candidate
checkout with pinned TypeScript 5.8.3 and yaml 2.8.4 installed under
`CI_PARSER_ROOT`:

```sh
node /absolute/control/scripts/ci/preflight.mjs syntax \
  --root /absolute/candidate --manifest /absolute/evidence/manifest.json \
  --out /absolute/evidence/syntax.json
```

## Gotchas

Development preflight is admission evidence. It is not broad qualification or
the external Electron E2E matrix. After integration, the existing broad CI runs
on every development commit; staging and production promotions use that same
broad suite and require the separate Electron E2E result.

Dependency installs and candidate tests have read-only repository permission and
no release credentials. External-fork workflow execution still requires the
existing maintainer permission. No local suite replay is needed for delivery.
Preserve all original run artifacts and remove only task-owned scratch files.

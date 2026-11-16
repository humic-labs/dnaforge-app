# Candidate qualification

## Sub-features

- The desktop verdict accounts for every independently discovered test file
  exactly once across the declared shards.
- Every report identifies the candidate commit and tree, trusted control
  revision, workflow run and attempt.
- Failed collection, missing reports, empty selections, missing shards and
  unexpected skips cannot produce a passing verdict.
- Existing unit-test skips have an explicit per-file allowance. They remain
  reported as skipped and do not count as native acceptance.
- Native qualification requires the complete selected journey roster. Missing,
  duplicate, failed, skipped, cancelled or stale journeys cannot qualify the
  candidate.

## How to get to it (user POV)

Open a staging or production promotion's CI run, or the retained run after a
development push. Inspect the desktop, native and `Promotion qualification` jobs
and download their original reports. Qualification belongs to the displayed
candidate and workflow attempt, not a previous green run or a local result.

## Driving it with Node and GitHub Actions

Run the focused report-boundary checks from the public checkout:

```sh
node --test scripts/ci/qualification.test.mjs
```

These checks supply small report fixtures to the production assessor. The
positive controls include all eight desktop shards and all six native journeys.
Negative controls alter one source identity, report, shard, file, outcome or
skip allowance at a time. Preserve the command, exit status and source commit
alongside its output.

Then run the real CI workflow on the complete candidate. Read its actual
candidate SHA, control SHA, workflow run and attempt. Confirm that the
independent desktop inventory equals the union of reported shard files, and that
the six native reports retain their original observations and media. Exercise a
missing-report or skipped-worker control through the same workflow and preserve
its failed verdict before restoring the control. Do not replace the actual run
with locally fabricated reports.

For a before-and-after comparison, keep each source identity and its original
reports separate. A failure in baseline setup does not reproduce a product
defect. A successful report parser does not prove that a workflow executed, a
user journey passed or a PR merged.

## Gotchas

The fixture checks deliberately do not prescribe summary formatting. They
require the assessor to reject invalid evidence and preserve its inputs.
Validity depends on the complete expected roster, not on whichever workers
happened to upload files.

An explicit existing skip allowance is scoped to one file. It cannot be
transferred to another file or used as a global skip budget. No skipped case
becomes a passed case.

These boundary checks are necessary but insufficient for trusted merge
enforcement. The control checkout is selected from protected development once
and pinned to that exact commit for every worker and verdict. Preserve its
identity separately from GitHub's workflow revision. Verify the live required
checks and actual queue behavior through the admission feature. The six native
journeys do not substitute for the separate full `Electron E2E` check required
for promotion.

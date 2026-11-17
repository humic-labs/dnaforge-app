# Observed scientific transfers with notebook context

## Sub-features

- Select an actual clean, settled saved notebook page in the inventory project.
- Preview an operator-reported completed manual transfer without changing stock.
- Record one stable physical work identity with exact source debit, permanent
  well aliquot and historical notebook source context in one inventory receipt.
- Read the retained structured saved source separately from opening the current
  notebook. Neither a preview nor a duplicate observation repeats a debit.

## User path

Open Inventory and choose **Record scientific transfer**. Choose the saved page,
a known usable source stock, an existing empty permanent well and exact amount.
State why the operator reports that the manual transfer was completed. Preserve
the physical work identity when presenting the same observation again.

**Preview observed transfer** shows native before/after stock facts and pinned
structured saved context. **Record completed manual transfer** records the
report. It does not execute an instrument or establish biological success.

A recorded work card offers **Read retained saved context** and **Open current
notebook**. The historical source is a complete structured saved title/content
snapshot, not an accepted scientific revision or exact original Markdown.
Opening the current page may show a later edit; it does not rewrite the old
observation.

## Desktop driver

Capture an exact current v23 fixture with `refresh-fixture`, preserving the
completed inventory history, then run:

```sh
node apps/desktop/scripts/inventory-journey.mjs --stage scientific --fixture /absolute/evidence/current-fixture.json --out /absolute/evidence/scientific
```

The first driver chooses actual currently admitted known-volume stock and a real
empty permanent A1 well from native/state facts. It creates a notebook through
Files, the project context menu, **New…**, **Notebook Entry**, **Create** and
the ordinary filename entry. It types an observation description into the real
notebook editor and saves until the native source listing admits that clean,
settled page.

It previews10µL without inventory changes, records once and immediately writes
`01-scientific-checkpoint.json` before checking presentation. The original
material, lot and constraints must follow the aliquot, the source must lose
exactly10µL and unrelated inventory facts must remain unchanged. Re-presenting
the same identity must report no-change. The driver reads retained context and
opens the current page through the existing project-resource reference route.

Preserve every original attempt. `scientific-resume` accepts an exact checkpoint
and never repeats a completed inventory action. A notebook creation already
marked creating must be inspected and completed rather than recreated under a
new identity. After a full native restart, `scientific-reopen` with
`scientific-reopen-fixture.json` requires exact state/history, duplicate safety,
retained source and current notebook navigation.

## Limits

Protocol Run ownership, persistent plate plans, result production, robot
execution and biological success remain separate workflows. Each needs its own
actual workflow evidence. Notebook writes and inventory SQLite commits remain
separate owners.

## Separate notebook edit and preview without another transfer

With the exact completed scientific fixture, run `scientific-source-edit`. It
opens the recorded work's current notebook through its project-resource
reference, appends a separately identified follow-up and saves until the native
clean/settled source hash changes. It immediately writes the settled-source
checkpoint before checking later presentation. The original work, retained
structured source and inventory revision/history remain unchanged.

A distinct observation identity then previews10µL from the actual remaining
source into another existing empty permanent well, preferring the same plate's
A2. That ready preview must display the edited notebook source. The driver
cancels it and verifies no second debit, stock or work record exists.

Preserve failed attempts and resume using `scientific-source-edit-resume` with
its exact checkpoint. An edit marked started is inspected/saved rather than
appended again. Its final `scientific-reopen-fixture.json` preserves the
original scientific proof and a separate `scientificSourceEditJourney` proof.
The combined `scientific-reopen` branch verifies the old retained context,
current edited page, distinct new candidate and exact unchanged inventory. It
does not re-present the original work using changed source meaning.

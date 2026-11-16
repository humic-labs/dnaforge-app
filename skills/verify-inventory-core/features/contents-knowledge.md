# Container contents knowledge

## Sub-features

Containers with no stock record distinguish an explicit empty declaration,
unobserved contents and unidentified material. Identified stock remains
identified with zero or unknown quantity. Recording unresolved contents cannot
erase a stock record. Identification records existing contents and does not
invent a physical receiving event.

This workflow is qualified through actual native HTTP and file SQLite, the
desktop controls and a full native app restart. The workflow preserves exact
state, history and original receipts. Actual foreign vessel binding application
remains part of the separate capture import workflow.

## How to get to it (user POV)

Open Inventory and select the intended project. Add a container with its initial
contents knowledge, or open a container from its location map or the containers
without stock list. Record unobserved or unidentified contents with a reason.
Identify existing contents through the scientific material picker, or explicitly
declare the container empty. Ordinary receiving and new material-operation
destinations require a declared-empty container.

## Driving it with Electron

Use the task-owned background app and a current inventory fixture:

```sh
node apps/desktop/scripts/inventory-journey.mjs --stage contents --fixture /absolute/current-owned-fixture.json --out /absolute/evidence/contents
```

The contents journey must create an unobserved container through ordinary
controls, show that receiving cannot use it, record unidentified material,
identify its existing contents, and preserve a known zero stock as identified.
Refused knowledge changes must preserve that stock and its original receipt.

If a driver stops after the verified move and before creating the plate, keep
the failed capture and cancel the uncommitted location form. Capture the actual
current state and complete history through the production read API. Preserve the
original `names` and `initialRevision` from the created-container checkpoint,
and set `resumePhase` to `after-move`. The current state must be nine revisions
after that original baseline; do not substitute the earlier creation checkpoint
for the post-move state. Resume into a new evidence directory:

```sh
node apps/desktop/scripts/inventory-journey.mjs --stage contents-resume --fixture /absolute/verified-after-move-resume-fixture.json --out /absolute/evidence/contents-resume
```

Resume checks exact current state/history and the already created containers,
quantities and placement. It creates only the remaining top-level plate and its
unobserved-well declaration. Receipt recovery still covers every operation after
the original baseline, including the earlier successful steps. It does not
repeat or fabricate their visual captures.

A separate unresolved container must become declared-empty only through an
explicit reason-bearing action, then accept ordinary receiving. Moving or
checking out an unresolved container must preserve its knowledge. Capture the
actual controls, state, journal, original requests and receipts. Restart the
same profile, then run:

```sh
node apps/desktop/scripts/inventory-journey.mjs --stage contents-reopen --fixture /absolute/evidence/contents/contents-reopen-fixture.json --out /absolute/evidence/reopen
```

Require exact inventory/history parity and original receipt recovery. Never use
renderer setters or SQL writes to prepare acceptance.

## Gotchas

Unobserved means the contents have not been checked. Unidentified means material
is present without an admitted scientific identity. Neither means unknown
quantity on an identified stock. A zero stock remains identified. Empty
positions and empty containers are separate facts. Read-only projects can
inspect contents knowledge but cannot change it. Legacy creation declarations
must not acquire invented observation timestamps or actors during upcast.

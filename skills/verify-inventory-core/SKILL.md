---
name: verify-inventory-core
description:
  Exercise DNAForge's native inventory command core through loopback HTTP and
  durable SQLite, including reopen, retry and bounded state invariants. Use for
  core inventory changes and the real desktop inventory workspace. Hardware
  qualification is separate.
---

# Verify inventory core

Read [the mapped workflow](features/native-inventory.md) and
[the command contract](../../docs/inventory-core.md) when changing inventory
semantics.

## Launch and doctor

Use the Node and pnpm versions pinned by the checkout. Install dependencies
through the repository's contributor setup. No Electron window, sidecar,
database service or credentials are needed for this native-core check.

From the repository root, confirm the test files and lockfile exist:

```sh
node --version
pnpm --version
git status --short
```

The desktop Vitest setup supplies the locked Node SQLite binding. Do not replace
it with another SQLite version or rebuild an unrelated checkout's native modules
when diagnosing a failure.

## Drive

Choose a new absolute evidence directory outside the checkout and set
`INVENTORY_CORE_EVIDENCE_DIR` to it. Run the native workflow from
`apps/desktop`:

```sh
pnpm exec vitest run src/main/inventory-native-acceptance.test.ts
```

The test creates synthetic admitted project/material records, starts its own
authenticated loopback command server, executes inventory commands, closes and
reopens its database and listener, and checks receipt recovery. The production
parser, registered-project authority, pure transition function, transaction
owner and HTTP dispatch are real. The unrelated annotation receiver is inert.

Run focused domain checks from `packages/core/domain-services`:

```sh
pnpm exec vitest run src/inventory.test.ts src/inventory-state-model.test.ts
```

Run the persistence owner's fault and integrity checks from `apps/desktop` when
that boundary changes:

```sh
pnpm exec vitest run src/main/inventory-owner.test.ts
```

## Evidence

For the visible workflow, read
[the inventory workspace map](features/inventory-workspace.md). Start an owned
background scenario app as described in `skills/verify-dnaforge/SKILL.md`, then
run from the repository root:

```sh
node apps/desktop/scripts/inventory-journey.mjs --stage before --out /absolute/evidence/before
node apps/desktop/scripts/inventory-journey.mjs --stage journey --out /absolute/evidence/journey
```

The `before` stage requires a source baseline without the Inventory activity.
Keep that original capture when changing the source. The journey uses the
isolated profile's writable My Project, imports synthetic pUC19 scientific
identity through the native import owner, then drives all inventory changes
through ordinary controls. Use a fresh inventory for a new journey attempt. The
helper checks native provenance and writes original screenshots, screencast
frames, timestamps, video, state and history. It requires `ffmpeg` on PATH.

For a real reopen, stop only the task app. Relaunch with the same scenario
profile using `ELECTRON_CLI_ARGS` as a JSON array containing
`--user-data-dir=THE_ORIGINAL_PROFILE` and
`--dnaforge-allow-scenario-mutation=1`, with the original background/scenario
environment. Then run:

```sh
node apps/desktop/scripts/inventory-journey.mjs --stage reopen --fixture /absolute/evidence/journey/reopen-fixture.json --out /absolute/evidence/reopen
```

Require exact state and history parity after the native process restarts. A
renderer refresh is not an application restart. Stop the owned app with
`pnpm --dir apps/desktop dev:stop` when its purpose ends.

Inspect the JSON artifacts in `INVENTORY_CORE_EVIDENCE_DIR`. Require exact
post-reopen quantity and placement, original operation identity, accepted
history and matching replay state. Read refused-operation results and subsequent
unchanged state. A test exit code alone does not establish the workflow's
values.

The state-model test reports its finite fixtures and explored bounds. It does
not prove timing, fairness, arbitrary inventory sizes, or distributed behavior.
Retain failing attempts alongside the eventual passing run and bind evidence to
the exact source revision when reporting it.

## Cleanup

Tests close their own HTTP listeners and SQLite connections and remove temporary
fixture directories. Evidence is written outside those fixture directories and
survives cleanup. Confirm it remains readable. No application or service process
should remain after the command exits.

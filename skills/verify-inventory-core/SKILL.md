---
name: verify-inventory-core
description:
  Exercise DNAForge's native inventory command core through loopback HTTP and
  durable SQLite, including reopen, retry and bounded state invariants. Use for
  core inventory changes rather than graphical inventory or hardware
  qualification.
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

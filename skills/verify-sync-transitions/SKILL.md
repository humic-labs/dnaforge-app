---
name: verify-sync-transitions
description:
  Drive DNAForge's production workspace sync commands with file-backed SQLite
  and isolated cloud adapters. Use when queue transitions, upload leases,
  disable, conflict resolution or pull recovery changes.
---

# Verify sync transitions

Read [the feature map](features/README.md). This workflow runs production sync
owners below Electron transport with synthetic workspaces and cloud responses.
It never contacts production cloud services or opens a desktop window.

## Launch and doctor

From the repository root, prepare locked dependencies if absent:

```sh
pnpm install --frozen-lockfile --ignore-scripts
node node_modules/dugite/script/download-git.js
node skills/verify-sync-transitions/scripts/verify.mjs doctor
```

The doctor executes a query through the test SQLite binding and runs bundled
Git. No credentials, server or administrator access is needed. A failed doctor
means the environment is unavailable; it is not a product result.

## Drive and evidence

Choose a fresh absolute evidence directory outside the checkout:

```sh
node skills/verify-sync-transitions/scripts/verify.mjs drive /absolute/evidence/sync-run
```

The runner selects the mapped application-command cases from existing desktop
tests. Its test fixture adapter replaces only in-memory test databases with real
file-backed SQLite, verifies `PRAGMA database_list`, and logs each database
path. Production queue, upload, conflict, action and runtime code is unchanged
by the harness. Cloud responses, watcher callbacks and clocks use existing
dependency boundaries. Workspaces, snapshots and Git fixtures are disposable.

Inspect `results.json`, `run.log` and `receipt.json`. The receipt binds the
command, source commit, source hashes, current diff and exit status. Preserve a
before run and an after run for a refactor. Keep original failed attempts.
Passing these cases proves the mapped state and transaction behavior; it does
not prove live cloud interoperability, watchers or desktop appearance.

## Cleanup

The fixture adapter closes and deletes its databases after each test. Existing
fixtures stop their runtime owners and remove their temporary workspaces. The
runner exits without a service or timer. Evidence stays outside cleanup. If a
run is interrupted, identify its paths in `run.log` before removing anything.
Never stop or clean another task's runtime.

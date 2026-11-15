---
name: verify-migration-recovery
description:
  Prove preserved Benchling ZIP retry and failed-unlock recovery through the
  production coordinator and file-backed SQLite store. Use when migration
  lifecycle, recovery commands, or conditional persistence changes.
---

# Verify migration recovery

This drives the application's migration commands with disposable local ZIPs,
workspaces and SQLite databases. It does not launch Electron or use personal
imports. Read [the feature map](features/README.md) before selecting coverage.

## Launch and doctor

From the repository root, install the locked dependencies if absent:

```sh
pnpm install --frozen-lockfile --ignore-scripts
node node_modules/dugite/script/download-git.js
node skills/verify-migration-recovery/scripts/verify.mjs doctor
```

The doctor executes a query through the SQLite binding used by desktop tests and
checks the installed bundled Git executable. A failure is an unavailable
verification environment. Repair the dependency installation before making a
success claim. No server, credentials, desktop window, administrator access or
network import is needed. Git and Node must be on PATH. Existing test helpers
own their temporary repositories and databases.

## Drive and observe

Choose an absolute evidence directory outside the checkout. Use a fresh
directory for every run so original captures survive.

```sh
node skills/verify-migration-recovery/scripts/verify.mjs drive /absolute/evidence/run
```

The runner executes the mapped recovery cases, preserves the test log and JSON
result, and writes a receipt with the source commit, dirty diff, source hashes,
commands and exit status. Inspect `receipt.json` and `results.json`; a missing
result or failed case is not proof. For structural refactors, run before product
edits and after them with unchanged behavior assertions. Compare the named cases
and persisted results described in the feature map.

The recovery workflow mocks Electron transport and renderer validation. It uses
the real coordinator, ZIP intake, migration executor, SQLite store, unlock
transaction and workspace Git operations. It proves recovery and durable state;
it does not prove desktop appearance or real renderer validation.

## Cleanup

The tests close their databases and remove only their temporary workspaces in
`afterEach` or fixture cleanup. The command exits without a background process.
Keep the evidence directory. After an interrupted run, identify its temporary
paths from the captured log before removing anything; never clean another run's
workspace.

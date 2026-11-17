---
name: verify-molecular-projection
description:
  Verify DNAForge desktop molecular document source-link reconciliation through
  its production adapter and native command with persisted SQLite. Use after
  changes to document opening, molecular source pins, or catalog authority.
---

# Verify molecular document projection

## Launch

From the repository root, install dependencies with
`pnpm install --frozen-lockfile --ignore-scripts`. Run
`node apps/desktop/scripts/install-test-sqlite.cjs`. The command must report a
verified locked SQLite binding. If the package has no native binding, run
`pnpm rebuild better-sqlite3`, then retry. This focused workflow needs no
Electron window, API service, credentials, or shared database.

## Doctor

Run `git rev-parse HEAD` and
`node apps/desktop/scripts/install-test-sqlite.cjs`. Record the source commit.
The integration driver creates a unique project and on-disk SQLite database; it
cannot use another app's data directory.

## Drive

Choose an absolute evidence directory outside the checkout. From the root run:

```sh
MOLECULAR_PROJECTION_EVIDENCE="$EVIDENCE_DIR" pnpm --dir apps/desktop exec vitest run src/main/molecular-document-projection.test.ts --reporter=verbose > "$EVIDENCE_DIR/transcript.txt" 2>&1
```

Create the evidence directory before running. The
[feature map](features/README.md) defines acceptance. The driver opens a real
molecular file using the production library, invokes the production renderer
adapter and typed native IPC handler (only the Electron transport is replaced),
closes and reopens SQLite, and checks persisted links and unchanged source
bytes. The database's actual renderer SQL guard remains active. This proves the
native opening/projection boundary; it does not claim visual desktop
qualification.

## Evidence

Keep `transcript.txt`, `projection.json`, the source commit, and original
molecular bytes outside the worktree. `projection.json` records the source
digest, exact source pins, obsolete-link removal, unrelated-link retention, and
persisted retry result. A passing transcript alone is insufficient if the
receipt is absent. Keep failed attempts in separate directories.

## Cleanup

The driver's `afterEach` closes its database and removes only its unique scratch
directory, including on failure. No server or background process is started.
Confirm the evidence files still exist after completion. Never remove evidence
during cleanup.

## Helpers

The executable driver is
`apps/desktop/src/main/molecular-document-projection.test.ts`, invoked above
using the repository's Vitest harness. For drift repair, use the PStack
maintain-verification-skill workflow against this map.

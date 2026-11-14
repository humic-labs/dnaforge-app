---
name: verify-workspace-session
description:
  Verify DNAForge desktop project mounting, active selection, removal and
  restart restoration through its native preview. Use after changes to workspace
  session ownership or asynchronous project opening.
---

# Verify workspace sessions

## Launch

Follow README setup in an isolated feature checkout. Allocate unused ports in
`apps/desktop/.env.local`. Start only that checkout with
`DNAFORGE_BACKGROUND_WINDOW=1 pnpm --dir apps/desktop dev`. Wait for
`ELECTRON_DEV_READY`; never raise or reposition its window. The profile is
isolated by the configured desktop port. Preserve it between the transition and
restart phases.

## Doctor

Run `node apps/desktop/scripts/dev-single-instance-guard.cjs --status`. Require
a healthy owned renderer and its exact debug endpoint. Record
`git rev-parse HEAD` and local changes. Never attach to another checkout's
preview.

## Drive

Run
`node apps/desktop/scripts/check-workspace-session.mjs --out /absolute/durable/evidence --phase transitions`.
The driver creates disposable native projects, operates project controls, and
records original frames, video, visible roots and persisted selection. Stop and
restart this checkout with its guarded commands, then run the same helper with
`--phase restored` and the same evidence directory. The
[feature map](features/README.md) defines the expected behavior.

Run the focused ownership pin with
`pnpm --dir apps/desktop exec vitest run src/hooks/useWorkspace.session.test.ts src/stores/workspaceStore.ownership.test.ts`.
It holds delayed database writes, collection reads and removed-root operations;
it supplements the live workflow and cannot substitute for it.

## Evidence

Retain the original frame captures and timestamps, derived MP4, action receipts,
source identity, native project paths and database observations outside the
checkout. A screenshot alone cannot prove that removed roots stayed removed
during asynchronous completion. The restore phase uses the same native profile
and verifies registered active roots plus the current preference. No test-only
state setters qualify as product acceptance.

## Cleanup

Stop only this preview with
`node apps/desktop/scripts/dev-single-instance-guard.cjs --stop`. The driver
closes its own CDP connection and recording process, never the app. Keep its
disposable projects and all evidence until the assignment is complete. Check
that the evidence remains after preview shutdown.

## Helpers

The executable Node helper is
`apps/desktop/scripts/check-workspace-session.mjs`, invoked above. It requires
the installed Playwright dependency and `ffmpeg` for video assembly. Use PStack
maintain-verification-skill to update this map when project commands change.

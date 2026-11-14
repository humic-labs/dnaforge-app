---
name: verify-track-view-session
description: Verify DNAForge Track view save, rename, copy, revision checks and document ownership through native desktop and shared agent commands.
---

# Verify Track view sessions

## Launch
Follow README setup in an isolated feature checkout. Set unused ports in
`apps/desktop/.env.local`, then run `DNAFORGE_BACKGROUND_WINDOW=1 pnpm --dir apps/desktop dev`.
Wait for `ELECTRON_DEV_READY`. Never raise or reposition the window.

## Doctor
Run `node apps/desktop/scripts/dev-single-instance-guard.cjs --status`. Require a
healthy owned renderer and its exact debug endpoint. Record commit and diff.

## Drive
Run `node apps/desktop/scripts/check-track-view-session.mjs --out /absolute/durable/evidence`.
It creates a disposable project through project controls, imports a small local
reference through the native command, and drives human and agent saves. No model
credential or large download is needed. Follow [the feature map](features/README.md).
Run `pnpm --dir apps/desktop exec vitest run src/features/sequence/components/TrackViewSession.acceptance.test.tsx`
for the deterministic delayed-write and detached-control ownership cases.

## Evidence
Keep original frames, timestamps, derived video, screenshots, command results,
native saved-file readback, source identity and focused-check transcript outside
the checkout. Native acceptance exercises production commands and UI; the focused
check replaces only the native file transport to hold completion deterministically.

## Cleanup
Run `node apps/desktop/scripts/dev-single-instance-guard.cjs --stop` in this
checkout. The helper closes its CDP recorder, never an unrelated app. Retain the
disposable project and evidence, and verify evidence still exists after shutdown.

## Helpers
The Node helper is `apps/desktop/scripts/check-track-view-session.mjs`. It uses
installed Playwright and ffmpeg. Use PStack maintain-verification-skill when commands change.

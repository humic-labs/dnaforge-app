---
name: verify-genome-session
description:
  Verify native DNAForge genome opening, current session readiness, viewport
  continuity and close/reopen restoration. Use when changing genome-session
  ownership, event recovery or presentation transitions.
---

# Verify native genome sessions

## Launch

Use an isolated public checkout with README dependencies and matching native
helpers. Choose unused desktop, HMR, API and debug ports in
`apps/desktop/.env.local` with a fresh port-derived profile for each
before/after run. Check memory and existing process ownership, then launch
`DNAFORGE_BACKGROUND_WINDOW=1 pnpm --dir apps/desktop dev`. Wait for
`ELECTRON_DEV_READY`; never raise or reposition the window.

## Doctor

Run `node apps/desktop/scripts/dev-single-instance-guard.cjs --status` and
require a healthy owned renderer. Record source HEAD and the scoped diff. Never
attach to another task's preview.

## Drive

Run
`node apps/desktop/scripts/check-genome-session.mjs --out /absolute/durable/evidence`.
It creates a native project through the UI, prepares a small local FASTA through
the production reference command, creates a saved view through the production
Track View command, and opens it through the file tree. It records native
session readiness, navigates and saves, closes the tab, and reopens the same
file. See the [feature map](features/README.md).

Run
`pnpm --dir apps/desktop exec vitest run src/features/sequence/components/IndexedGenomeTab.loading.test.tsx src/features/sequence/genome-live-session.test.ts src/main/ipc/assembly-annotation-product-index-ipc-surface.test.ts`
for lost event recovery, stale events, errors before/after presentation, lease
disposal and generation admission. Those controlled native-boundary tests
supplement the real app; they do not establish native UI qualification by
themselves.

## Evidence

Keep original JPEG frames and timestamps, derived MP4, screenshots, native
session observations and saved-view contents outside the checkout. Capture
action and result. Require real coordinate readiness, enabled navigation, no
loading overlay, viewport restoration and no relevant renderer/network errors.
No internal setters or test-only open endpoint qualify as product action. The
test bridge is read only for locating the project created through the UI.

## Cleanup

Stop only this checkout with
`node apps/desktop/scripts/dev-single-instance-guard.cjs --stop`. Keep its
disposable project/profile and evidence through acceptance and delivery. Verify
original captures survive shutdown.

## Helpers

`apps/desktop/scripts/check-genome-session.mjs` requires installed Playwright
and `ffmpeg`; invoke it as above. Maintain the feature map with PStack
maintain-verification-skill when the real opening route changes.

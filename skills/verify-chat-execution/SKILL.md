---
name: verify-chat-execution
description: Verify DNAForge conversation sending, queue advancement, stopping and durable settlement in real orchestration and an isolated native desktop preview.
---

# Verify conversation execution

## Launch

Install dependencies with `pnpm install --frozen-lockfile`. Focused orchestration runs need no services. For the native journey use this checkout's own `apps/desktop/.env.local` ports and `DNAFORGE_BACKGROUND_WINDOW=1 pnpm --dir apps/desktop dev`, as described in the repository README. Enable the existing development credential import only in this disposable profile with `VITE_DNAFORGE_ENABLE_DEV_AI_ENV_KEYS=1` and `WAYPOINT_DEV_ANTHROPIC_API_KEY=verification-fixture`. The native driver intercepts this provider's HTTP boundary; it never sends a paid request. Keep the window in the background.

## Doctor

Run `node skills/verify-chat-execution/scripts/verify.mjs doctor`. For native acceptance, also run `node apps/desktop/scripts/dev-single-instance-guard.cjs --status`; require healthy owned renderer and CDP endpoints before attaching.

## Drive

Run `node skills/verify-chat-execution/scripts/verify.mjs drive /absolute/external/evidence-directory` for the real queue, send, provider adapters and terminal commit orchestration. The renderer tests replace database IPC and external provider transports; they do not prove native persistence.

Run `node skills/verify-chat-execution/scripts/native.mjs --out /absolute/external/native-evidence-directory` against the owned preview for actual composer send/queue/stop, provider HTTP fixtures and native database observations. See [the feature map](features/README.md). Use fresh evidence directories; failed attempts remain evidence.

Run `node skills/verify-chat-execution/scripts/native-terminal-failure.mjs --out /absolute/external/terminal-failure-evidence-directory --database "/absolute/owned-profile/dnaforge.db"` for a real SQLite terminal-write fault. The driver validates the explicit database against its owned preview port and uses Python SQLite to create a trigger scoped to its exact turn, drives the provider response through the same composer workflow, observes the retained busy turn and queued follow-up, and removes the trigger in `finally`. The receipt lists database rows, state observations and original media; its baseline must fail before the repair.

## Evidence

Keep source commit, hashes, command, results and original failure logs outside disposable checkouts. Native receipts contain UI actions, actual database rows, screenshots and original timestamped frames/video. A provider fixture qualifies lifecycle and persistence, not live-model quality. Assert success and absence of renderer failures. Baseline and changed-source acceptance use the same driver.

## Cleanup

The focused runner terminates normally without services. The native driver disconnects CDP; stop only this checkout with `node apps/desktop/scripts/dev-single-instance-guard.cjs --stop`. Preserve the evidence and disposable profile until its database observations are recorded. Confirm all original receipts/media remain after teardown.

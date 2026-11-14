# Recovery and degraded capabilities

## Sub-features

- Recover a lost native update by polling the current session.
- Reject stale session/generation updates after replacement or closure.
- Fail initial preparation, preserve a presented viewport on later capability
  failure.

## How to get to it (user POV)

Open a local reference and wait for preparation. Errors before first
presentation show an opening failure; later capability failures must retain
useful coordinates. Close and reopen to create a new native session.

## Driving it with Vitest and Playwright

Freeze and run existing IndexedGenomeTab.loading.test.tsx recovery and
presentation cases before refactoring. Force event loss and completion order at
the native port. Then run the native open/reopen recipe; original video proves
actual continuity.

## Gotchas

Events can arrive before open returns. Polls and events describe the same
session; they cannot own separate readiness rules. A current generation may gain
capabilities while older work completes. Never claim forced race timing from a
normal UI recording.

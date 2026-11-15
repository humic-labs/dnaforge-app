# Save, rename and copy

## Sub-features
Existing-save, rename, independent copy, naming cancellation, persisted reopen.

## How to get to it (user POV)
Open a Track view from a project. Use Save view and Track view actions, or the matching app_views agent command.

## Driving it with Playwright and Vitest
Run the native helper. Human rename and agent rename must change the same file; duplicate must create a different identity, stale revision must refuse, cancellation must not write, and reload must preserve names/configuration.

## Gotchas
Use an isolated native profile. Preserve every original capture. Timing pins supplement real native file acceptance.

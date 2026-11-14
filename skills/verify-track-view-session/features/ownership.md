# Lifetime and concurrent changes

## Sub-features
Tab lifetime, UI detachment, restoration readiness, edits during save, close cleanup.

## How to get to it (user POV)
Open a Track view from a project. Use Save view and Track view actions, or the matching app_views agent command.

## Driving it with Playwright and Vitest
Run the frozen ownership acceptance file. An open saved tab has a command owner without toolbar mounting. Removing controls must not remove that owner. Unready restoration preserves dirty state. A delayed write must not mark newer edits clean; cancelled naming settles pending save requests false. Closed tabs cannot receive late save projections.

## Gotchas
Use an isolated native profile. Preserve every original capture. Timing pins supplement real native file acceptance.

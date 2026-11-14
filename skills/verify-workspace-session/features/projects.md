# Project transitions

## Sub-features

- Open two native projects and activate each.
- Remove the active project and select a remaining root coherently.
- Refuse removal of the last ordinary project.
- Retire older asynchronous activation or replacement after a newer intent.

## How to get to it (user POV)

Use project controls in Files and Manage projects. Ordinary registered projects
expose Archive project; pinned references expose Hide project from Files. The
final writable project is protected from removal.

## Driving it with Playwright and Vitest

Run the transitions phase from the skill and the focused ownership pin. Verify
displayed roots and `current_workspace_path` against accepted commands, preserve
transient video, and assert that stale completion cannot remount a removed root
or overwrite a newer preference.

## Gotchas

Mounted roots are different from the inspected file snapshot. The current
project preference is a selection within the mounted collection. Pinned
development roots must not become the writable selection. Native registration,
materialization and preference writes can finish at different times.

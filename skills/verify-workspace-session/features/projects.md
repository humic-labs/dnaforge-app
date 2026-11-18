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

Run the transitions phase from the skill and the focused ownership pin. Before
archiving each seeded project during setup, wait for the native document roots
to be enrolled and for indexing of that project to finish. Verify
displayed roots and `current_workspace_path` against accepted commands, preserve
transient video, and assert that stale completion cannot remount a removed root
or overwrite a newer preference.

## Gotchas

Mounted roots are different from the inspected file snapshot. The current
project preference is a selection within the mounted collection. Pinned
development roots must not become the writable selection. Native registration,
materialization and preference writes can finish at different times.

The selection owner uses `apps/desktop/src/db/connection.ts`.
`apps/desktop/src/db/index.ts` re-exports that same database object for existing
consumers. Importing the workspace store must not initialize reconciliation or
document services. When changing this boundary, run the unchanged consumer pins:

```sh
pnpm --dir apps/desktop exec vitest run src/features/workspace-loader/workspace-telemetry.test.ts src/services/workspace-artifact-open.test.ts
```

These checks supplement the native workflow. For a connection-only relocation,
record whether its initializer and workspace command bodies are unchanged, and
link the existing native receipts without claiming a new native run.

---
name: verify-notebook-authoring
description: Verify notebook links, command menus, reference editing and tables in the desktop app.
---

# Verify notebook authoring

Use a disposable project and notebook in a development profile. Check the app port with `pnpm --dir apps/desktop dev:status`. Record the Git commit and any local changes alongside the results.

## Component checks

From the repository root, run the group for the affected behavior.

```sh
node skills/verify-notebook-authoring/scripts/check.mjs --group menu --out /absolute/path/to/results
```

The available groups are `menu`, `discovery`, `caret`, `references`, `tables` and `registry`. The report records the test files, source fingerprint and exit status.

## Desktop checks

Follow the [notebook journey](../verify-dnaforge/features/notebook-authoring.md) for fixtures and the [regression inventory](features/regressions.md) for the expected behavior. Drive the selected workflow in the desktop app. For a timing issue, observe the interaction while typing, navigating or scrolling. For a saved reference, reopen the notebook and follow the reference to its original record.

Keep the original reproduction and the result from the changed version. Record component checks and desktop observations separately. Mark any desktop behavior that could not be observed as unverified.

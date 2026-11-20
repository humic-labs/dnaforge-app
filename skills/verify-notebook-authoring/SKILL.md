---
name: verify-notebook-authoring
description: Verify notebook links, command menus, reference editing and tables and saved-record recovery in the desktop app.
---

# Verify notebook authoring

Use a disposable project and notebook for automated checks. For a preview someone will keep testing, launch the desktop with a dedicated user-data directory in persistent user storage. Reuse that directory on every restart. The temporary scenario launcher is for short-lived checks. Electron stores managed projects beneath its active profile, so system cleanup can remove a temporary project's working files and its local recovery store together.

Check the app port with `pnpm --dir apps/desktop dev:status`. Record the actual profile path, managed project root, Git commit and any local changes alongside the results.

## Component checks

From the repository root, run the group for the affected behavior.

```sh
node skills/verify-notebook-authoring/scripts/check.mjs --group menu --out /absolute/path/to/results
```

The available groups are `menu`, `discovery`, `caret`, `references`, `tables`, `registry` and `retention`. The report records the test files, source fingerprint and exit status.

## Desktop checks

Follow the [notebook journey](../verify-dnaforge/features/notebook-authoring.md) for fixtures and the [regression inventory](features/regressions.md) for the expected behavior. Drive the selected workflow in the desktop app. For a timing issue, observe the interaction while typing, navigating or scrolling. For a saved reference, reopen the notebook and follow the reference to its original record.

Keep the original reproduction and the result from the changed version. Record component checks and desktop observations separately. Mark any desktop behavior that could not be observed as unverified.

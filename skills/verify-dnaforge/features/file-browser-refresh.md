# Move and Rename completion

This map covers Files actions that commit a file change and then refresh the
project. Keep the mutation, Project Memory update and refresh as separate
observable stages.

## Focused component check

From the repository root, run:

```sh
pnpm --dir apps/desktop test -- src/components/FileBrowser.test.tsx --testNamePattern 'waits for every project refresh before completing|reports committed .* when project refresh fails without qualifying completion|holds one workspace mutation across drag relocation and Project Memory|does not qualify a failed rename|does not qualify a failed drag relocation' --maxWorkers 1 --minWorkers 1
```

The maintained component checks exercise the rendered Files controls and the
existing move event. Require all of these results:

- A cross-project Move waits for the destination refresh as well as the source
  refresh before reporting completion.
- Rename waits for its project refresh before reporting completion.
- If refresh rejects after either change commits, the operation reports failure
  and a warning says the file change was saved. It does not report completion or
  repeat the file mutation.
- Relocation and Project Memory retain their existing shared mutation token. A
  failed file mutation still reports failure.

These checks control the refresh callback boundary. They do not establish native
filesystem, catalog, cross-volume or process-lifecycle acceptance.

## Native user path

Launch one owned background app and retain evidence using the parent
[desktop verification skill](../SKILL.md). Use only synthetic projects owned by
this verification.

1. Mount two synthetic projects. Record the source file's path and content hash.
2. Drag the source file into a folder in the destination project. Wait for both
   project trees to refresh. Open the moved file and compare its contents and
   native file hash with the original. The old path must be absent.
3. Choose Rename from the moved file's context menu and commit a new name. Wait
   for the project tree to refresh. Open the renamed file and verify the same
   content hash at its new path.
4. Reopen the synthetic projects through their normal owner. Verify that the
   moved and renamed locations persist and the old paths remain absent.
5. Retain the original captures and source identity, then stop the app using the
   parent skill's cleanup command. Record actual owned-process release.

Record native results separately from component results. A component pass or a
collected native path is not a native pass.

# Sample workspace copy

## Sub-features

- Admit independent files across nested packages while an earlier copy is held.
- Keep at most four unsettled copies in one complete workspace materialization.
- Publish the sample marker, destination and import authority only after every
  copy succeeds.
- Preserve the first copy failure and drain admitted work before removing its
  temporary directory.
- Preserve reuse, import authority, canonical resources, manifest validation and
  symlink refusal.

## How to get to it (user POV)

The desktop can seed the Samples project automatically when startup eligibility
allows it. This path is owned by
`apps/desktop/src/hooks/useWorkspaceProjectActions.ts` and the `sample-template`
branch of
`apps/desktop/src/features/workspace-loader/open-workspace-from-source.ts`.
Materialization completes before the dependent managed import starts.

The check below invokes the native factory directly. It does not launch or drive
the desktop. Use [project transitions](projects.md) for visible project
behavior.

## Driving it with Vitest

Run from the repository root with the existing desktop dependencies:

```sh
pnpm --dir apps/desktop exec vitest run src/main/sample-workspaces/factory.test.ts
```

The maintained file has twelve cases: the original eight and four copy-admission
cases. Its two-package fixture uses the current package format and six real
files. Explicit copy gates control completion while other filesystem operations
delegate to the real Node filesystem.

Require cross-package admission before releasing the first held copy and a peak
of at most four unsettled copies across the entire nested fixture. Check that
neither marker publication, destination rename nor import authority occurs
before all files succeed. On an injected failure, require the original error, no
published destination or authority, and no temporary-directory cleanup while
admitted copies remain unsettled.

Retain the source and test identities, original test output and case counts
outside the checkout. Reuse an unchanged baseline rather than rerunning it.
After a correction, require all twelve cases to pass. The test drains its owned
copy operations before the existing cleanup removes its temporary fixture roots.

## Gotchas

The bound applies to one workspace-copy operation, not to all simultaneous
factory invocations. A separate pool in every directory does not satisfy it.

The admission barrier waits for current asynchronous metadata and nonheld copy
operations to settle; it does not compare elapsed time. A new asynchronous
discovery boundary requires corresponding fixture support before a failure can
be interpreted as serial copying.

Keep the dependent materialize-then-import order and ordered import retention.
This check does not measure large-template throughput, separate I/O from CPU
cost, or qualify desktop startup or native SDK timing. Those outcomes require
their own source-bound desktop evidence.

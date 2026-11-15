# Saved molecular source relationships

## Sub-features

- Restore exact source-coordinate pins from every saved history entry.
- Remove obsolete outgoing `uses-source` links while retaining unrelated links.
- Reopen and retry without changing link identities or timestamps.
- Reject mismatched document, project, file binding and changed source content.
- Refuse changes to reference or inactive projects; roll back the entire set on
  failure.

## How to get to it (user POV)

Open a `.dnaforge-molecular.json` file in its project. Project refresh uses the
same molecular document adapter. The file remains the source of truth for
history and coordinate pins; the catalog is a derived lookup.

## Driving it with Vitest

Run the exact command in the skill. The mapped driver reads a real file, calls
`molecularDocumentAdapter.reconcileRelationships` through the native handler,
then reopens the on-disk database. Acceptance requires the exact saved pins and
no obsolete links, stable identities on retry, byte-identical source history,
and zero partial mutations after rejected commands. The baseline failure is
`ENTITY_IDENTITY_REQUIRES_NATIVE_COMMAND` at the renderer's obsolete-link
delete.

## Gotchas

Missing or inactive optional source artifacts do not invent catalog entities.
Imported source identities prefer the current project's scoped copy.
Cross-project source artifacts must never become links. Native projection may
repair only the molecular document's own outgoing `uses-source` edges. The
harness replaces Electron IPC transport only; database writes, source reading,
admission and renderer guard are production code. No UI appearance is changed or
qualified by this driver.

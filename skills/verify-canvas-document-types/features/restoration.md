# Restoration

## Sub-features

Saved session round trips, legacy version 1/version 7 records and temporary
assembly-edit state.

## How to get to it (user POV)

Reload the app after opening documents. Existing saved profiles can predate the
current identity commands.

## Driving it with native CDP and Vitest

The native helper reloads the real renderer and checks restored document
identity, editor selection and saved text. The matrix serializes and migrates
the persisted variants through production functions. Temporary embedded assembly
editing is not persisted; the sequence document remains.

## Gotchas

Legacy migration is the compatibility boundary. Do not rewrite a catalog or
managed reference into an indexed-view identity merely to select a viewer.

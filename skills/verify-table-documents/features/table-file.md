# Native table file

Run
`node apps/desktop/scripts/check-table-files.mjs --out ABSOLUTE_EVIDENCE_DIRECTORY`
against the isolated task-owned native desktop app after its doctor is healthy.

Use the visible Files folder context menu, New, Table, Create and naming row.
Edit a cell in the new tab, use the system Save keyboard shortcut, close that
specific tab and reopen the table from Files. Existing tabs may become active
after close; they do not establish the newly created document's state.

Require the same table identity and edited value on reopen, a clean native file
owner, exact persisted head bytes, and an immutable snapshot whose SHA256 agrees
with the head. Keep the original screenshots, screencast frames and video,
runtime provenance, native snapshots and saved head/snapshot bytes.

Source owners: FileBrowser, the native table command service, the native file
owner and TablePanel. This journey does not qualify notebook extraction,
notebook references, a process restart, Windows dialogs or power-loss
durability.

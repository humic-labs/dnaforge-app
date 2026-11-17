# References and saved versions

Run
`node apps/desktop/scripts/check-table-references.mjs --out ABSOLUTE_EVIDENCE_DIRECTORY`
against the healthy isolated native app. The fixture setup uses the native
project and notebook commands; extraction, editing, insertion and Save use
visible controls. The controlled move uses the same native workspace relocation
command as Files.

Extract an edited inline table with Save as table file. Require the notebook's
saved placement to contain one durable current reference, while the original
value and table metadata remain in the verified table package. Open it in a tab.
Insert a live embed, a saved-version embed and a link in another notebook.

Save the notebook placements. Edit the live embed and use keyboard Save while
focus remains in its grid. Require the file owner and saved bytes to change,
while the clean containing notebook and pinned value stay unchanged. Require the
full tab to share the live value. Move the table package, edit and Save again,
and verify current and pinned references still resolve correctly.

For process restart, run
`node apps/desktop/scripts/check-table-reference-restart.mjs --mode prepare --source PASSING_REFERENCE_RECEIPT --out PREPARE_DIRECTORY`.
Stop only the owned app, restart with the same isolated profile, then run the
same command with
`--mode verify --prepared PREPARE_RECEIPT --out VERIFY_DIRECTORY`. Require a
different native process ID, exact saved notebook/head bytes, the same live
value and unchanged read-only pinned value. Renderer reloads do not qualify.

Preserve failed attempts, original screenshots, screencast frames, video and
receipts. These instructions require a genuine passing run before this workflow
can be claimed complete.

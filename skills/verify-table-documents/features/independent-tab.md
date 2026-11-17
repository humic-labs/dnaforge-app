# Independent notebook table tab

## Sub-features

- A notebook table opens in a tab through its visible Open in panel action.
- Closing its notebook editor does not revoke editing or Save.
- Table identity includes its notebook scope. Equal block IDs in separate
  notebooks must not share edits.
- Opening an old table leaves saved notebook content unchanged until a real
  edit.
- Save, history, conflicts and recovery use the notebook's existing native
  owner.
- Restored tabs resolve their source without reopening a hidden notebook editor.

## How to get to it (user POV)

Create a notebook from Files. Insert a table with `/table`, configure rows and
columns, edit a cell and save. Hover the table and choose Open in panel. Close
the source notebook tab, edit the expanded table and press the Save shortcut.
Reopen the notebook from Files and inspect the same table.

## Driving it with Playwright over CDP

Run the command in the parent skill against a task-owned desktop. Stable handles
are `table-grid`, `data-cell-position`, `Open in panel`, `tab-close-<tabId>`,
and the notebook's `data-page-id`. The success oracle is the exact native table
data, clean saved revision and matching reopened cell. Preserve the source table
block and verify the native package files after Save.

## Gotchas

The legacy renderer store uses bare table IDs and editor callbacks. A cached
grid that remains visible after its writer disappears is a failure. Do not
reopen the notebook to make the detached-edit step pass. Native block identity
and durable saved versions are separate from an owner's transient revision. Keep
ambiguous legacy identities and unsupported payloads intact; never assign new
identities silently to make a check pass.

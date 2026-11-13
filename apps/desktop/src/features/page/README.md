# Page Feature

Notebook entries are TipTap documents backed by the desktop page store.

## Data Flow

```
User edits notebook
    |
    v
TipTap editor emits JSONContent
    |
    v
page Zustand store tracks current page, dirty state, and loaded pages
    |
    v
SQLite pages table persists title/content
    |
    v
vault-shaped notebook package is updated when the page has a backing artifact
  Name/
    Name.md                 # best-effort markdown projection
    .forge/notebook.json    # TipTap JSON (source of truth)
    assets/                 # reserved
    |
    v
catalog records file binding (package root) and artifact lifecycle events
```

The SQLite `pages` table is still the active notebook persistence layer.
Notebook entries created from the file explorer start as pending `Untitled`
package folders, then commit to a stable page ID, a catalog entity/file binding
on the package root, and a mirrored package snapshot. `.forge/notebook.json` is
the portable recovery / sync path; the page store and `pages` table are the live
editor/cache path. Legacy `.wpnote.json` is dual-read and migrated on write.

## Artifact Recovery

Opening a notebook package (or legacy `.wpnote.json`) parses its embedded stable
ID. If the catalog row or file binding is stale or missing, DNAForge repairs the
catalog from the file and upserts the TipTap content back into the page
store/SQLite row before opening the notebook tab.

Renaming the notebook artifact renames the package directory (and matching
`Name.md` stem), updates the catalog binding, and keeps the page identity
stable.

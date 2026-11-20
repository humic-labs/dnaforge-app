# Notebook authoring

Use an owned development app and disposable writable project. Open DevPanel and
apply the **Notebook authoring review** scenario, then open **Notebook authoring
review**. It creates two projects with distinct pUC19 sequences and saved
primers. Do not replace a person's existing notebook to stage the check.

## Inline linking

With Files visible, choose Dark in Settings → Appearance. Open a notebook and
type `@M13`. Capture the activity bar, file tree, inline query and results in
one screenshot. All four share a panel color that is visibly lighter than the
notebook page. Read the names and secondary labels on both the selected and
unselected rows. Repeat in Light, where the page is white and the panels are
light gray. With System selected, switch the OS appearance while the picker is
open and check that the page, panels and labels update together.

1. In the middle of a paragraph, type `/`. Require three columns: **Format**,
   **Embed**, and **Entity**. Entity initially contains one **Link an entity**
   action. Image, Table and 3D Structure retain their existing embed icons.
2. Choose **Link an entity**. Type a saved name directly in the paragraph. The
   active query uses the theme's green accent with the same font and baseline as
   surrounding prose. Following text moves and wraps naturally. Results appear
   below; the dropdown contains no separate search field.
3. Type `@M13 Forward` and select the real primer. Type `/primer` and choose
   **Primer** to browse saved primers with the same dropdown. Browse categories
   come from the shared discovery contract; exact schema filters remain distinct
   where offered. Choosing a category never inserts an entity.
4. Type characters in a category and press Backspace. Nonempty queries lose one
   character. With an empty query, Backspace returns to its parent menu and
   restores that menu's query. From the slash entry, return through all entities
   to the original slash menu. Backspace immediately after a bare `@` or `/`
   deletes that trigger and closes its menu, preserving preceding prose.
5. Press Escape. The query remains ordinary text, its temporary green styling
   disappears, and the dropdown closes. Starting a fresh query opens it again.
6. Link Project Beta's pUC19 beside ordinary text and another saved chip. Edit
   the adjacent prose, move the cursor, save, close and reopen the notebook.
   Both chips retain their appearance and exact identities. Place the caret
   immediately before and after a chip; require a tiny clearance from its fill.
   Click the new chip and require Beta's sequence, rather than Alpha's
   same-named sequence.
7. Compare notebook mentions, saved references and chat references. Require the
   shared filled chip appearance, leading icon and entity name, with no border
   in the default or hover state. The entity kind appears in hover and keyboard
   focus details, rather than in the chip text. Repeat in both themes.
8. Insert a reference through both `@` and **Link an entity**. Before pressing
   another key, inspect the painted cursor beside the chip on its visual line. A
   paragraph count alone cannot establish the cursor's rendered position. Close
   and reopen the notebook, insert another reference, and press Backspace once.
   No synthetic whitespace is inserted around the chip; normal adjacent text
   deletion and atomic chip deletion follow the editor schema. Require the
   editor's computed whitespace to remain `break-spaces` even when no
   dynamically injected Tiptap style tag exists.
9. Insert a reference at the end of the notebook and use Backspace to remove its
   following space. Press Right repeatedly with no text to the right. Require
   the same cursor position throughout the first frame and the next 250 ms;
   checking only the final position misses a transient jump onto the editor's
   trailing marker. Type immediately afterward and require text in the same
   paragraph, with the reference unchanged. Also check normal Right movement
   across a chip, movement into a following paragraph, Shift-Right selection and
   the existing Backspace behavior.

## Dropdown anchoring while scrolling

Open both @ and / halfway down a long notebook. Scroll the notebook pane, then
any enclosing pane, without typing. Require the popup to remain beside its
inline trigger, not fixed to the screen. Scroll the trigger completely outside
the notebook viewport and require dismissal without deletion of the trigger or
query. Scroll inside the result list and require it to stay open. Repeat after
typing, changing category, loading results and resizing the app. Close/reopen
the notebook and check that no orphan popup or stale scroll listener survives.

The focused `inline-picker-scroll.test.tsx` uses the actual Tiptap, Tippy and
Popper implementations with supplied DOM geometry in jsdom. It proves the event
subscription and lifecycle boundary, not real scrolling or painted placement.
The native computer-use workflow above remains required.

## Picker home and recents

The picker uses one layout without A/B controls. **Browse types** comes first,
followed by at most four recently viewed entities and **All recently viewed**.
The recent submenu returns to its parent with Backspace. Browse presents the
seven shared useful categories, with specific saved schema filters where
applicable. An empty query never lists unfiltered notebook entries. Typing a
saved name directly shows matching entities; typing a class offers category
browse.

Open two entities without editing them. Require recents in viewing order;
revisit the first and require it to move above the second. Editing an already
active entity must not refresh its viewing time. Reload the owned app and
require the history to persist. Rename a target through its normal owner and
require the picker to resolve the fresh name; unavailable targets must be
omitted. Repeat for a Registry preview, a structure file, a saved molecular
document and a saved track view: recents must identify the saved entity rather
than its viewer or underlying reference sequence.

## Entity link coverage

Derive eligible identities from the actual Registry, catalog, current file
bindings and supported legacy primer records. Compare that inventory with every
page of the native discovery service; do not substitute one fixture per type for
a full identity census. Retain explicit scope exclusions and unresolved
ownership. Use a real owned artifact or record for every offered category. Saved
track views and molecular documents require their native creation commands and
actual readable scientific inputs.

For each type: search by exact name, browse its category, insert, save, close
the notebook, reopen it, inspect the exact stored identity and click the chip.
Require the correct project and native content or visible Registry record. A
created tab alone is insufficient: require readable target data and inspect
runtime errors. Include duplicate names in different projects, closed-project
targets, Unicode names, no matches, renamed, archived and deleted targets.
Unavailable targets must retain the saved reference and fail clearly without
opening a similarly named entity. Trace links must load decoded data with native
read-only capabilities.

## Native tables

Create a notebook with a structured table through the notebook authoring tool.
Require the native table block, editable cells and working expanded view. Keep
two saved references and mixed formatting in one cell. Edit another cell, save,
close and reopen. Require exact values, formatting and reference targets in both
inline and expanded views. `/Table` must still use its existing builder.
Selecting a native table must not add ProseMirror's default cyan outline.

## Evidence and boundaries

Keep original before-and-after screenshots outside the checkout. Use computer
use for the human workflow. Record the running checkout, theme and profile.
Inspect runtime errors and failed requests; successful compilation and mocked
tests do not qualify native persistence or navigation. If computer use is
unavailable, record that gap and provide the owned dev preview without claiming
the journey passed.

The path crosses the notebook editor, suggestion controllers, shared discovery
categories, native SQLite search and exact-ID resolution, mention insertion,
saved reference resolution, native notebook persistence and the target viewer.
The focused `mention.inline-authoring.test.tsx` checks real editor transactions
with mocked search providers. `SlashCommandMenu.inline-authoring.test.tsx`
checks the rendered menu. Their passing results do not prove actual project
lookup, native save or target navigation; the steps above cover those
boundaries.

## Discovery and saved relationship acceptance

Use more than 100 records and page until the service returns no continuation.
Require every eligible identity exactly once, including identical local ID
suffixes in different projects, duplicate names, Unicode and literal `%`/`_`.
Continue through `@`, slash linking, and each still-reachable legacy entity
picker. A scope/filter change starts a new query; concurrent entity changes must
produce an explicit refresh state instead of skipping or repeating rows. A
failed lookup must show an error and retry, rather than “no results.”

Insert the same entity twice. Require different saved `occurrenceId` values with
the same target ID. Edit adjacent prose, reorder, retarget, undo and redo;
occurrence identity follows the authored occurrence. Copy/paste creates a fresh
occurrence. Resolve failure during insertion preserves the query and surrounding
prose. Typing or moving the selection while a lookup is pending must not allow a
late response to replace different text or steal the caret.

Read the canonical notebook file and its SQLite projection after Save. The
document and every derived occurrence row must have the same source fingerprint.
Inline table cell links count through their declared content path; arbitrary
embed payloads that resemble mentions do not count. Existing unavailable links
survive unrelated edits. A legacy file is ingested without rewriting it and
reports incomplete occurrence coverage until an app write persists IDs.

Inject a failure in the owned test database during link projection after a file
publication. Require the previous page, link rows and equality receipt to remain
together, while retaining the newly saved file. Require explicit pending/error
status and successful idempotent reconciliation. Never inject failures or repair
ambiguous identities in a person's live database.

# Adding an editable document

Give every editable document a working copy. It owns the current contents, the
recovery representation and the code that writes and reads its saved form. Views
send edits to that owner. Two views sharing a working copy must observe the same
edits. Independent drafts keep separate identities.

Every state the editor accepts must have a recovery representation, including
incomplete input and references to offline files. A genome view can preserve a
reference to a local file, its region and its display settings while the source
drive is disconnected. Publishing or exporting a document can require additional
data. An acknowledged storage error leaves the unsaved edit available.

## Register the editor

Declare the editable tab and its owner module in
`apps/desktop/src/shared/tab-kind.ts`. Register a domain owner through
`useDocumentLifecycle`, or bind a long-lived session to `documentLifecycle`.
Keep the owner available when a drawer closes or a tab moves to the background.

The owner's `readRevision()` identifies the editable contents. It changes when
the owner accepts an edit and stays stable when a write completes or a view
redraws. Read it from the live working copy. A local edit counter or an existing
content identity works. A modified flag cannot distinguish two successive edits.

The owner's save operation succeeds only after storage confirms the captured
edit. Apply that acknowledgement to the matching revision before clearing
recovery data. When the first save replaces an untitled document with its saved
document, return the original published revision after checking that the draft
still matches. If an edit arrived during the write, keep it available for the
next save.

## Verify the contract

Exercise the actual editor. Edit it, quit, choose **Save and Close**, inspect
the bytes on disk and reopen the document in a fresh process. Verify the exact
edited values. Include the editor in the quit coverage for its tab kind.

At the storage boundary, hold a write open, accept another edit, then finish the
first write. Verify the newer edit survives and can be saved. Refuse a write and
verify the existing file and working copy retain their respective contents.

# Tab placement

## Sub-features

Split Right, joining panes, closing one tab and Reopen Closed Tab.

## How to get to it (user POV)

Open two files, right-click a tab and choose Split Right. Use Join All Panes,
close the text tab, then open it again from the file tree. The deterministic
matrix separately exercises Reopen Closed Tab.

## Driving it with native CDP and Vitest

The native helper uses the tab context menu and file-tree controls. The matrix
also moves and reopens each document variant between real canvas panels. The
document identity and editor/save selection must survive even when the tab
instance ID changes.

## Gotchas

Reopening creates a new tab instance and may revalidate a file's load state.
Compare document identity and resolved save target instead of requiring an old
tab ID. Closing an empty pane may remove that pane.

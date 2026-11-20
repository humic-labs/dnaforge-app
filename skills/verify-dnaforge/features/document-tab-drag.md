# Document tab dragging

In an isolated desktop development window, open three distinct documents from
the file explorer. Record the tab row and the top of the document area while
performing these gestures.

1. Press the first tab off center and keep the mouse button down. Move a short
   distance horizontally. The same point on the tab should stay under the
   pointer, with the tab at its original height in the row.
2. Continue across two neighbors. They should slide into the space behind the
   held tab. Reverse direction and release at the original press point. The
   three documents should be in their original order.
3. Repeat and release after crossing one neighbor. The resulting order should
   match the last preview. Repeat from the right toward the left.
4. While holding a tab, move down into the document. The floating preview and
   pane drop highlight should appear. Return to the source row before release.
   The floating preview should disappear and horizontal sliding should resume.
5. Drag the middle tab to the right edge of the document area and release. The
   new pane should contain that document. Drag it from the new pane into the
   gap between the other two tabs. All three should be together in the chosen
   order, with a single copy of each document.

In Playwright, locate the row by `[data-tab-bar]` and its tabs by role. Read each
tab's bounding rectangle before the press, while holding, and after release.
Use the tab labels and their containing rows to check the final order. Capture
the held gesture on video so the grab point, neighbor motion and transition
between the two drag modes are visible.

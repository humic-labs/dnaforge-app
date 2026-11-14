# Table insertion and editing with the keyboard

## Sub-features

- Slash command insertion automatically focuses row entry.
- Tab and Shift+Tab move between row and column entry after initial focus is
  consumed.
- Enter creates the requested dimensions and hands focus to the first cell.
- Cell typing, navigation, Save and reopen preserve the expected values.
- Escape from dimension entry returns keyboard control to the notebook.
- Ctrl+Tab and Ctrl+Shift+Tab switch within the focused pane while notebook text
  or a cell editor has focus.

## How to get to it (user POV)

Open a notebook, place the caret in its body, type `/table` and choose Table
with Enter. Enter row and column counts without clicking. Confirm and start
writing in the first cell.

## Driving it with Playwright

`node apps/desktop/scripts/check-table-editor.mjs --out /absolute/durable/evidence-directory`
runs the maintained driver against an already owned development preview. Native
document commands create the fixture and inspect its working copy and saved
revision. Keyboard events perform the actions under test.

The component regressions are `InlineConfig.keyboard.test.tsx` and
`Renderer.keyboard.test.tsx`. `slash-table.keyboard.test.tsx` exercises the real
editor's slash insertion and table configuration.
`TableGrid.render-isolation.test.tsx` prevents draft typing and navigation from
recomputing unrelated cell presentations.
`useKeyboardNav.ref-lifecycle.test.tsx` protects ref identity through detach and
reattachment. `Panel.tab-cycling.test.tsx` drives shared tab navigation across
all registered tab types, including editable and terminal targets. The live
command verifies the user path across the editor and native document owner, then
checks native tab switching from notebook text and a cell input.

## Gotchas

Use a native notebook package for persistence proof. Legacy `seedTablePage`
notebooks are useful for isolated render measurements but may have no native
package and cannot qualify a native Save or reopen.

Measure responsiveness with matching table sizes and the same inline or expanded
view. Ghost rows and columns increase rendered cell count. Preserve draft typing
and commit timings separately so native persistence does not hide a rendering
problem.

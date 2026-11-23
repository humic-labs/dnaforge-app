# Desktop UI styling guide

## Buttons and toolbar actions have no outline at rest

**Do not add a visible border, stroke or outline around an idle button.** Use
the shared neutral fill for secondary actions and the shared accent fill for
primary actions. Keep toolbar actions compact. On a tinted toolbar, check the
fill against the actual background in both themes before proposing a change.

Keep keyboard focus visible. An editable field may show a thin line while it
has focus. Neither treatment gives a button a permanent outline.

Use the desktop [shared controls](../apps/desktop/src/components/ui/controls.tsx)
and their [button styles](../apps/desktop/src/components/ui/styles.ts).
The compact toolbar button uses the
[appbar action style](../apps/desktop/src/index.css). For menus and pickers,
see [appearance ownership](../packages/ui/components/src/menu/appearance-owners.md).

# Menu presentation

[`appearance.ts`](./appearance.ts) owns density metrics.
[`menu.css`](./menu.css) owns the surface, slots and interaction colors.
[`presentation.tsx`](./presentation.tsx) exposes the React controls. Hosts
supply positioning and presentation ownership; render one `MenuSurface` per
popup. A host adapter that already renders that surface takes its density and
slot flags directly. Do not nest a second surface around its rows.

Surfaces and controls reject `className` and `style`, including runtime props.
Use the surface's `layout` for position, dimensions, scrolling and visibility.
Its accepted keys exclude padding, borders, colors, fonts and shadows. Use
`content="menu"` for rows, `content="panel"` for rich content with its own inner
layout, and `content="form"` for a settings form. Geometry animations use
`motionMs`; their transition properties come from the shared surface. Notebook
suggestions use `surface="workspace"` to match the Files panel's opaque
background without an outlined edge. Its colors remain in `menu.css`.

| Density   | Minimum control height | Text size | Icon slot |
| --------- | ---------------------: | --------: | --------: |
| `compact` |                  28 px |     12 px |     16 px |
| `form`    |                  36 px |     13 px |     16 px |
| `touch`   |                  44 px |     14 px |     20 px |

`MenuTrigger` uses `variant="field"` for a full-width field and
`variant="toolbar"` for an intrinsic-width toolbar control. An icon-only trigger
needs an accessible name. `MenuSearchInput` shares the field geometry and
accepts native input properties. `MenuNativeSelect` shares the field shell and
caret while preserving the browser's native option popup.

Fields rest on a gray fill with a transparent border. Editing, keyboard focus or
an open dropdown adds one thin border inside the reserved space, without an
outer halo. Readonly and disabled fields remain strokeless. The light and dark
field fills retain the shared neutral control theme; toolbar triggers remain
transparent while idle.

```tsx
import { MenuTrigger } from '@waypoint/ui-components';

<MenuTrigger
  ref={anchorRef}
  density="compact"
  variant="toolbar"
  icon={layoutIcon}
  iconOnly
  open={menu.isOpen}
  aria-label="Page layout"
  aria-haspopup="menu"
  onClick={() => (menu.isOpen ? menu.close('trigger') : menu.openMenu())}
/>;
```

`MenuRow` owns all row geometry. Its children are the label; optional `icon`,
`description`, `shortcut` and `submenu` properties populate the other slots. Set
`icons`, `shortcuts` and `submenus` on the surface when any row needs those
slots. `selection` defaults to `true`; set it to `false` for action-only menus.
The selection slot remains mounted when a row is unselected. Labels therefore
retain their position as the value changes.

```tsx
import {
  MenuRow,
  MenuSeparator,
  MenuStatus,
  MenuSurface,
} from '@waypoint/ui-components';

<MenuSurface
  role="menu"
  aria-label="File actions"
  density="compact"
  selection={false}
  shortcuts
>
  <MenuRow role="menuitem" shortcut="Ctrl+O" onClick={openFile}>
    Open
  </MenuRow>
  <MenuSeparator />
  <MenuRow
    role="menuitem"
    tone="danger"
    disabled={readOnly}
    onClick={removeFile}
  >
    Remove
  </MenuRow>
  {loading ? <MenuStatus>Loading…</MenuStatus> : null}
</MenuSurface>;
```

`active` identifies the row under keyboard or pointer navigation. `selected`
identifies the committed value. Neither implies the other. Native
`:focus-visible` supplies the focus outline, and native `disabled` prevents
activation and interactive fills. Choose the correct native role and
`aria-selected` or `aria-checked` in the adapter. Use [`useMenu`](./use-menu.ts)
and its [`state transition contract`](./menu-state.ts) for navigation and
dismissal.

`MenuLink` uses the same slots and states with a native anchor, retaining normal
link navigation, new-tab and middle-click behavior. `disabled` removes its href
and focus stop. `MenuRowGroup` and `MenuRowAction` pair a row with a separate
companion action without nesting buttons. `MenuSectionLabel` supplies a
noninteractive section caption.

Row and trigger APIs do not accept `className` or `style`, and strip them at
runtime. Keep feature content inside their slots. Surface layout belongs to the
host: width, viewport limits and position. Surface border, shadow, padding and
colors belong to this module. Use `content="panel"` for rich picker panels whose
content owns internal layout; this keeps the common chrome and removes the list
inset.

## Ordinary interactive controls

`INTERACTION_CLASS` supplies neutral hover, pressed, focus and disabled states
without setting a control's dimensions or resting colors. It reads the host's
existing `--color-bg-muted`, `--color-fg`, `--color-border-hover`,
`--color-accent`, `--color-accent-subtle` and `--color-error` theme variables.
Dark themes change those variables rather than adding another hover recipe.

```tsx
import { INTERACTION_CLASS } from '@waypoint/ui-components';

<button
  className={`${INTERACTION_CLASS} rounded border border-border px-3 py-2`}
  data-interaction-border="true"
  disabled={saving}
  onClick={save}
>
  Save
</button>;
```

Use `data-selected` for committed selection, `data-active` for navigation,
`data-interaction-border` for an outlined control's hover border, and
`data-interaction-group` when a compound row should highlight while a child has
focus. `data-tone="danger"` selects the destructive hover color.

Scientific diagrams, value-encoded colors, canvas rendering and operating system
menus retain their domain rendering. A rich scientific picker can apply the
ordinary interaction class to its row while keeping its diagram and virtualized
row dimensions. Primary actions, status-tinted notices and scientific selection
colors are distinct semantic cases; do not replace them with a neutral
background solely because they react to a pointer.

## Host theme adapters

The focused `@waypoint/ui-components/menu` entry point exposes this module
without loading scientific components. The stylesheet is also exported at
`@waypoint/ui-components/menu.css` for hosts that import global CSS explicitly.

The desktop defaults use HSL channel theme variables. A host with a different
color representation supplies `--menu-background`, `--menu-foreground`,
`--menu-muted-foreground`, `--menu-subtle-foreground`, `--menu-border` and
`--menu-danger`, plus the `--interaction-*` tokens defined in `menu.css`. These
adapters change token values, not control selectors or geometry.

Compound rows use `data-interaction-cover` on foreground pieces that must cover
text behind them; their ancestor sets `data-interaction-group="true"`. Both
pieces read the same hover color. Drag targets with `data-drop-active` retain
their drag feedback instead of ordinary hover or selection fills.

[Appearance ownership and rendering exceptions](./appearance-owners.md) lists
the adapters and the domain visuals that retain their own rendering.

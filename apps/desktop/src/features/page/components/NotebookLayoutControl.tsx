import { useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { MenuRow, MenuTrigger, useMenu } from '@waypoint/ui-components';
import { PortalMenu } from '../../../components/PortalMenu';
import { safeFocus } from '../../../shared/utils/safeFocus';
import {
  getNotebookLayout,
  NOTEBOOK_LAYOUTS,
  type NotebookLayoutChoice,
} from '../editor/extensions/notebook-layout';
import './notebook-layout.css';

const choices = [{ id: 'single-column', label: 'One column' }, ...NOTEBOOK_LAYOUTS] as const;
const menuItems = choices.map(({ id, label }) => ({
  id,
  textValue: label,
  closeOnActivate: false,
}));

function readLayoutState(editor: Editor) {
  return {
    layout: getNotebookLayout(editor.state),
    editable: editor.isEditable,
    available: editor.can().setNotebookLayout('two-columns'),
  };
}

function LayoutIcon({ layout }: { layout: NotebookLayoutChoice }) {
  const columns = {
    'single-column': [[3, 18]],
    'two-columns': [
      [3, 8],
      [13, 8],
    ],
    'three-columns': [
      [3, 5],
      [9.5, 5],
      [16, 5],
    ],
    'wide-left': [
      [3, 11],
      [16, 5],
    ],
    'wide-right': [
      [3, 5],
      [10, 11],
    ],
  }[layout];
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
      data-layout-icon={layout}
    >
      {columns.map(([x, width]) => (
        <rect key={x} x={x} y="4" width={width} height="16" rx="1" />
      ))}
    </svg>
  );
}

export function NotebookLayoutControl({ editor }: { editor: Editor }) {
  const [state, setState] = useState(() => readLayoutState(editor));
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const disabled = !state.editable || !state.available;
  const menu = useMenu({
    items: disabled ? [] : menuItems,
    selectedId: state.layout,
    onActivate: (id) => {
      menu.close('handoff');
      editor
        .chain()
        .focus()
        .setNotebookLayout(id as NotebookLayoutChoice)
        .run();
    },
    onFocusItem: (id) =>
      safeFocus(menuRef.current?.querySelector<HTMLButtonElement>(`[data-menu-item-id="${id}"]`)),
  });

  useEffect(() => {
    const update = () => setState(readLayoutState(editor));
    editor.on('transaction', update);
    editor.on('update', update);
    update();
    return () => {
      editor.off('transaction', update);
      editor.off('update', update);
    };
  }, [editor]);

  useEffect(() => {
    if (disabled) menu.close('owner-revoked');
  }, [disabled, menu.close]);

  return (
    <>
      <MenuTrigger
        ref={triggerRef}
        variant="toolbar"
        density="compact"
        iconOnly
        icon={<LayoutIcon layout={state.layout} />}
        aria-label="Notebook layout"
        aria-haspopup="menu"
        aria-expanded={menu.isOpen}
        title={`Notebook layout: ${choices.find(({ id }) => id === state.layout)?.label}`}
        data-value={state.layout}
        disabled={disabled}
        open={menu.isOpen}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => (menu.isOpen ? menu.close('trigger') : menu.openMenu(state.layout))}
        onKeyDown={menu.handleKeyDown}
      />
      <PortalMenu
        density="compact"
        selection
        icons
        menu={menu}
        open={menu.isOpen}
        anchorRef={triggerRef}
        surfaceRef={menuRef}
        onRequestClose={menu.close}
        role="menu"
        aria-label="Notebook layout"
        horizontalAlign="start"
        preferredSide="bottom"
      >
        {choices.map(({ id, label }) => (
          <MenuRow
            key={id}
            role="menuitemradio"
            aria-checked={state.layout === id}
            data-menu-item-id={id}
            active={menu.activeId === id}
            selected={state.layout === id}
            icon={<LayoutIcon layout={id} />}
            tabIndex={menu.activeId === id ? 0 : -1}
            onPointerMove={() => menu.point(id)}
            onClick={() => menu.activate(id)}
          >
            {label}
          </MenuRow>
        ))}
      </PortalMenu>
    </>
  );
}

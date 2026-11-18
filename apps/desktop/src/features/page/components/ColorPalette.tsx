import { useEffect, useRef, type ReactNode } from 'react';
import { MenuTrigger, MenuRow, useMenu } from '@waypoint/ui-components';
import { PortalMenu } from '@/components/PortalMenu';
import { safeFocus } from '@/shared/utils/safeFocus';

export function ColorPalette({
  label,
  colors,
  value,
  onPick,
  onClear,
  disabled = false,
  testId,
  children,
}: {
  label: string;
  colors: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  value?: string | null;
  onPick: (color: string) => void;
  onClear: () => void;
  disabled?: boolean;
  testId?: string;
  children?: ReactNode;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const items = [
    ...colors.map((color) => ({
      id: `color:${color.value}`,
      textValue: color.name,
      closeOnActivate: false,
    })),
    { id: 'clear', textValue: 'Reset color', closeOnActivate: false },
  ];
  const menu = useMenu({
    items,
    selectedId: value ? `color:${value}` : null,
    onFocusItem: (id) => safeFocus(rows.current.get(id)),
    onActivate: (id) => {
      menu.close('handoff');
      if (id === 'clear') onClear();
      else {
        const color = colors.find((candidate) => `color:${candidate.value}` === id);
        if (color) onPick(color.value);
      }
    },
  });
  const closeMenu = menu.close;
  useEffect(() => {
    if (disabled) closeMenu('owner-revoked');
  }, [disabled, closeMenu]);

  return (
    <>
      <MenuTrigger
        ref={triggerRef}
        variant="toolbar"
        iconOnly
        icon={children ? <span className="flex flex-col items-center">{children}</span> : undefined}
        disabled={disabled}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        open={menu.isOpen}
        data-testid={testId}
        onClick={() => (menu.isOpen ? menu.close('trigger') : menu.openMenu())}
        onKeyDown={menu.handleKeyDown}
      />
      <PortalMenu
        open={menu.isOpen && !disabled}
        menu={menu}
        anchorRef={triggerRef}
        onRequestClose={menu.close}
        role="menu"
        aria-label={label}
        horizontalAlign="start"
        preferredSide="bottom"
        selection={false}
      >
        <div
          onKeyDown={(event) => {
            if (event.defaultPrevented || event.nativeEvent.isComposing) return;
            const index = items.findIndex((item) => item.id === menu.activeId);
            if (index < 0) return;
            let next: number;
            switch (event.key) {
              case 'ArrowRight':
                next = (index + 1) % items.length;
                break;
              case 'ArrowLeft':
                next = (index - 1 + items.length) % items.length;
                break;
              case 'ArrowDown':
                next = Math.min(index + 4, items.length - 1);
                break;
              case 'ArrowUp':
                next = Math.max(index - 4, 0);
                break;
              default:
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            menu.move('next', 'root', { itemIds: [items[index].id, items[next].id] });
          }}
        >
          <div className="grid grid-cols-4 gap-1.5 p-1">
            {colors.map((color) => {
              const id = `color:${color.value}`;
              return (
                <button
                  key={id}
                  ref={(node) => {
                    if (node) rows.current.set(id, node);
                    else rows.current.delete(id);
                  }}
                  type="button"
                  role="menuitemradio"
                  aria-label={color.name}
                  aria-checked={value === color.value}
                  data-active={menu.activeId === id}
                  tabIndex={menu.activeId === id ? 0 : -1}
                  title={color.name}
                  data-testid={
                    testId
                      ? `${testId.replace(/-colors$/, '')}-${color.name.toLowerCase()}`
                      : undefined
                  }
                  className="h-6 w-6 rounded-sm border border-border hover:border-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  style={{ backgroundColor: color.value }}
                  onFocus={() => menu.point(id)}
                  onClick={() => menu.activate(id)}
                />
              );
            })}
          </div>
          <MenuRow
            ref={(node) => {
              if (node) rows.current.set('clear', node);
              else rows.current.delete('clear');
            }}
            role="menuitem"
            active={menu.activeId === 'clear'}
            tabIndex={menu.activeId === 'clear' ? 0 : -1}
            aria-label={`Remove ${label === 'Highlight color' ? 'highlight' : label.toLowerCase()}`}
            data-testid={testId ? `${testId.replace(/-colors$/, '')}-none` : undefined}
            onFocus={() => menu.point('clear')}
            onClick={() => menu.activate('clear')}
          >
            Reset color
          </MenuRow>
        </div>
      </PortalMenu>
    </>
  );
}

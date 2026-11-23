'use client';

import { UI_FIELD_CLASS } from '../../../../../components/ui/styles';
import { memo, useRef } from 'react';
import { MenuRow, MenuTrigger, useMenu } from '@waypoint/ui-components';
import { PortalMenu } from '@/components/PortalMenu';
import { safeFocus } from '@/shared/utils/safeFocus';
import type { ViewRecipe } from '../types';
import type { ProteinExtensionView } from '../hooks/useProteinExtensionView';

interface ViewRecipeDropdownProps {
  activeRecipeId: string | null;
  activeRecipeNameFallback?: string;
  recipes: ViewRecipe[];
  extensions?: ProteinExtensionView;
  onSelectRecipe: (recipe: ViewRecipe) => void;
  layout: 'sidebar' | 'bar';
}

export const ViewRecipeDropdown = memo(function ViewRecipeDropdown({
  activeRecipeId,
  activeRecipeNameFallback,
  recipes,
  extensions,
  onSelectRecipe,
  layout,
}: ViewRecipeDropdownProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeId = extensions?.active ?? activeRecipeId;
  const options = recipes.map(({ id, name }) => ({ id, textValue: name }));
  if (extensions) {
    if (!recipes.length) options.push({ id: 'native-scene', textValue: 'Scene' });
    for (const { id, label } of extensions.installed) options.push({ id, textValue: label });
  }
  const removal = extensions?.installed.find(({ id }) => id === extensions.selectedId);
  const actions = extensions
    ? [
        { id: 'install', textValue: 'Install protein extension…' },
        ...(removal ? [{ id: 'uninstall', textValue: 'Uninstall ' + removal.label }] : []),
      ]
    : [];
  const menu = useMenu({
    items: [...options, ...actions],
    selectedId: activeId,
    onActivate: (id) => {
      if (id === 'install') return inputRef.current?.click();
      if (id === 'uninstall' && removal) {
        void extensions?.uninstall(removal.id);
        return;
      }
      const recipe = recipes.find((candidate) => candidate.id === id);
      if (recipe) {
        extensions?.select(null);
        onSelectRecipe(recipe);
      } else {
        extensions?.select(id === 'native-scene' ? null : id);
      }
    },
    onFocusItem: (id) =>
      safeFocus(
        menuRef.current?.querySelector<HTMLButtonElement>(`[data-menu-item-id="${CSS.escape(id)}"]`)
      ),
  });
  const activeRecipeName =
    options.find((option) => option.id === activeId)?.textValue ??
    activeRecipeNameFallback ??
    'Custom';
  const sidebar = layout === 'sidebar';

  return (
    <div className={sidebar ? 'flex flex-col gap-1 min-w-0' : 'flex items-center gap-2 min-w-0'}>
      <span
        className={
          sidebar ? 'text-[10px] text-fg-muted uppercase tracking-wide' : 'text-xs text-fg-muted'
        }
      >
        {sidebar ? 'View' : 'View:'}
      </span>
      <MenuTrigger
        ref={triggerRef}
        density="compact"
        aria-label="Structure view"
        aria-haspopup="menu"
        aria-expanded={menu.isOpen}
        open={menu.isOpen}
        disabled={!extensions && !recipes.length}
        onClick={() => (menu.isOpen ? menu.close('trigger') : menu.openMenu(activeId))}
        onKeyDown={menu.handleKeyDown}
        data-testid="structure-view-recipe-trigger"
      >
        <span className={activeId ? undefined : 'text-warning'}>{activeRecipeName}</span>
      </MenuTrigger>
      <PortalMenu
        density="compact"
        selection
        menu={menu}
        open={menu.isOpen}
        anchorRef={triggerRef}
        surfaceRef={menuRef}
        onRequestClose={menu.close}
        role="menu"
        aria-label="Structure view"
        data-testid="structure-view-recipe-menu"
        horizontalAlign="start"
        preferredSide={sidebar ? 'bottom' : 'top'}
      >
        {options.map((recipe) => (
          <MenuRow
            key={recipe.id}
            role="menuitemradio"
            aria-checked={recipe.id === activeId}
            selected={recipe.id === activeId}
            active={menu.activeId === recipe.id}
            tabIndex={menu.activeId === recipe.id ? 0 : -1}
            data-menu-item-id={recipe.id}
            data-testid={`structure-view-recipe-option-${recipe.id}`}
            onPointerMove={() => menu.point(recipe.id)}
            onClick={() => menu.activate(recipe.id)}
          >
            {recipe.textValue}
          </MenuRow>
        ))}
        {actions.map((action) => (
          <MenuRow
            key={action.id}
            role="menuitem"
            active={menu.activeId === action.id}
            tabIndex={menu.activeId === action.id ? 0 : -1}
            data-menu-item-id={action.id}
            onPointerMove={() => menu.point(action.id)}
            onClick={() => menu.activate(action.id)}
          >
            {action.textValue}
          </MenuRow>
        ))}
      </PortalMenu>
      {extensions && (
        <>
          <input
            type="file"
            className={UI_FIELD_CLASS}
            hidden
            ref={inputRef}
            accept=".json"
            aria-label="Install protein extension"
            data-testid="install-protein-extension-file"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              if (file) void extensions.install(file);
            }}
          />
          {extensions.pending && (
            <span role="status" className="text-xs text-fg-muted">
              Applying extension…
            </span>
          )}
          {extensions.error && (
            <span role="alert" className="text-xs text-warning">
              {extensions.error}
            </span>
          )}
        </>
      )}
    </div>
  );
});

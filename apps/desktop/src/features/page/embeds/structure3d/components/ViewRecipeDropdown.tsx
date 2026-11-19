'use client';

import { memo, useRef } from 'react';
import { MenuRow, MenuTrigger, useMenu } from '@waypoint/ui-components';
import { PortalMenu } from '@/components/PortalMenu';
import { safeFocus } from '@/shared/utils/safeFocus';
import type { ViewRecipe } from '../types';

interface ViewRecipeDropdownProps {
  activeRecipeId: string | null;
  activeRecipeNameFallback?: string;
  recipes: ViewRecipe[];
  onSelectRecipe: (recipe: ViewRecipe) => void;
  layout: 'sidebar' | 'bar';
}

export const ViewRecipeDropdown = memo(function ViewRecipeDropdown({
  activeRecipeId,
  activeRecipeNameFallback,
  recipes,
  onSelectRecipe,
  layout,
}: ViewRecipeDropdownProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menu = useMenu({
    items: recipes.map((recipe) => ({ id: recipe.id, textValue: recipe.name })),
    selectedId: activeRecipeId,
    onActivate: (id) => {
      const recipe = recipes.find((candidate) => candidate.id === id);
      if (recipe) onSelectRecipe(recipe);
    },
    onFocusItem: (id) =>
      safeFocus(
        menuRef.current?.querySelector<HTMLButtonElement>(`[data-menu-item-id="${CSS.escape(id)}"]`)
      ),
  });
  const activeRecipeName = activeRecipeId
    ? recipes.find((recipe) => recipe.id === activeRecipeId)?.name ||
      activeRecipeNameFallback ||
      'Custom'
    : 'Custom';
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
        disabled={recipes.length === 0}
        onClick={() => (menu.isOpen ? menu.close('trigger') : menu.openMenu(activeRecipeId))}
        onKeyDown={menu.handleKeyDown}
        data-testid="structure-view-recipe-trigger"
      >
        <span className={activeRecipeId ? undefined : 'text-warning'}>{activeRecipeName}</span>
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
        {recipes.map((recipe) => (
          <MenuRow
            key={recipe.id}
            role="menuitemradio"
            aria-checked={recipe.id === activeRecipeId}
            selected={recipe.id === activeRecipeId}
            active={menu.activeId === recipe.id}
            tabIndex={menu.activeId === recipe.id ? 0 : -1}
            data-menu-item-id={recipe.id}
            data-testid={`structure-view-recipe-option-${recipe.id}`}
            onPointerMove={() => menu.point(recipe.id)}
            onClick={() => menu.activate(recipe.id)}
          >
            {recipe.name}
          </MenuRow>
        ))}
      </PortalMenu>
    </div>
  );
});

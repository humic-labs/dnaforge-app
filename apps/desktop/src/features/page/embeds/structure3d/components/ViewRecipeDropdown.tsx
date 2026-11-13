'use client';

import { memo, useState, useRef, useEffect, useCallback } from 'react';
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
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => {
    setIsOpen(false);
    safeFocus(triggerRef.current, { preventScroll: true });
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const frame = requestAnimationFrame(() =>
      safeFocus(
        menuRef.current?.querySelector<HTMLElement>('[aria-checked="true"]') ??
          menuRef.current?.querySelector<HTMLElement>('[role="menuitemradio"]')
      )
    );
    return () => cancelAnimationFrame(frame);
  }, [isOpen]);

  const activeRecipeName = activeRecipeId
    ? recipes.find((recipe) => recipe.id === activeRecipeId)?.name ||
      activeRecipeNameFallback ||
      'Custom'
    : 'Custom';
  const isCustom = !activeRecipeId;
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
      <button
        ref={triggerRef}
        type="button"
        aria-label="Structure view"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        disabled={recipes.length === 0}
        onClick={() => setIsOpen((open) => !open)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setIsOpen(true);
          } else if (event.key === 'Escape' && isOpen) {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
        }}
        data-testid="structure-view-recipe-trigger"
        className={`min-w-0 text-xs px-2 py-1 rounded-md border bg-bg text-fg text-left flex items-center justify-between gap-1.5 hover:border-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50 ${
          sidebar ? 'w-full' : ''
        } ${isCustom ? 'border-warning/50 text-warning' : 'border-border'}`}
      >
        <span className="truncate">{activeRecipeName}</span>
        <svg
          className={`w-3 h-3 shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          viewBox="0 0 12 12"
          fill="currentColor"
        >
          <path d="M6 8L2 4h8L6 8z" />
        </svg>
      </button>
      <PortalMenu
        open={isOpen}
        anchorRef={triggerRef}
        surfaceRef={menuRef}
        onRequestClose={close}
        role="menu"
        aria-label="Structure view"
        data-testid="structure-view-recipe-menu"
        horizontalAlign="start"
        preferredSide={sidebar ? 'bottom' : 'top'}
        className="min-w-[160px] py-1"
      >
        <div
          onKeyDown={(event) => {
            const options = Array.from(
              menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []
            );
            const index = options.indexOf(document.activeElement as HTMLElement);
            let next: number;
            switch (event.key) {
              case 'ArrowDown':
                next = (index + 1) % options.length;
                break;
              case 'ArrowUp':
                next = (index - 1 + options.length) % options.length;
                break;
              case 'Home':
                next = 0;
                break;
              case 'End':
                next = options.length - 1;
                break;
              case 'Escape':
                event.preventDefault();
                event.stopPropagation();
                close();
                return;
              case 'Tab':
                setIsOpen(false);
                return;
              default:
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            safeFocus(options[next]);
          }}
        >
          {recipes.map((recipe) => (
            <RecipeOption
              key={recipe.id}
              recipe={recipe}
              isActive={recipe.id === activeRecipeId}
              onClick={() => {
                onSelectRecipe(recipe);
                close();
              }}
            />
          ))}
        </div>
      </PortalMenu>
    </div>
  );
});

function RecipeOption({
  recipe,
  isActive,
  onClick,
}: {
  recipe: ViewRecipe;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={isActive}
      onClick={onClick}
      data-testid={`structure-view-recipe-option-${recipe.id}`}
      className={`w-full px-2 py-1 text-xs text-left flex items-center gap-1.5 focus-visible:outline-none focus-visible:bg-bg-muted focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent ${
        isActive ? 'bg-accent/10 text-accent' : 'text-fg hover:bg-bg-muted'
      }`}
    >
      {isActive && <CheckIcon />}
      <span className={isActive ? '' : 'pl-4'}>{recipe.name}</span>
    </button>
  );
}

function CheckIcon() {
  return (
    <svg className="w-3 h-3 shrink-0" viewBox="0 0 12 12" fill="none" stroke="currentColor">
      <path d="M2 6l2.5 2.5L10 3" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

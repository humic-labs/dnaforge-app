import { forwardRef } from 'react';
import type { ButtonHTMLAttributes } from 'react';
import { PlusIcon } from './icons';

type ExplorerAddButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'>;

export const ExplorerAddButton = forwardRef<HTMLButtonElement, ExplorerAddButtonProps>(
  function ExplorerAddButton({ className = '', ...props }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        aria-label="New…"
        className={`inline-flex h-7 w-7 items-center justify-center rounded-sm text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${className}`}
        {...props}
      >
        <PlusIcon className="h-3.5 w-3.5" />
      </button>
    );
  }
);

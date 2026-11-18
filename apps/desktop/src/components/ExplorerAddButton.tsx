import { forwardRef } from 'react';
import type { ButtonHTMLAttributes } from 'react';
import { PlusIcon } from './icons';
import { INTERACTION_CLASS } from '@waypoint/ui-components';

type ExplorerAddButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'>;

export const ExplorerAddButton = forwardRef<HTMLButtonElement, ExplorerAddButtonProps>(
  function ExplorerAddButton({ className = '', ...props }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        aria-label="New…"
        className={`${INTERACTION_CLASS} inline-flex h-7 w-7 items-center justify-center rounded-sm text-fg-muted ${className}`}
        {...props}
      >
        <PlusIcon className="h-3.5 w-3.5" />
      </button>
    );
  }
);

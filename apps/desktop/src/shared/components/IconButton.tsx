import { forwardRef } from 'react';
import { cn } from '../lib/cn';
import { Tooltip } from './Tooltip';

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: React.ReactNode;
  label: string;
  size?: 'sm' | 'md';
  variant?: 'default' | 'ghost';
  showTooltip?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  (
    { className, icon, label, size = 'md', variant = 'default', showTooltip = true, ...props },
    ref
  ) => {
    const sizes = {
      sm: 'h-8 w-8',
      md: 'h-10 w-10',
    };

    const variants = {
      default: 'border border-border hover:bg-bg-muted hover:border-border-hover',
      ghost: 'hover:bg-bg-muted',
    };

    const button = (
      <button
        ref={ref}
        aria-label={label}
        className={cn(
          'inline-flex items-center justify-center rounded-full',
          'text-fg-muted hover:text-fg',
          'transition-colors duration-fast ease-out',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2',
          'disabled:opacity-50 disabled:pointer-events-none',
          sizes[size],
          variants[variant],
          className
        )}
        {...props}
      >
        {icon}
      </button>
    );

    return showTooltip ? <Tooltip content={label}>{button}</Tooltip> : button;
  }
);

IconButton.displayName = 'IconButton';

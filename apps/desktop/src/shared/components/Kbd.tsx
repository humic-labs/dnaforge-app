import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface KbdProps {
  children: React.ReactNode;
  className?: string;
}

function Symbol({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="13"
      height="13"
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="block shrink-0"
    >
      {children}
    </svg>
  );
}

const SYMBOLS: Record<string, ReactNode> = {
  '⌘': (
    <Symbol>
      <path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3" />
    </Symbol>
  ),
  '⇧': (
    <Symbol>
      <path d="M12 19V9M12 9 7 14M12 9l5 5" />
      <path d="M8 19h8" />
    </Symbol>
  ),
  '⌥': (
    <Symbol>
      <path d="M3 8h6l6 10h6" />
      <path d="M14 8h7" />
    </Symbol>
  ),
  '⌃': (
    <Symbol>
      <path d="m6 14 6-6 6 6" />
    </Symbol>
  ),
  '↩': (
    <Symbol>
      <path d="M9 10 4 15l5 5" />
      <path d="M20 4v7a4 4 0 0 1-4 4H4" />
    </Symbol>
  ),
  '⌫': (
    <Symbol>
      <path d="M10 5h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-8L4 12l6-7Z" />
      <path d="m12 9 6 6M18 9l-6 6" />
    </Symbol>
  ),
  '⎋': (
    <Symbol>
      <path d="M9 6H5v12h4" />
      <path d="M14 9h6M16 7l4 2-4 2" />
    </Symbol>
  ),
  '⇥': (
    <Symbol>
      <path d="M5 12h11" />
      <path d="m12 7 5 5-5 5" />
      <path d="M19 5v14" />
    </Symbol>
  ),
  '␣': (
    <Symbol>
      <path d="M5 9v5h14V9" />
    </Symbol>
  ),
  '↑': (
    <Symbol>
      <path d="M12 19V5" />
      <path d="m6 11 6-6 6 6" />
    </Symbol>
  ),
  '↓': (
    <Symbol>
      <path d="M12 5v14" />
      <path d="m6 13 6 6 6-6" />
    </Symbol>
  ),
  '←': (
    <Symbol>
      <path d="M19 12H5" />
      <path d="m11 6-6 6 6 6" />
    </Symbol>
  ),
  '→': (
    <Symbol>
      <path d="M5 12h14" />
      <path d="m13 6 6 6-6 6" />
    </Symbol>
  ),
  '–': (
    <Symbol>
      <path d="M5 12h14" />
    </Symbol>
  ),
  '−': (
    <Symbol>
      <path d="M5 12h14" />
    </Symbol>
  ),
};

function KeyFace({ children }: { children: React.ReactNode }) {
  if (typeof children !== 'string') return children;
  return (
    <span className="inline-flex items-center justify-center">
      {[...children].map((character, index) => {
        const symbol = SYMBOLS[character];
        if (symbol) {
          return (
            <span key={index} className="inline-flex items-center justify-center">
              {symbol}
            </span>
          );
        }
        return (
          <span key={index} className="inline-flex h-3 items-center justify-center leading-none">
            {character}
          </span>
        );
      })}
    </span>
  );
}

export function Kbd({ children, className }: KbdProps) {
  return (
    <kbd
      className={cn(
        'inline-flex items-center justify-center align-middle',
        'box-border h-6 min-w-6 px-1',
        'font-sans text-[11px] font-medium leading-none',
        'bg-bg-muted text-fg-muted',
        'border border-border rounded-md',
        className
      )}
    >
      <KeyFace>{children}</KeyFace>
    </kbd>
  );
}

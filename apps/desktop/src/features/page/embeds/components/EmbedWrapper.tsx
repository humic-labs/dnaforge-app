'use client';

import type { ReactNode } from 'react';

interface EmbedWrapperProps {
  type: string;
  label: ReactNode;
  selected: boolean;
  onRemove: () => void;
  onExpand?: () => void;
  children: ReactNode;
}

export function EmbedWrapper({
  type,
  label,
  selected,
  onRemove,
  onExpand,
  children,
}: EmbedWrapperProps) {
  return (
    <div
      data-embed-type={type}
      className={`border rounded-lg overflow-clip my-2 transition-colors ${
        selected ? 'ring-2 ring-accent border-accent' : 'border-border'
      }`}
    >
      {}
      <div className="tab-chrome-surface flex items-center justify-between px-3 py-2 border-b border-border select-none">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-medium text-fg-muted uppercase tracking-wide shrink-0">
            {type}
          </span>
          <span className="text-sm font-medium truncate">{label}</span>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {onExpand && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onExpand();
              }}
              className="p-1 text-fg-muted hover:text-fg rounded hover:bg-bg-muted transition-colors"
              title="Open in panel"
              aria-label="Open in panel"
            >
              <ExpandIcon className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            className="p-1 text-fg-muted hover:text-error rounded hover:bg-bg-muted transition-colors"
            title="Remove"
            aria-label="Remove embed"
          >
            <XIcon className="w-4 h-4" />
          </button>
        </div>
      </div>

      {}
      {children}
    </div>
  );
}

function ExpandIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"
      />
    </svg>
  );
}

function XIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}

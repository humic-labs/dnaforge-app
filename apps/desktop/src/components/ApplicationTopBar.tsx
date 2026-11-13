import type { ReactNode } from 'react';
import { BrandWordmarkText } from './BrandWordmark';

interface ApplicationTopBarProps {
  windowControlsInset?: boolean;
  windowsTitleBar?: boolean;
  menus?: ReactNode;
  badge?: ReactNode;
  context?: ReactNode;
  controls?: ReactNode;
}

export function ApplicationTopBar({
  windowControlsInset = false,
  windowsTitleBar = false,
  menus,
  badge,
  context,
  controls,
}: ApplicationTopBarProps) {
  return (
    <header
      data-testid="application-top-bar"
      className={`flex flex-shrink-0 items-center gap-3 border-b border-border bg-bg px-3 ${windowsTitleBar ? 'windows-title-bar h-8' : 'h-10'}`}
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {menus}
      <div
        className={`flex min-w-0 flex-1 items-center gap-2 text-sm text-fg-muted select-none ${
          windowControlsInset && !windowsTitleBar ? 'pl-16' : ''
        }`}
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        {!windowsTitleBar && (
          <span className="font-semibold text-fg" aria-label="DNAForge">
            <BrandWordmarkText />
          </span>
        )}
        {badge}
        {context}
      </div>

      <div
        className="flex min-w-0 flex-shrink-0 items-center gap-2"
        data-testid="appbar-right-controls"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        {controls}
      </div>
    </header>
  );
}

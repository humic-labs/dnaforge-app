import type { MouseEventHandler, ReactNode, Ref } from 'react';
import { stripDisplayExtension } from '../../../utils/fileTypes';
import type { TabType } from '../types';
import { getTabIcon } from './Tab';
import { terminalTabDropTarget } from '../../terminal/public/tab-transfer';
import { CloseIcon } from '../../../components/icons';
import { isHostedBrowserRuntime } from '../../../utils/environment';

interface CanvasTabStripProps {
  panelId: string;
  children: ReactNode;
  stripRef?: Ref<HTMLDivElement>;
  onContextMenu?: MouseEventHandler<HTMLDivElement>;
  trailing?: ReactNode;
}

export function CanvasTabStrip({
  panelId,
  children,
  stripRef,
  onContextMenu,
  trailing,
}: CanvasTabStripProps) {
  return (
    <div
      role="tablist"
      data-testid={isHostedBrowserRuntime() ? 'tabbar-hosted-workspace' : `tabbar-${panelId}`}
      data-tab-bar={panelId}
      {...terminalTabDropTarget(panelId)}
      className="flex h-9 min-w-0 shrink-0 items-center bg-bg-muted"
      onContextMenu={onContextMenu}
    >
      <div
        ref={stripRef}
        className="canvas-tab-strip-scroll flex min-w-0 flex-1 self-stretch items-stretch overflow-x-auto overflow-y-hidden"
        onContextMenu={onContextMenu}
      >
        {children}
      </div>
      {trailing}
    </div>
  );
}

export function RuntimeCanvasTab({
  id,
  label,
  type,
  selected,
  onSelect,
  onClose,
}: {
  id: string;
  label: string;
  type: TabType;
  selected: boolean;
  onSelect: (id: string) => void;
  onClose?: (id: string) => void;
}) {
  return (
    <button
      type="button"
      data-analytics-block
      role="tab"
      aria-selected={selected}
      data-testid={`tab-${id}`}
      data-tab-id={id}
      data-tab-label={label}
      data-tab-type={type}
      className={`ph-no-capture tab-shell group relative flex max-w-[240px] flex-1 basis-0 select-none items-center self-stretch border-0 bg-transparent p-0 text-sm ${
        selected
          ? 'chrome-tab-active z-10 min-w-[6.5rem] text-fg'
          : 'min-w-[3.5rem] cursor-pointer text-fg-muted wp-interactive'
      }`}
      onClick={() => onSelect(id)}
    >
      {!selected && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-1 rounded-md bg-bg-subtle opacity-0 transition-opacity duration-fast group-hover:opacity-100"
        />
      )}
      <span className="tab-inner relative z-[1] flex w-full min-w-0 items-center gap-1.5 px-3">
        {getTabIcon(type, 'tab-icon h-3.5 w-3.5 flex-shrink-0')}
        <span className="tab-label flex-1">{stripDisplayExtension(label)}</span>
        {onClose && (
          <span
            role="button"
            tabIndex={0}
            aria-label={`Close ${label}`}
            className="rounded-sm p-0.5 text-fg-muted wp-interactive "
            onClick={(event) => {
              event.stopPropagation();
              onClose(id);
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              event.stopPropagation();
              onClose(id);
            }}
          >
            <CloseIcon size={12} />
          </span>
        )}
      </span>
    </button>
  );
}

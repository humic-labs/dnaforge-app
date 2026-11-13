'use client';

import { useCallback, useRef } from 'react';
import { useDesignStore } from '../store';
import type { AssemblyState } from '../types';
import { AssemblyPanelContent } from '../../assembly-panel/public';
import type { AssemblySchemaPickerRequest } from '../../assembly-panel/public/schema-picker-request';

interface DesignDrawerProps {
  designId: string;
  projectRoot?: string | null;
  width: number;
  onWidthChange: (width: number) => void;
  schemaPickerRequest?: AssemblySchemaPickerRequest | null;
}

export function DesignDrawer({
  designId,
  projectRoot = null,
  width,
  onWidthChange,
  schemaPickerRequest,
}: DesignDrawerProps) {
  const design = useDesignStore((s) => s.designs[designId]);
  const pendingDispatchId = useDesignStore((s) => s.pendingDispatchId);
  const isDragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);
  const panelRef = useRef<HTMLElement | null>(null);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDragging.current = true;
      startX.current = e.clientX;
      startWidth.current = panelRef.current?.getBoundingClientRect().width ?? width;

      const handleMouseMove = (moveEvent: MouseEvent) => {
        if (!isDragging.current) return;
        const delta = startX.current - moveEvent.clientX;
        onWidthChange(startWidth.current + delta);
      };

      const handleMouseUp = () => {
        isDragging.current = false;
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [onWidthChange, width]
  );

  if (!design) {
    return (
      <aside
        className="h-full flex-shrink-0 border-l border-border bg-bg"
        style={{ width: `${width}px` }}
      >
        <div className="p-4 text-sm text-fg-muted">Design not found</div>
      </aside>
    );
  }

  const state = design.assemblyState ?? 'drafting';
  const hasPendingBug = (state === 'validating' || state === 'running') && !pendingDispatchId;

  return (
    <aside
      className="h-full border-l border-border bg-bg flex"
      style={{ width: `${width}px`, flexShrink: 1, minWidth: 0 }}
      ref={panelRef}
      data-testid="design-drawer"
      data-assembly-state={state}
      aria-live="polite"
    >
      <div
        data-testid="design-drawer-drag-handle"
        className="w-1 cursor-col-resize hover:bg-accent/50 active:bg-accent transition-colors flex-shrink-0"
        onMouseDown={handleMouseDown}
      />
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        <StateTreatment state={state} hasPendingBug={hasPendingBug} />

        <div className="min-h-0 flex-1">
          <AssemblyPanelContent
            designId={designId}
            projectRoot={projectRoot}
            schemaPickerRequest={schemaPickerRequest}
          />
        </div>
      </div>
    </aside>
  );
}

function StateTreatment({
  state,
  hasPendingBug,
}: {
  state: AssemblyState;
  hasPendingBug: boolean;
}) {
  if (hasPendingBug) {
    return (
      <div className="px-4 py-2 text-xs bg-error/10 text-error border-b border-border">
        Pending dispatch missing for transient assembly state.
      </div>
    );
  }

  if (state === 'validating' || state === 'running') {
    return (
      <div
        data-testid="assembly-state-treatment"
        className="px-4 py-2 text-xs bg-blue-50 dark:bg-blue-950/30 border-b border-border text-blue-700 dark:text-blue-300"
      >
        {state === 'validating' ? 'Recalculating assembly' : 'Finalizing assembly'}
      </div>
    );
  }

  return null;
}

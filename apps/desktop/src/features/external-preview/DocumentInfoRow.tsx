import type { ReactNode } from 'react';
import { DOCUMENT_TAB_UNDERBAR_MIN_CLASS } from '../sequence/public/document-tab-underbar';

export interface PreviewControls {
  action: ReactNode;
  destination: ReactNode;
}

export function DocumentInfoRow({
  controls,
  children,
}: {
  controls?: PreviewControls;
  children?: ReactNode;
}) {
  if (!controls && !children) return null;
  return (
    <>
      <div
        role={controls ? 'group' : undefined}
        aria-label={controls ? 'Read-only preview · Not imported' : undefined}
        className={`flex min-w-0 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted ${controls ? `external-preview-toolbar ${DOCUMENT_TAB_UNDERBAR_MIN_CLASS} border-b border-border-hover px-3 py-1` : 'px-4 py-2'}`}
      >
        {controls && (
          <span
            className="shrink-0 border-r border-border-hover pr-2 font-medium text-fg"
            title="Read-only preview · Not imported"
          >
            Preview
          </span>
        )}
        {children}
        {controls && <div className="ml-auto">{controls.action}</div>}
      </div>
      {controls?.destination}
    </>
  );
}

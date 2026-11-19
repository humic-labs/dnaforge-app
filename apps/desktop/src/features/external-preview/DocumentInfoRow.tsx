import type { ReactNode } from 'react';
import {
  UI_DOCUMENT_PREVIEW_LABEL_CLASS,
  UI_DOCUMENT_PREVIEW_ROW_CLASS,
} from '../../components/ui/styles';

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
        className={
          controls
            ? UI_DOCUMENT_PREVIEW_ROW_CLASS
            : 'flex min-w-0 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-xs text-fg-muted'
        }
      >
        {controls && (
          <span
            className={UI_DOCUMENT_PREVIEW_LABEL_CLASS}
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

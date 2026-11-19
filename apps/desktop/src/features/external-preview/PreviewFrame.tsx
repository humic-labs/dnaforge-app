import type { ReactNode } from 'react';

export function PreviewFrame({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <section
      aria-label="External file preview"
      data-testid="external-preview-frame"
      className="flex h-full min-h-0 flex-col overflow-hidden border-2 border-accent/75"
    >
      <header className="flex min-h-9 shrink-0 items-center gap-2 border-b border-accent/40 bg-accent/10 px-3 py-1 text-xs text-fg">
        <strong className="font-semibold">Preview</strong>
        <span className="text-fg-muted">Read-only · Not imported</span>
        {action && <div className="ml-auto">{action}</div>}
      </header>
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
}

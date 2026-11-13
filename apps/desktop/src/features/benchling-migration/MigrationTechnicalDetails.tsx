import type { ReactNode } from 'react';

export function MigrationTechnicalDetails({
  summary = 'Technical details',
  dataTestId,
  children,
}: {
  summary?: string;
  dataTestId?: string;
  children: ReactNode;
}) {
  return (
    <details
      className="group rounded border border-border bg-bg-subtle"
      data-testid={dataTestId ?? 'benchling-migration-technical-details'}
    >
      <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-fg-muted transition-colors hover:text-fg">
        {summary}
      </summary>
      <div className="space-y-3 border-t border-border px-3 py-3">{children}</div>
    </details>
  );
}

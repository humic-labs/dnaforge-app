import type { ReactNode } from 'react';
import { Button } from '../../components/ui';
import { EditIcon } from '../../components/icons';
import {
  MetadataFieldRow,
  MetadataValue as MetadataLayoutValue,
} from './entity-metadata/MetadataLayout';

export { MetadataFieldList as MetadataList } from './entity-metadata/MetadataLayout';

export type MetadataEditAction =
  | { kind: 'editable'; onEdit: () => void; disabled?: boolean }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'editing' };

export function MetadataSection({
  action,
  children,
}: {
  action: MetadataEditAction;
  children: ReactNode;
}) {
  return (
    <section aria-label="Metadata" className="space-y-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-fg">Metadata</h3>
        {action.kind !== 'editing' ? (
          <Button
            onClick={action.kind === 'editable' ? action.onEdit : undefined}
            disabled={action.kind === 'unavailable' || action.disabled}
            title={action.kind === 'unavailable' ? action.reason : undefined}
          >
            <span className="inline-flex items-center gap-1.5">
              <EditIcon size={13} />
              Edit fields
            </span>
          </Button>
        ) : null}
      </header>
      {action.kind === 'unavailable' ? (
        <p role="status" data-testid="registry-record-read-only" className="text-xs text-fg-muted">
          {action.reason}
        </p>
      ) : null}
      {children}
    </section>
  );
}

export function MetadataRow({
  label,
  description,
  required,
  children,
}: {
  label: string;
  description?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <MetadataFieldRow label={label} description={description} required={required}>
      <MetadataLayoutValue>{children}</MetadataLayoutValue>
    </MetadataFieldRow>
  );
}

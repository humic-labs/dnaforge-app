import type { ReactNode } from 'react';
import { UI_LIST_CLASS } from '../../../components/ui/styles';

export function MetadataValue({
  children,
  compact = false,
}: {
  children: ReactNode;
  compact?: boolean;
}) {
  return (
    <span
      className={
        compact
          ? 'block min-w-0 truncate'
          : 'block min-w-0 whitespace-pre-wrap break-words px-3 py-2.5'
      }
    >
      {children}
    </span>
  );
}

export function MetadataFieldList({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <dl className={`${UI_LIST_CLASS} px-3`} data-testid={testId}>
      {children}
    </dl>
  );
}

export function MetadataFieldRow({
  label,
  description,
  required = false,
  htmlFor,
  children,
}: {
  label: string;
  description?: string;
  required?: boolean;
  htmlFor?: string;
  children: ReactNode;
}) {
  const title = (
    <>
      {label}
      {required ? ' *' : ''}
    </>
  );
  return (
    <div className="metadata-field-row grid grid-cols-[minmax(6rem,0.75fr)_minmax(0,1.25fr)] items-start gap-3 text-sm">
      <dt className="break-words py-2.5 font-medium text-fg-muted" title={description}>
        {htmlFor ? <label htmlFor={htmlFor}>{title}</label> : title}
      </dt>
      <dd className="grid min-h-10 min-w-0 content-center whitespace-pre-wrap break-words text-fg">
        {children}
      </dd>
    </div>
  );
}

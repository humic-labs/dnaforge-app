import { Button } from '../../components/ui';
import type { ReactNode } from 'react';
import { SpinnerIcon } from '../../components/icons/glyphs';
import type { BenchlingMigrationReportView } from '../../shared/benchling-migration-ipc';

export type AsyncAction = () => void | Promise<unknown>;

export function StatusCard({
  tone,
  title,
  children,
}: {
  tone: 'neutral' | 'success' | 'warning' | 'error';
  title: string;
  children: ReactNode;
}) {
  const toneClass = {
    neutral: 'border-border bg-bg-subtle',
    success: 'border-success/40 bg-success/5',
    warning: 'border-warning/40 bg-warning/5',
    error: 'border-error/40 bg-error/5',
  }[tone];
  return (
    <div className={`rounded-lg border p-4 ${toneClass}`}>
      <div className="text-sm font-semibold text-fg">{title}</div>
      <div className="mt-1 text-xs leading-relaxed text-fg-muted">{children}</div>
    </div>
  );
}

export function PrimaryButton({
  label,
  pendingLabel,
  pending,
  disabled = false,
  onClick,
  type = 'button',
  dataTestId,
}: {
  label: string;
  pendingLabel?: string;
  pending: boolean;
  disabled?: boolean;
  onClick?: AsyncAction;
  type?: 'button' | 'submit';
  dataTestId?: string;
}) {
  return (
    <Button
      type={type}
      data-testid={dataTestId}
      disabled={disabled || pending}
      onClick={onClick}
      variant="primary"
    >
      <span className="inline-flex items-center gap-1.5">
        {pending ? <SpinnerIcon className="h-3 w-3" /> : null}
        {pending ? (pendingLabel ?? label) : label}
      </span>
    </Button>
  );
}

export function SecondaryButton({
  label,
  pending,
  onClick,
}: {
  label: string;
  pending: boolean;
  onClick: AsyncAction;
}) {
  return (
    <Button type="button" disabled={pending} onClick={onClick}>
      <span className="inline-flex items-center gap-1.5">
        {pending ? <SpinnerIcon className="h-3 w-3" /> : null}
        {label}
      </span>
    </Button>
  );
}

const NATIVE_EXCEPTION_PREFIX = 'Native conversion exception:';
const UNSUPPORTED_NATIVE_RECORD = /^No native converter is available for source type /u;
const GENBANK_ANNOTATION_CHANGED = /^Native GenBank round-trip changed annotation/u;
const NONSTANDARD_AMINO_ACID = /translations must use standard amino acids/u;

function nativeExceptionMessage(message: string): string {
  if (UNSUPPORTED_NATIVE_RECORD.test(message)) {
    return 'DNAForge does not yet support this Benchling record type.';
  }
  if (GENBANK_ANNOTATION_CHANGED.test(message)) {
    return 'DNAForge could not preserve every annotation exactly in an editable sequence.';
  }
  if (NONSTANDARD_AMINO_ACID.test(message)) {
    return 'DNAForge could not convert an annotation that uses nonstandard amino acids.';
  }
  return 'DNAForge preserved the original file because it could not verify an editable conversion.';
}

export function NativeExceptions({ issues }: { issues: BenchlingMigrationReportView['issues'] }) {
  const exceptions = issues.filter(
    (issue) =>
      issue.code === 'projection_failed' && issue.message.startsWith(NATIVE_EXCEPTION_PREFIX)
  );
  if (exceptions.length === 0) return null;
  const grouped = new Map<string, number>();
  for (const issue of exceptions) {
    const message = nativeExceptionMessage(
      issue.message.slice(NATIVE_EXCEPTION_PREFIX.length).trim()
    );
    grouped.set(message, (grouped.get(message) ?? 0) + 1);
  }
  return (
    <details
      data-testid="benchling-migration-native-exceptions"
      className="group rounded-xl border border-warning/50 bg-warning/5"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-3 marker:content-none">
        <span className="min-w-0 text-xs font-medium text-fg">
          {exceptions.length === 1
            ? '1 entity was preserved as a file instead of an editable record.'
            : `${exceptions.length} entities were preserved as files instead of editable records.`}
        </span>
        <span className="flex-none text-[11px] font-medium text-fg-muted group-open:hidden">
          Show details
        </span>
        <span className="hidden flex-none text-[11px] font-medium text-fg-muted group-open:inline">
          Hide details
        </span>
      </summary>
      <ul className="space-y-1 border-t border-warning/30 px-3 py-3 text-xs text-fg-muted">
        {[...grouped].map(([message, count]) => (
          <li key={message}>
            {message}
            {count > 1 ? ` (${count} entities)` : ''}
          </li>
        ))}
      </ul>
    </details>
  );
}

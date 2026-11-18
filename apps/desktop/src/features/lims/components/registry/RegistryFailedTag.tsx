export function RegistryFailedTag({ testId = 'lims-registry-failed' }: { testId?: string }) {
  return (
    <span
      data-testid={testId}
      className="inline-flex flex-shrink-0 items-center gap-1 rounded bg-error/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-error"
    >
      <span aria-hidden="true">!</span>
      Failed
    </span>
  );
}

export function UnconnectedFilterButton({
  active,
  count,
  onClick,
  testId,
}: {
  active: boolean;
  count: number;
  onClick: () => void;
  testId: string;
}) {
  if (count === 0 && !active) return null;

  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={active}
      title="Records that mention another record without a confirmed link. Select to filter."
      onClick={onClick}
      className={`h-9 flex-shrink-0 rounded border px-2.5 text-xs font-medium ${
        active
          ? 'border-error/40 bg-error/15 text-error'
          : 'border-border text-fg-muted wp-interactive '
      }`}
    >
      Unresolved links ({count})
    </button>
  );
}

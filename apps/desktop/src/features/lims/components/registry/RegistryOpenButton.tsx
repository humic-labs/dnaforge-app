import type { LimsRegistrySummary } from '../../../../shared/lims';

export function RegistryOpenButton({
  summary,
  onOpen,
  testId,
}: {
  summary: LimsRegistrySummary;
  onOpen: (summary: LimsRegistrySummary) => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={`Open ${summary.name}`}
      disabled={!summary.representation.canOpen}
      title={
        summary.representation.canOpen
          ? `Open ${summary.name}`
          : `${summary.representation.label}. Select the row to inspect its details.`
      }
      className="inline-flex h-5 w-12 flex-shrink-0 items-center justify-center rounded border border-border px-2 text-[11px] font-medium leading-none text-fg-muted hover:bg-bg hover:text-fg disabled:cursor-default disabled:opacity-50"
      onClick={(event) => {
        event.stopPropagation();
        onOpen(summary);
      }}
      onKeyDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      Open
    </button>
  );
}

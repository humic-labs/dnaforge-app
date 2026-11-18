import type { ImportItem } from '../workspace-loader/public/import-wizard-state';
import type { WizardAction } from './wizard-reducer';

function DedupChoice({
  label,
  pressed,
  onClick,
}: {
  label: string;
  pressed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={
        pressed
          ? 'rounded border border-accent bg-accent/15 px-1.5 py-0.5 text-[11px] text-fg'
          : 'rounded border border-border px-1.5 py-0.5 text-[11px] text-fg-muted wp-interactive'
      }
    >
      {label}
    </button>
  );
}

export function DedupControls({
  item,
  dispatch,
}: {
  item: ImportItem;
  dispatch: (action: WizardAction) => void;
}) {
  if (item.dedup?.action === 'name-collision') {
    return (
      <span
        role="radiogroup"
        aria-label={`Resolve name conflict for ${item.name}`}
        data-testid="import-dedup-collision"
        className="flex w-full items-center gap-1 pl-6"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="text-xs text-fg-muted">Name exists —</span>
        <DedupChoice
          label="Replace"
          pressed={item.dedupResolution === 'replace'}
          onClick={() =>
            dispatch({ type: 'set-dedup-resolution', path: item.path, resolution: 'replace' })
          }
        />
        <DedupChoice
          label="Keep both"
          pressed={item.dedupResolution === 'keep-both'}
          onClick={() =>
            dispatch({ type: 'set-dedup-resolution', path: item.path, resolution: 'keep-both' })
          }
        />
      </span>
    );
  }
  if (item.dedup?.action === 'skip-duplicate') {
    return (
      <span data-testid="import-dedup-skip" className="w-full pl-6 text-xs text-fg-muted">
        {item.dedupResolution === 'import-anyway'
          ? 'Importing anyway'
          : 'Already imported · skipped'}
        {item.dedupResolution !== 'import-anyway' && (
          <button
            type="button"
            className="ml-1 underline hover:text-fg"
            onClick={(e) => {
              e.stopPropagation();
              dispatch({
                type: 'set-dedup-resolution',
                path: item.path,
                resolution: 'import-anyway',
              });
            }}
          >
            Import anyway
          </button>
        )}
      </span>
    );
  }
  return null;
}

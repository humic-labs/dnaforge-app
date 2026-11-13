import { useDesignRecoveryStore } from '../design-recovery';
import {
  resolveDesignArtifactConflict,
  retryDesignArtifactMirror,
} from '../design-artifact-mirror';
import type { SequenceDesign } from '../types';

function downloadVersion(design: SequenceDesign): void {
  const url = URL.createObjectURL(
    new Blob(
      [
        JSON.stringify(
          {
            schema: 'waypoint.design.v1',
            kind: 'assembly-design',
            id: design.id,
            name: design.name,
            design,
          },
          null,
          2
        ),
      ],
      { type: 'application/json' }
    )
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = `${design.name.replace(/[/\\]/g, '-')}.wpdesign.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function DesignSaveStatus({ designId }: { designId: string }) {
  const record = useDesignRecoveryStore((state) => state.records[designId]);
  if (!record || record.retired || (!record.pending && !record.alternatives?.length)) return null;
  const label = !record.durable
    ? 'Not saved'
    : record.status === 'saving'
      ? 'Saving…'
      : 'Saving delayed';
  const other = record.conflict;
  return (
    <details
      className="relative text-xs text-fg-muted"
      data-testid={record.pending ? 'design-save-status' : 'design-kept-versions'}
    >
      <summary className="cursor-pointer" aria-label={record.pending ? label : 'Kept versions'}>
        {record.pending ? label : 'Kept versions'}
      </summary>
      <div className="absolute z-50 mt-2 max-w-sm whitespace-normal rounded border border-border bg-bg p-3 shadow-lg">
        {record.pending && (
          <p>
            {record.durable
              ? 'Your latest edits are recoverable on this device.'
              : 'Your latest edits are only in memory. Keep this window open until saving recovers. Free some disk space and try again.'}
          </p>
        )}
        {record.pending && (
          <p className="mt-1">
            {record.status === 'conflict'
              ? 'This assembly was changed elsewhere. Both versions have been kept.'
              : record.status === 'unbound'
                ? 'The assembly file is unavailable. Saving will resume when it is available.'
                : 'Saving will retry automatically.'}
          </p>
        )}
        {record.status === 'conflict' ? (
          <div className="mt-2 flex flex-col items-start gap-2">
            {other && (
              <button type="button" onClick={() => downloadVersion(other)}>
                Download other version: {other.name}
              </button>
            )}
            <button type="button" onClick={() => resolveDesignArtifactConflict(designId, 'local')}>
              Keep my edits
            </button>
            {other && (
              <button
                type="button"
                onClick={() => resolveDesignArtifactConflict(designId, 'external')}
              >
                Use other edits
              </button>
            )}
          </div>
        ) : (
          record.pending && (
            <button
              type="button"
              className="mt-2 text-accent"
              onClick={() => retryDesignArtifactMirror(designId)}
            >
              Try again
            </button>
          )
        )}
        {record.alternatives?.map((design, index) => (
          <button
            key={`${design.id}-${index}`}
            type="button"
            className="mt-2 block text-accent"
            onClick={() => downloadVersion(design)}
          >
            Download kept version: {design.name}
          </button>
        ))}
      </div>
    </details>
  );
}

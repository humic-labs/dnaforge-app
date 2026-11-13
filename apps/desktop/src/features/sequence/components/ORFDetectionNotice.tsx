import type { UseORFsResult } from '@waypoint/workspace-editor';

function detectionMessage(detection: UseORFsResult): string {
  const status = detection.status;
  switch (status) {
    case 'idle':
      return '';
    case 'pending':
      return 'Finding open reading frames...';
    case 'ready-empty':
      return 'No open reading frames at this minimum length.';
    case 'ready-results':
      return `${detection.detectedORFs.length} ${detection.detectedORFs.length === 1 ? 'open reading frame' : 'open reading frames'}`;
    case 'failed':
      return 'Open reading frame detection failed.';
    case 'cancelled':
      return 'Open reading frame detection was cancelled.';
    default: {
      const unhandled: never = status;
      return unhandled;
    }
  }
}

export function ORFDetectionNotice({ detection }: { detection: UseORFsResult }) {
  if (detection.status === 'idle') return null;
  return (
    <div
      data-testid="orf-detection-status"
      data-state={detection.status}
      role={detection.status === 'failed' ? 'alert' : 'status'}
      className="flex items-center justify-between gap-3 border-b border-border bg-bg-subtle px-3 py-1.5 text-xs text-fg-muted"
    >
      <span>{detectionMessage(detection)}</span>
      {detection.status === 'failed' || detection.status === 'cancelled' ? (
        <button
          type="button"
          onClick={detection.retry}
          className="shrink-0 rounded border border-border px-2 py-1 font-medium text-fg hover:bg-bg-muted"
        >
          Retry ORF detection
        </button>
      ) : null}
    </div>
  );
}

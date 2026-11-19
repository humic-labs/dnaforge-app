import { useState, type RefObject } from 'react';
import { PortalMenu } from '../../../components/PortalMenu';
import type { VerificationTrack, TrackStatus } from '../types';

export function StatusOverridePopover({
  track,
  anchorRef,
  onOverride,
  onClose,
}: {
  track: VerificationTrack;
  anchorRef: RefObject<HTMLElement | null>;
  onOverride: (status: TrackStatus | null, reason?: string) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState(track.userOverrideReason ?? '');

  const statuses: { value: TrackStatus; label: string; color: string }[] = [
    { value: 'pass', label: 'Pass', color: 'text-green-400' },
    { value: 'variants', label: 'Variants', color: 'text-yellow-400' },
    { value: 'fail', label: 'Fail', color: 'text-red-400' },
  ];

  return (
    <PortalMenu
      open
      anchorRef={anchorRef}
      onRequestClose={onClose}
      role="dialog"
      aria-label={`Alignment review for ${track.label}`}
      horizontalAlign="start"
      preferredSide="bottom"
      layout={{ width: '13rem' }}
    >
      <div onClick={(e) => e.stopPropagation()}>
        <div className="text-xs text-fg-muted mb-2">
          Computed: <span className="font-medium text-fg">{track.status}</span>
        </div>
        <div className="flex gap-1 mb-2">
          {statuses.map((s) => (
            <button
              key={s.value}
              onClick={() => onOverride(s.value, reason.trim() || undefined)}
              className={`flex-1 px-2 py-1 text-xs rounded border transition-colors ${
                track.userStatus === s.value
                  ? 'border-accent bg-accent/20 font-medium'
                  : 'border-border wp-interactive'
              } ${s.color}`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason (optional)"
          className="w-full bg-bg-subtle border border-border rounded px-2 py-1 text-xs outline-none focus:border-accent"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && track.userStatus) {
              onOverride(track.userStatus, reason.trim() || undefined);
              onClose();
            }
          }}
        />
        {track.userStatus && (
          <button
            onClick={() => {
              onOverride(null);
              onClose();
            }}
            className="mt-2 text-xs text-fg-muted hover:text-fg underline"
          >
            Clear override
          </button>
        )}
      </div>
    </PortalMenu>
  );
}

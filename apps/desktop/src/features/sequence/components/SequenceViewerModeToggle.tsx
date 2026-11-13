import { memo, type ReactNode } from 'react';

export type SequenceViewMode = '2d' | 'tracks';

interface SequenceViewerModeToggleProps {
  value: SequenceViewMode;
  onChange: (next: SequenceViewMode) => void;
  className?: string;
}

function WrapIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ display: 'inline-block', verticalAlign: '-1px' }}
    >
      {}
      <line x1="2" y1="4" x2="14" y2="4" />
      {}
      <path d="M2 8 H11 a2.2 2.2 0 0 1 0 4.4 H6" />
      <polyline points="7.6 11.4 6 12.6 7.6 13.8" />
      {}
      <line x1="2" y1="12.6" x2="4" y2="12.6" />
    </svg>
  );
}

function TracksIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ display: 'inline-block', verticalAlign: '-1px' }}
    >
      {}
      <rect x="2.5" y="3" width="11" height="2.2" rx="0.6" />
      <rect x="2.5" y="6.9" width="11" height="2.2" rx="0.6" />
      <rect x="2.5" y="10.8" width="11" height="2.2" rx="0.6" />
    </svg>
  );
}

const SLOT_WIDTH = 'w-16';
const BTN_BASE =
  `relative z-10 ${SLOT_WIDTH} px-1 py-0 text-xs font-medium rounded ` +
  `focus:outline-none ` +
  `transition-colors`;

const SLOT_INDEX: Record<SequenceViewMode, number> = { '2d': 0, tracks: 1 };

function ModeButton({
  active,
  onClick,
  label,
  icon,
  testId,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  icon: ReactNode;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`${BTN_BASE} ${active ? 'text-fg' : 'text-fg-muted hover:text-fg'}`}
      data-ph-name={testId}
      data-testid={testId}
      title={label}
    >
      <span style={{ marginRight: 4 }}>{icon}</span>
      {label}
    </button>
  );
}

function SequenceViewerModeToggleInner({
  value,
  onChange,
  className,
}: SequenceViewerModeToggleProps) {
  return (
    <div
      className={`relative inline-flex items-center rounded bg-gray-100 p-px dark:bg-bg-subtle ${className ?? ''}`}
      role="group"
      aria-label="Sequence viewer layout"
      data-ph-name="sequence-view-mode-toggle"
      data-testid="sequence-view-mode-toggle"
    >
      <span
        aria-hidden="true"
        className="absolute top-px bottom-px left-px rounded bg-white shadow-sm transition-transform duration-150 ease-out dark:bg-bg-muted dark:shadow-none"
        style={{
          width: 'calc(50% - 1px)',
          transform: `translateX(${SLOT_INDEX[value] * 100}%)`,
        }}
      />
      <ModeButton
        active={value === '2d'}
        onClick={() => value !== '2d' && onChange('2d')}
        label="Wrap"
        icon={<WrapIcon />}
        testId="sequence-view-mode-2d"
      />
      <ModeButton
        active={value === 'tracks'}
        onClick={() => value !== 'tracks' && onChange('tracks')}
        label="Tracks"
        icon={<TracksIcon />}
        testId="sequence-view-mode-tracks"
      />
    </div>
  );
}

export const SequenceViewerModeToggle = memo(SequenceViewerModeToggleInner);

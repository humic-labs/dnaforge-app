import { formatShortcut } from '@waypoint/ui-components/keyboard';
import { cn } from '../shared/lib/cn';

interface ActivityBarDevButtonsProps {
  onToggleDevPanel: () => void;
  devPanelOpen?: boolean;
}

function CodeIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <polyline points="7 8 3 12 7 16" />
      <line x1="13" y1="6" x2="11" y2="18" />
      <polyline points="17 8 21 12 17 16" />
    </svg>
  );
}

function DevActivityButton({
  icon,
  label,
  active,
  onClick,
  testId,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      data-testid={testId}
      className={cn(
        'w-12 h-12 flex items-center justify-center transition-colors relative',
        active ? 'text-accent' : 'text-fg-muted hover:text-fg'
      )}
    >
      {active && <div className="absolute left-0 top-0 w-[3px] h-full bg-accent dark:bg-accent" />}
      <div className="w-6 h-6">{icon}</div>
    </button>
  );
}

export function ActivityBarDevButtons({
  onToggleDevPanel,
  devPanelOpen,
}: ActivityBarDevButtonsProps) {
  return (
    <DevActivityButton
      icon={<CodeIcon className="w-full h-full" />}
      label={`Dev Scenarios (${formatShortcut(['cmd', 'shift', '.'])})`}
      active={!!devPanelOpen}
      onClick={onToggleDevPanel}
      testId="dev-scenarios-button"
    />
  );
}

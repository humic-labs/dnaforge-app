import { formatShortcut } from '@waypoint/ui-components/keyboard';
import { cn } from '../shared/lib/cn';
import { trackToolOpened } from '../lib/analytics';
import type { ToolUsageToolId } from '../lib/analytics-events';
import { DevOnly } from './DevOnly';
import { useCommandRegistry } from '../commands';
import { rendererFeatureActivityButtons, rendererFeatureViewIds } from '../feature-registry';
import type { ActivityView } from '../shared/activity-view';
import { GenomeAssemblyIcon } from './icons';

export type { ActivityView, ShellActivityView } from '../shared/activity-view';

export const FULL_SCREEN_ACTIVITY_VIEWS = new Set<ActivityView>([
  'settings',
  'home',
  'references',
  ...rendererFeatureViewIds(),
]);

interface ActivityBarProps {
  activeView: ActivityView;
  sidebarVisible: boolean;
  referenceLibraryActive: boolean;
  onViewChange: (view: ActivityView) => void;
  onToggleSidebar: () => void;
  toolboxBadge?: 'downloading' | 'error' | null;
  jobsActiveCount?: number;
  jobsAttentionCount?: number;
  limsAttentionCount?: number;
  onOpenReferenceGenome?: () => void;
  devActions?: React.ReactNode;
  onOpenTerminal?: () => void;
  accountSlot?: React.ReactNode;
}

function HomeIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M3 11.5 12 4l9 7.5" />
      <path d="M5 10v9a1 1 0 001 1h4v-6h4v6h4a1 1 0 001-1v-9" />
    </svg>
  );
}

function FilesIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
    </svg>
  );
}

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <circle cx="11" cy="11" r="8" />
      <path d="M21 21l-4.35-4.35" />
    </svg>
  );
}

function JobsIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="m8 9 1.5 1.5L12 8" />
      <path d="M14 9h3" />
      <path d="m8 15 1.5 1.5L12 14" />
      <path d="M14 15h3" />
    </svg>
  );
}

function WrenchIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" />
    </svg>
  );
}

function LimsIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v14a9 3 0 0 0 18 0V5" />
      <path d="M3 12a9 3 0 0 0 18 0" />
    </svg>
  );
}

function SourceControlIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}

function SettingsIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M12 15a3 3 0 100-6 3 3 0 000 6z" />
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" />
    </svg>
  );
}

interface ActivityButtonProps {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
  position?: 'top' | 'bottom';
  testId?: string;
  ariaLabel?: string;
  badge?: React.ReactNode;
}

function ActivityButton({
  icon,
  label,
  active,
  onClick,
  testId,
  ariaLabel,
  badge,
}: ActivityButtonProps) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={ariaLabel}
      data-testid={testId}
      data-ph-capture-attribute-action="navigate"
      data-ph-capture-attribute-surface="header"
      className={cn(
        'w-12 h-12 flex items-center justify-center transition-colors relative',
        active ? 'text-accent' : 'text-fg-muted wp-interactive'
      )}
    >
      {}
      {active && <div className="absolute left-0 top-0 w-[3px] h-full bg-accent dark:bg-accent" />}
      <div className="w-6 h-6">{icon}</div>
      {badge}
    </button>
  );
}

export function ActivityBar({
  activeView,
  sidebarVisible,
  referenceLibraryActive,
  onViewChange,
  onToggleSidebar,
  toolboxBadge,
  jobsActiveCount = 0,
  jobsAttentionCount = 0,
  limsAttentionCount = 0,
  onOpenReferenceGenome,
  devActions,
  accountSlot,
  onOpenTerminal,
}: ActivityBarProps) {
  const workspaceViews = FULL_SCREEN_ACTIVITY_VIEWS;
  const { dispatchCommand } = useCommandRegistry();
  const toolIdByView: Partial<Record<ActivityView, ToolUsageToolId>> = {
    lims: 'lims',
    settings: 'settings',
  };
  const activeJobs = Math.max(0, Math.trunc(jobsActiveCount));
  const attentionJobs = Math.max(0, Math.trunc(jobsAttentionCount));
  const jobsLabel = [
    'Jobs',
    activeJobs > 0 ? `${activeJobs} active` : null,
    attentionJobs > 0
      ? `${attentionJobs} ${attentionJobs === 1 ? 'needs' : 'need'} attention`
      : null,
  ]
    .filter(Boolean)
    .join(', ');

  const handleClick = (view: ActivityView) => {
    const opensView = workspaceViews.has(view)
      ? view !== activeView
      : view !== activeView || !sidebarVisible;
    if (opensView) {
      const toolId = toolIdByView[view];
      if (toolId) trackToolOpened(toolId, 'sidebar');
    }

    if (view === activeView && !workspaceViews.has(view)) {
      onToggleSidebar();
    } else {
      onViewChange(view);
    }
  };

  return (
    <div
      data-testid="activity-bar"
      className="w-12 bg-bg-subtle border-r border-border flex flex-col"
    >
      {}
      <div className="flex flex-col">
        <ActivityButton
          icon={<HomeIcon className="w-full h-full" />}
          label="Home"
          active={activeView === 'home'}
          onClick={() => handleClick('home')}
          testId="home-button"
        />
        <ActivityButton
          icon={<FilesIcon className="w-full h-full" />}
          label={`Explorer (${formatShortcut(['cmd', 'shift', 'e'])})`}
          active={activeView === 'files' && sidebarVisible}
          onClick={() => handleClick('files')}
          testId="files-button"
        />
        <ActivityButton
          icon={<SearchIcon className="w-full h-full" />}
          label={`Search (${formatShortcut(['cmd', 'shift', 'f'])})`}
          active={activeView === 'search' && sidebarVisible}
          onClick={() => handleClick('search')}
          testId="search-button"
        />
        <ActivityButton
          icon={
            <>
              <JobsIcon className="h-full w-full" />
              {activeJobs > 0 ? (
                <span
                  aria-hidden="true"
                  className="absolute right-0.5 top-0.5 min-w-4 rounded-full bg-accent px-1 text-center text-[9px] font-semibold leading-4 text-white"
                >
                  {activeJobs}
                </span>
              ) : null}
              {attentionJobs > 0 ? (
                <span
                  data-testid="jobs-attention"
                  aria-hidden="true"
                  className="absolute bottom-1 right-1 h-2 w-2 rounded-full border border-bg-subtle bg-error"
                />
              ) : null}
            </>
          }
          label={jobsLabel}
          ariaLabel={jobsLabel}
          active={activeView === 'jobs' && sidebarVisible}
          onClick={() => handleClick('jobs')}
          testId="jobs-button"
        />
        {}
        <ActivityButton
          icon={<SourceControlIcon className="w-full h-full" />}
          label="Source Control"
          active={activeView === 'source-control' && sidebarVisible}
          onClick={() => handleClick('source-control')}
          testId="source-control-button"
        />
        <ActivityButton
          icon={
            <>
              <LimsIcon className="h-full w-full" />
              {limsAttentionCount > 0 ? (
                <span
                  data-testid="lims-attention"
                  aria-hidden="true"
                  className="absolute right-0.5 top-0.5 min-w-4 rounded-full bg-error px-1 text-center text-[9px] font-semibold leading-4 text-white"
                >
                  {limsAttentionCount}
                </span>
              ) : null}
            </>
          }
          label="LIMS"
          ariaLabel={
            limsAttentionCount > 0
              ? `LIMS, ${limsAttentionCount} ${limsAttentionCount === 1 ? 'entity needs' : 'entities need'} a link`
              : 'LIMS'
          }
          active={activeView === 'lims' && sidebarVisible}
          onClick={() => handleClick('lims')}
          testId="lims-button"
        />
        <ActivityButton
          icon={<GenomeAssemblyIcon className="h-full w-full" />}
          label="Reference genomes"
          active={referenceLibraryActive}
          onClick={onOpenReferenceGenome ?? (() => handleClick('references'))}
          testId="reference-picker-open"
        />
        {rendererFeatureActivityButtons().map(({ view, label, icon, testId, command, badge }) => (
          <ActivityButton
            key={view}
            icon={icon}
            label={label}
            ariaLabel={label}
            active={activeView === view && (workspaceViews.has(view) || sidebarVisible)}
            onClick={() => {
              if (command && (view !== activeView || !sidebarVisible)) {
                dispatchCommand(command, { source: 'ui' });
                return;
              }
              handleClick(view);
            }}
            testId={testId}
            badge={badge}
          />
        ))}
        {onOpenTerminal && (
          <ActivityButton
            icon={<span className="font-mono text-lg leading-none">›_</span>}
            label="Terminal"
            ariaLabel="Terminal"
            active={activeView === 'terminal' && sidebarVisible}
            onClick={onOpenTerminal}
            testId="terminal-toggle"
          />
        )}
        {}
        <DevOnly>
          <div className="relative">
            <ActivityButton
              icon={<WrenchIcon className="w-full h-full" />}
              label="Toolbox"
              active={activeView === 'toolbox' && sidebarVisible}
              onClick={() => handleClick('toolbox')}
              testId="toolbox-button"
            />
            {toolboxBadge === 'downloading' && (
              <div className="absolute top-2 right-2 w-2 h-2 border border-accent border-t-transparent rounded-full animate-spin" />
            )}
            {toolboxBadge === 'error' && (
              <div className="absolute top-2 right-2 w-2 h-2 rounded-full bg-error" />
            )}
          </div>
        </DevOnly>
      </div>

      {}
      <div className="flex-1" />

      {}
      <div className="flex flex-col">
        {devActions}
        <ActivityButton
          icon={<SettingsIcon className="w-full h-full" />}
          label={`Settings (${formatShortcut(['cmd', ','])})`}
          active={activeView === 'settings'}
          onClick={() => handleClick('settings')}
          testId="settings-button"
        />
        {}
        {accountSlot}
      </div>
    </div>
  );
}

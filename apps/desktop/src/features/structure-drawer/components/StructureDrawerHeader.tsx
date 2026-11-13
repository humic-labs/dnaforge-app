import { Tooltip } from '../../../shared/components/Tooltip';
import type { ResolverResult, StructureCandidate } from '../types/structure-drawer';
import {
  candidateTitle,
  ExternalLinkIcon,
  sourceLinkForCandidate,
  SourceBadge,
  SourceCountDots,
  SOURCE_STYLES,
  type CandidateSourceCounts,
} from './structure-candidate-ui';

interface Props {
  cdsLabel?: string;

  resolved: ResolverResult | null;

  statusLabel: string;
  candidateCounts?: CandidateSourceCounts | null;
  selectedCandidate?: StructureCandidate | null;
  onClose: () => void;
  closeLabel?: string;
  compact?: boolean;

  onOpenInTab?: () => void;

  onChangeStructure?: () => void;

  onNavigateToSequence?: () => void;
}

export function StructureDrawerHeader({
  cdsLabel,
  resolved,
  statusLabel,
  candidateCounts,
  selectedCandidate,
  onClose,
  closeLabel = 'Close structure drawer',
  compact = false,
  onOpenInTab,
  onChangeStructure,
  onNavigateToSequence,
}: Props) {
  const canOpenInTab = !!resolved && !!onOpenInTab;
  const selectedSourceLink = selectedCandidate ? sourceLinkForCandidate(selectedCandidate) : null;
  const selectedTitle = selectedCandidate ? candidateTitle(selectedCandidate) : null;
  const showStatusLine = !selectedCandidate && statusLabel && statusLabel !== 'Choose structure';
  const showCounts = !!candidateCounts && candidateCounts.all > 0;
  const headerTitle = cdsLabel ?? 'Structure';
  return (
    <header
      data-testid="structure-drawer-header"
      className={`border-b border-border px-3 ${compact ? 'py-1' : 'py-2'}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div
            data-testid="structure-header-title-row"
            className="flex min-w-0 items-center gap-2 text-sm font-medium text-fg"
          >
            <span className="min-w-0 truncate">{headerTitle}</span>
            {compact && showStatusLine && (
              <span
                data-testid="structure-drawer-status-label"
                className="shrink-0 text-xs font-normal text-fg-muted"
              >
                {statusLabel}
              </span>
            )}
          </div>
          {!selectedCandidate && showCounts && (
            <div
              data-testid="structure-result-summary-row"
              className="mt-0.5 flex min-w-0 flex-nowrap items-center gap-2 overflow-hidden text-[11px] text-fg-muted"
            >
              <span data-testid="structure-hit-count" className="shrink-0">
                {candidateCounts.all === 1 ? '1 result' : `${candidateCounts.all} results`}
              </span>
              <SourceCountDots counts={candidateCounts} />
            </div>
          )}
          {showStatusLine && !compact && (
            <div className="mt-0.5 flex items-center gap-2 text-xs text-fg-muted">
              <span data-testid="structure-drawer-status-label">{statusLabel}</span>
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {onNavigateToSequence && (
            <button
              data-testid="structure-drawer-go-to-sequence"
              onClick={onNavigateToSequence}
              aria-label="Center source sequence range"
              title="Center source sequence range"
              className="flex h-6 w-6 items-center justify-center rounded text-fg-subtle hover:bg-bg-muted hover:text-fg"
            >
              <LocateSequenceIcon />
            </button>
          )}
          {canOpenInTab && (
            <button
              data-testid="structure-drawer-expand-to-tab"
              onClick={onOpenInTab}
              aria-label="Pop out structure to tab"
              title="Pop out structure to tab"
              className="flex h-6 w-6 items-center justify-center rounded text-fg-subtle hover:bg-bg-muted hover:text-fg"
            >
              <PanelRightOpenIcon />
            </button>
          )}
          <button
            data-testid="structure-drawer-close"
            onClick={onClose}
            aria-label={closeLabel}
            className="flex h-6 w-6 items-center justify-center rounded text-fg-subtle hover:bg-bg-muted hover:text-fg"
          >
            ×
          </button>
        </div>
      </div>
      {selectedCandidate && (
        <div
          data-testid="structure-selected-candidate-summary"
          className="mt-1 w-full min-w-0 text-xs"
        >
          <div
            data-testid="structure-result-summary-row"
            className="flex min-w-0 flex-nowrap items-center gap-1.5 overflow-hidden text-[11px] text-fg-muted"
          >
            {showCounts && (
              <>
                <span data-testid="structure-hit-count" className="shrink-0 whitespace-nowrap">
                  {candidateCounts.all === 1 ? '1 result' : `${candidateCounts.all} results`}
                </span>
                <SourceCountDots counts={candidateCounts} />
                <HeaderSeparator />
              </>
            )}
            <span
              data-testid="structure-selected-id-row"
              className="flex shrink-0 items-center gap-1.5"
            >
              <span
                data-testid="structure-selected-candidate-label"
                className="font-mono text-[12px] font-medium text-fg"
              >
                {selectedCandidate.label}
              </span>
              <SourceBadge group={selectedCandidate.group} />
            </span>
            <HeaderSeparator />
            <span
              data-testid="structure-selected-title-row"
              className="flex min-w-0 flex-1 items-center gap-1.5"
            >
              <Tooltip content={selectedTitle} side="bottom" className="min-w-0 flex-1">
                <span
                  data-testid="structure-selected-candidate-title"
                  className="block truncate text-[11px] text-fg-muted"
                >
                  {selectedTitle}
                </span>
              </Tooltip>
              {onChangeStructure && (
                <button
                  type="button"
                  data-testid="structure-candidate-toggle"
                  data-ignore-picker-shortcuts="true"
                  aria-expanded="false"
                  className="h-6 shrink-0 rounded border border-border px-2 text-[11px] text-fg-muted hover:bg-bg-muted hover:text-fg focus:outline-none focus:ring-1 focus:ring-accent"
                  onClick={onChangeStructure}
                >
                  Choose New Structure
                </button>
              )}
              {selectedSourceLink && (
                <Tooltip
                  content={`Open ${selectedCandidate.label} source`}
                  side="left"
                  className="shrink-0"
                >
                  <a
                    href={selectedSourceLink.href}
                    target="_blank"
                    rel="noreferrer noopener"
                    data-testid="structure-selected-source-link"
                    className={`flex h-5 w-5 items-center justify-center rounded text-fg-muted focus:outline-none focus:ring-1 focus:ring-accent ${SOURCE_STYLES[selectedCandidate.group].link}`}
                    aria-label={`Open ${selectedCandidate.label} source`}
                  >
                    <ExternalLinkIcon />
                  </a>
                </Tooltip>
              )}
            </span>
          </div>
        </div>
      )}
    </header>
  );
}

function HeaderSeparator() {
  return <span aria-hidden="true" className="h-3 w-px shrink-0 bg-border" />;
}

function LocateSequenceIcon() {
  return (
    <svg
      data-testid="structure-drawer-go-to-sequence-icon"
      data-icon="locate-sequence"
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="7" />
      <circle cx="12" cy="12" r="2" />
      <path d="M12 2v3" />
      <path d="M12 19v3" />
      <path d="M2 12h3" />
      <path d="M19 12h3" />
    </svg>
  );
}

function PanelRightOpenIcon() {
  return (
    <svg
      data-testid="structure-drawer-expand-to-tab-icon"
      data-icon="panel-right-open"
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M14 3v18" />
      <path d="m8 9 3 3-3 3" />
    </svg>
  );
}

import {
  type UserMessage,
  userMessageWithValues,
  userMessageValue,
  userEntityLabel,
  toUserMessage,
} from '@waypoint/user-messages';

import { useState, useCallback, useEffect, useRef } from 'react';
import { PrimerRow } from './PrimerRow';
import { SaturationLibraryPanel } from './SaturationLibraryPanel';
import { PrimerCreationForm } from './PrimerCreationForm';
import { PrimerBindingEditor } from './PrimerBindingEditor';
import { PrimerSearchPanel, type PrimerAutoScopeRequest } from './PrimerSearchPanel';
import type { PrimerPreview } from './PrimerCreationForm';
import type { PrimerSearchResult, BindingHit } from '../primer-search-service';
import type { BoundPrimer, CreatePrimerInput, Primer, PrimerDirection } from '../types';
import type { HostPrimerBinding } from '../primer-save-preparation';
import {
  trackToolActionCompleted,
  trackToolActionStarted,
  trackToolError,
  trackToolOpened,
} from '../../../lib/analytics';

interface PrimersDrawerContentProps {
  primers: BoundPrimer[];
  isLoading: boolean;
  error?: Error | null;
  onRetry?: () => void;
  selectedBindingId?: string | null;
  onPrimerClick?: (primer: BoundPrimer) => void;

  onDetach?: (bindingId: string) => Promise<void> | void;
  pendingBindingEdit?: BoundPrimer | null;
  onClearBindingEdit?: () => void;
  onPrimerCreate: (input: CreatePrimerInput, hostBinding?: HostPrimerBinding) => Promise<void>;

  hostOwnedBinding?: boolean;

  pendingCreation?: {
    sequence: string;
    direction: PrimerDirection;
    bindingStart: number;
    bindingEnd: number;
  } | null;
  onClearPendingCreation?: () => void;

  onPreviewChange?: (preview: PrimerPreview) => void;
  onGoToBinding?: (bindingStart: number, bindingEnd: number) => void;

  referenceSequence?: string;
  sequenceId?: number;

  sequenceLength?: number;
  bindingCoordinateOffset?: number;

  circular?: boolean;
  workspaceId?: number;

  workspaceRoot?: string;
  targetDocumentId?: string;
  targetFilePath?: string;
  initialSaveDir?: string;

  searchResults?: PrimerSearchResult[];
  isSearching?: boolean;
  onSearch?: (constraints: { regionStart?: number; regionEnd?: number }) => void;
  onAttach?: (primer: Primer, hit: BindingHit) => Promise<void>;

  selectionRange?: { start: number; end: number } | null;

  onSearchResultClick?: (hit: { start: number; end: number }) => void;

  onCandidatePreview?: (preview: import('@waypoint/workspace-editor').PrimerDisplay | null) => void;

  autoScope?: PrimerAutoScopeRequest | null;

  libraryEmpty?: boolean;

  onAutoScopeConsumed?: () => void;

  searchError?: Error | null;

  searchScopeControl?: import('react').ReactNode;
  searchDisabledReason?: UserMessage | null;
  formatSearchHitRange?: (hit: BindingHit) => string;
}

export function PrimersDrawerContent({
  primers,
  isLoading,
  error,
  onRetry,
  selectedBindingId,
  onPrimerClick,
  onDetach,
  pendingBindingEdit,
  onClearBindingEdit,
  onPrimerCreate,
  hostOwnedBinding,
  pendingCreation,
  onClearPendingCreation,
  onPreviewChange,
  onGoToBinding,
  referenceSequence,
  sequenceId,
  sequenceLength,
  bindingCoordinateOffset,
  circular,
  workspaceId,
  workspaceRoot,
  targetDocumentId,
  targetFilePath,
  initialSaveDir,
  searchResults,
  isSearching,
  onSearch,
  onAttach,
  selectionRange,
  onSearchResultClick,
  onCandidatePreview,
  autoScope,
  libraryEmpty,
  onAutoScopeConsumed,
  searchError,
  searchScopeControl,
  searchDisabledReason,
  formatSearchHitRange,
}: PrimersDrawerContentProps) {
  const canFind = !!(onSearch && onAttach);
  const [activeTab, setActiveTab] = useState<DrawerTab>('attached');
  const [hasCreationSession, setHasCreationSession] = useState(!!pendingCreation);
  const [relationshipError, setRelationshipError] = useState<string | null>(null);

  const lastAutoScopeNonce = useRef(0);
  useEffect(() => {
    if (!autoScope || autoScope.nonce === lastAutoScopeNonce.current) return;
    lastAutoScopeNonce.current = autoScope.nonce;
    trackToolOpened('primers', 'menu');
    setActiveTab('find');
  }, [autoScope]);

  useEffect(() => {
    if (pendingCreation) {
      trackToolOpened('primer_design', 'menu');
      setHasCreationSession(true);
      setActiveTab('create');
    }
  }, [pendingCreation]);

  useEffect(() => {
    if (pendingBindingEdit) setActiveTab('attached');
  }, [pendingBindingEdit]);

  const handleSave = useCallback(
    async (input: CreatePrimerInput, hostBinding?: HostPrimerBinding) => {
      trackToolActionStarted('primer_design', 'sidebar', 'created');
      try {
        if (hostBinding) await onPrimerCreate(input, hostBinding);
        else await onPrimerCreate(input);
        trackToolActionCompleted('primer_design', 'sidebar', 'created');
        onClearPendingCreation?.();
        setHasCreationSession(false);
        setActiveTab('attached');
      } catch (err) {
        trackToolError('primer_design', 'sidebar', 'write_failed');
        throw err;
      }
    },
    [onPrimerCreate, onClearPendingCreation]
  );

  const handleCancel = useCallback(() => {
    onClearPendingCreation?.();
    setHasCreationSession(false);
    setActiveTab('attached');
  }, [onClearPendingCreation]);

  const handleDetach = useCallback(
    async (primer: BoundPrimer) => {
      if (!onDetach) return;
      setRelationshipError(null);
      try {
        await onDetach(primer.binding.id);
      } catch (error) {
        setRelationshipError(
          userMessageWithValues('primer.detachFailed', {
            name: userMessageValue(userEntityLabel(primer.name)),
          })
        );
        trackToolError('primers', 'sidebar', 'write_failed');
      }
    },
    [onDetach]
  );

  return (
    <div data-testid="primers-drawer" className="h-full flex flex-col">
      <div
        role="tablist"
        aria-label="Primers"
        className="flex items-center gap-1 px-2 py-1.5 border-b border-border"
      >
        <DrawerTabButton
          testId="primers-tab-attached"
          label="Attached"
          active={activeTab === 'attached'}
          onClick={() => {
            if (activeTab !== 'attached') trackToolOpened('primers', 'sidebar');
            setActiveTab('attached');
          }}
        />
        {canFind && (
          <DrawerTabButton
            testId="primers-tab-find"
            label="Find"
            active={activeTab === 'find'}
            onClick={() => {
              if (activeTab !== 'find') trackToolOpened('primers', 'sidebar');
              setActiveTab('find');
            }}
          />
        )}
        <DrawerTabButton
          testId="primers-tab-create"
          label="Create"
          active={activeTab === 'create'}
          onClick={() => {
            if (activeTab !== 'create') trackToolOpened('primer_design', 'sidebar');
            setHasCreationSession(true);
            setActiveTab('create');
          }}
        />
        {referenceSequence && (
          <DrawerTabButton
            testId="primers-tab-saturation"
            label="Saturation"
            active={activeTab === 'saturation'}
            onClick={() => setActiveTab('saturation')}
          />
        )}
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        {activeTab === 'saturation' && referenceSequence && (
          <SaturationLibraryPanel referenceSequence={referenceSequence} />
        )}
        {pendingBindingEdit && (
          <div
            hidden={activeTab !== 'attached'}
            className={activeTab === 'attached' ? '' : 'hidden'}
          >
            <PrimerBindingEditor
              key={pendingBindingEdit.binding.id}
              primer={pendingBindingEdit}
              workspaceRoot={workspaceRoot}
              targetDocumentId={targetDocumentId}
              targetFilePath={targetFilePath}
              sequenceLength={sequenceLength}
              circular={circular}
              onSaved={() => onClearBindingEdit?.()}
              onCancel={() => onClearBindingEdit?.()}
            />
          </div>
        )}
        {activeTab === 'attached' && relationshipError && (
          <div
            data-testid="primer-detach-error"
            role="alert"
            aria-live="assertive"
            className="m-3 rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300"
          >
            {toUserMessage(relationshipError, 'primer.failed')}
          </div>
        )}

        {activeTab === 'find' && canFind && (
          <PrimerSearchPanel
            results={searchResults ?? []}
            isSearching={isSearching ?? false}
            onSearch={onSearch!}
            onAttach={onAttach!}
            onResultClick={onSearchResultClick}
            onCandidatePreview={onCandidatePreview}
            sequenceLength={sequenceLength ?? 0}
            selectionRange={selectionRange ?? null}
            autoScope={autoScope}
            libraryEmpty={libraryEmpty}
            onAutoScopeConsumed={onAutoScopeConsumed}
            searchError={searchError}
            scopeControl={searchScopeControl}
            searchDisabledReason={searchDisabledReason}
            formatHitRange={formatSearchHitRange}
          />
        )}

        {hasCreationSession && (
          <div
            className="h-full flex-col border-b border-border"
            style={{ display: activeTab === 'create' ? 'flex' : 'none' }}
          >
            <PrimerCreationForm
              key={
                pendingCreation
                  ? `${pendingCreation.bindingStart}-${pendingCreation.bindingEnd}-${pendingCreation.direction}`
                  : 'manual'
              }
              initialSequence={pendingCreation?.sequence}
              initialDirection={pendingCreation?.direction}
              initialBindingStart={pendingCreation?.bindingStart}
              initialBindingEnd={pendingCreation?.bindingEnd}
              referenceSequence={referenceSequence}
              sequenceId={sequenceId}
              sequenceLength={sequenceLength}
              bindingCoordinateOffset={bindingCoordinateOffset}
              circular={circular}
              workspaceId={workspaceId}
              workspaceRoot={workspaceRoot}
              targetDocumentId={targetDocumentId}
              targetFilePath={targetFilePath}
              initialSaveDir={initialSaveDir}
              targetTopology={circular ? 'circular' : 'linear'}
              onSave={handleSave}
              hostOwnedBinding={hostOwnedBinding}
              onCancel={handleCancel}
              onPreviewChange={onPreviewChange}
              onGoToBinding={onGoToBinding}
            />
          </div>
        )}

        {activeTab === 'attached' &&
          !pendingBindingEdit &&
          (isLoading ? (
            <div className="p-4 space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-16 rounded bg-bg-muted animate-pulse" />
              ))}
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <p className="text-sm text-red-400 mb-3">Failed to load primers</p>
              <p className="text-xs text-fg-muted mb-4">{toUserMessage(error, 'primer.failed')}</p>
              {onRetry && (
                <button
                  onClick={onRetry}
                  className="text-sm px-3 py-1.5 rounded border border-border text-fg-muted hover:bg-bg-muted"
                >
                  Retry
                </button>
              )}
            </div>
          ) : primers.length === 0 ? (
            <div data-testid="primers-empty-state" className="p-6 text-center">
              <div className="text-fg-muted text-sm mb-3">No primers attached yet</div>
              <div className="text-fg-muted/60 text-xs">
                Use <span className="text-fg-muted">Create</span> to design a new primer
                {canFind ? (
                  <>
                    {' '}
                    or <span className="text-fg-muted">Find</span> to attach existing library
                    primers
                  </>
                ) : null}
                . Selecting a region first scopes both.
              </div>
            </div>
          ) : (
            <div data-testid="primers-list" role="listbox">
              {primers.map((primer) => (
                <PrimerRow
                  key={primer.binding.id}
                  primer={primer}
                  isSelected={primer.binding.id === selectedBindingId}
                  onClick={() => onPrimerClick?.(primer)}
                  onDetach={() => void handleDetach(primer)}
                />
              ))}
            </div>
          ))}
      </div>
    </div>
  );
}

type DrawerTab = 'attached' | 'find' | 'create' | 'saturation';

function DrawerTabButton({
  testId,
  label,
  active,
  onClick,
}: {
  testId: string;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      role="tab"
      aria-selected={active}
      data-testid={testId}
      data-active={active}
      onClick={onClick}
      className={`text-xs px-2.5 py-1 rounded border transition-colors ${
        active
          ? 'border-accent bg-accent/10 text-accent'
          : 'border-transparent text-fg-muted hover:bg-bg-muted hover:text-fg'
      }`}
    >
      {label}
    </button>
  );
}

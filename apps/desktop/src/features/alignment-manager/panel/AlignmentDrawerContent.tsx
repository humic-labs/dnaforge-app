import {
  userEntityLabel,
  userMessage,
  userMessageWithValues,
  toUserMessage,
} from '@waypoint/user-messages';

import { useCallback, useState, useRef, useEffect, useMemo, type DragEvent } from 'react';
import { useVerificationStore } from '../store';
import {
  useAlignmentManagerState,
  useAlignmentManagerActions,
} from '../hooks/useAlignmentManagerState';
import type { SessionMode, Mutation, VerificationTrack } from '../types';
import { safeFocus } from '../../../shared/utils/safeFocus';
import { debugLog } from '../../../utils/debug-log';
import { SegmentedControl } from '../../../components/ui';
import { resolveSessionViewPreferences } from '../utils/helpers';
import { EyeIcon, EyeOffIcon } from './icons';
import { PairwiseSessionOperationError } from '../pairwise-session-operation-client';
import { TrackMutationsPanel } from './TrackMutationsPanel';
import { SessionListItem } from './SessionListItem';
import { CloneListItem } from './CloneListItem';
import { InlineSessionForm } from './InlineSessionForm';
import type { PendingFile } from './InlineSessionForm';
import { useReferenceWatcher } from '../hooks/useReferenceWatcher';
import {
  markAlignmentSidecarAutoLoadCompleted,
  startAlignmentEnrichmentAutoLoad,
  startAlignmentSidecarAutoLoad,
  subscribeAlignmentAutoLoadCapacity,
} from './alignment-auto-load-registry';

interface AlignmentDrawerContentProps {
  documentId: string;
  sourcePath: string;
  referenceName: string;
  pendingFiles?: PendingFile[];
  onClearPendingFiles?: () => void;
  onAddFiles?: () => void;
  onDroppedFiles?: (files: File[]) => void;
  onInspectProteinContext?: (mutation: Mutation, track: VerificationTrack) => string | undefined;
  followProteinContext?: boolean;
  inspectedMutation?: { trackId: string; mutationId: string };
  onClearProteinContext?: (reason: string) => void;
}

export function AlignmentDrawerContent({
  documentId,
  sourcePath,
  referenceName,
  pendingFiles,
  onClearPendingFiles,
  onAddFiles,
  onDroppedFiles,
  onInspectProteinContext,
  followProteinContext,
  inspectedMutation,
  onClearProteinContext,
}: AlignmentDrawerContentProps) {
  const {
    verificationState,
    activeSession,
    sessionViewPreferences,
    isStale,
    staleSessionIds,
    pendingTrackIds,
  } = useAlignmentManagerState(documentId);
  const {
    registerReferenceSource,
    setActiveSession,
    removeSession,
    setSessionViewPreferences,
    createSession,
    runSessionAlignments,
    clearFocusedPosition,
    getTrackMutations,
    enrichSessionMutations,
    loadSidecar,
    setAlignmentPanelOpen,
    renameSession,
    toggleAlignmentVisibility,
    toggleTrackVisibility,
    overrideTrackStatus,
    archiveSession,
    unarchiveSession,
    removeTrack,
    checkStaleness,
    applyCheckedMutations,
  } = useAlignmentManagerActions();

  useEffect(() => {
    registerReferenceSource(documentId, sourcePath);
  }, [documentId, registerReferenceSource, sourcePath]);

  useEffect(() => {
    setAlignmentPanelOpen(documentId, true);
    return () => setAlignmentPanelOpen(documentId, false);
  }, [documentId, setAlignmentPanelOpen]);

  const [showArchived, setShowArchived] = useState(false);
  const [confirmDeleteSessionId, setConfirmDeleteSessionId] = useState<string | null>(null);
  const [statusOverrideTrackId, setStatusOverrideTrackId] = useState<string | null>(null);
  const [curationMode, setCurationMode] = useState(false);
  const [expandedReviewSources, setExpandedReviewSources] = useState(false);
  const showSourceControls = !followProteinContext || expandedReviewSources;
  const [enrichmentRetryRevision, setEnrichmentRetryRevision] = useState(0);
  const [sidecarRetryRevision, setSidecarRetryRevision] = useState(0);

  useEffect(() => {
    if (!activeSession) return;
    const key = `${documentId}::${activeSession.id}`;

    const needsEnrichment = activeSession.tracks.some(
      (t) => t.mutations.length > 0 && t.mutations.some((m) => !m.effect)
    );
    if (!needsEnrichment) return;

    const status = startAlignmentEnrichmentAutoLoad({
      key,
      run: () => enrichSessionMutations(documentId, activeSession.id),
      onRejected: (error) =>
        console.error('[AlignmentDrawerContent] Auto-enrichment failed:', error),
    });
    if (status === 'capacity') {
      console.error('[AlignmentDrawerContent] Auto-enrichment capacity reached.');
      return subscribeAlignmentAutoLoadCapacity('enrichment', key, () => {
        setEnrichmentRetryRevision((revision) => revision + 1);
      });
    }
  }, [activeSession, documentId, enrichSessionMutations, enrichmentRetryRevision]);

  useEffect(() => {
    const existing = useVerificationStore.getState().getVerificationState(documentId);
    if (existing && existing.sessions.length > 0) {
      markAlignmentSidecarAutoLoadCompleted(documentId);
      return;
    }

    const status = startAlignmentSidecarAutoLoad({
      key: documentId,
      run: () => loadSidecar(documentId),
      onLoaded: () => debugLog('[AlignmentDrawerContent] Loaded sidecar for', documentId),
      onRejected: (error) => console.error('[AlignmentDrawerContent] Sidecar load failed:', error),
    });
    if (status === 'capacity') {
      console.error('[AlignmentDrawerContent] Sidecar load capacity reached.');
      return subscribeAlignmentAutoLoadCapacity('sidecar', documentId, () => {
        setSidecarRetryRevision((revision) => revision + 1);
      });
    }
  }, [documentId, loadSidecar, sidecarRetryRevision]);

  const handleReferenceChanged = useCallback(() => {
    checkStaleness(documentId);
  }, [checkStaleness, documentId]);

  useReferenceWatcher(sourcePath, handleReferenceChanged);

  const [alignmentError, setAlignmentError] = useState<string | null>(null);

  const selectedTrackIndex = useMemo(() => {
    if (!activeSession) return 0;
    const key = `${documentId}::${activeSession.id}`;
    const prefs = sessionViewPreferences[key];
    const idx = activeSession.tracks.findIndex((t) => t.id === prefs?.selectedTrackId);
    return idx >= 0 ? idx : 0;
  }, [activeSession, documentId, sessionViewPreferences]);

  const [selectedMutationIndex, setSelectedMutationIndex] = useState<number | null>(null);

  const cloneRowRefs = useRef<(HTMLDivElement | null)[]>([]);

  const allSessions = verificationState?.sessions ?? [];
  const archivedCount = allSessions.filter((s) => s.archived).length;
  const sessions = showArchived ? allSessions : allSessions.filter((s) => !s.archived);

  const selectedTrack = useMemo(() => {
    if (!activeSession || activeSession.tracks.length === 0) return null;
    const clampedIndex = Math.min(selectedTrackIndex, activeSession.tracks.length - 1);
    return activeSession.tracks[clampedIndex] ?? null;
  }, [activeSession, selectedTrackIndex]);

  const previousProteinTrack = useRef(
    selectedTrack ? `${activeSession?.id}:${selectedTrack.id}` : null
  );
  useEffect(() => {
    const key = selectedTrack ? `${activeSession?.id}:${selectedTrack.id}` : null;
    const previous = previousProteinTrack.current;
    const changed = previous !== null && previous !== key;
    previousProteinTrack.current = key;
    if (!followProteinContext) return;
    if (previous === null && key === null) return;
    const reason = !selectedTrack
      ? userMessage('alignment.selectCloneAndMutation')
      : pendingTrackIds.has(selectedTrack.id)
        ? userMessageWithValues('alignment.waitingForAlignment', {
            clone: userEntityLabel(selectedTrack.label),
          })
        : selectedTrack.failedToRealign ||
            (activeSession && staleSessionIds.includes(activeSession.id))
          ? userMessage('alignment.staleProteinMapping')
          : changed
            ? userMessageWithValues('alignment.selectMutationFrom', {
                clone: userEntityLabel(selectedTrack.label),
              })
            : undefined;
    if (reason) onClearProteinContext?.(reason);
  }, [
    activeSession,
    selectedTrack,
    pendingTrackIds,
    staleSessionIds,
    followProteinContext,
    onClearProteinContext,
  ]);

  const selectedTrackMutationMarkers = useMemo(() => {
    if (!activeSession || !selectedTrack) return [];
    return getTrackMutations(documentId, activeSession.id, selectedTrack.id);
  }, [activeSession, selectedTrack, documentId, getTrackMutations]);

  useEffect(() => {
    setSelectedMutationIndex(null);
  }, [activeSession?.id]);

  useEffect(() => {
    const row = cloneRowRefs.current[selectedTrackIndex];
    safeFocus(row);
  }, [selectedTrackIndex]);

  const handleSelectTrackIndex = useCallback(
    (newIndex: number) => {
      if (!activeSession) return;

      const clampedIndex = Math.min(newIndex, activeSession.tracks.length - 1);
      const track = activeSession.tracks[clampedIndex];
      if (!track) return;

      setSelectedMutationIndex(null);
      debugLog('[AlignmentDrawerContent] Clearing focused position on track change');
      clearFocusedPosition();

      setSessionViewPreferences(documentId, activeSession.id, {
        selectedTrackId: track.id,
      });
    },
    [activeSession, documentId, setSessionViewPreferences, clearFocusedPosition]
  );

  const activeSessionPrefs = activeSession
    ? resolveSessionViewPreferences(
        activeSession,
        sessionViewPreferences[`${documentId}::${activeSession.id}`]
      )
    : undefined;

  const handleSetActive = useCallback(
    (sessionId: string) => {
      setActiveSession(documentId, sessionId);
    },
    [documentId, setActiveSession]
  );

  const handleDeleteSession = useCallback(
    (sessionId: string) => {
      removeSession(documentId, sessionId);
    },
    [documentId, removeSession]
  );

  const handleRemoveTrack = useCallback(
    (sessionId: string, trackId: string) => {
      removeTrack(documentId, sessionId, trackId);
    },
    [documentId, removeTrack]
  );

  const handleInlineSubmit = useCallback(
    async (name: string, mode: SessionMode) => {
      if (!pendingFiles || pendingFiles.length === 0) return;

      const queryPaths = pendingFiles.map((f) => f.path);

      const sessionId = createSession(documentId, {
        name,
        mode,
        queryPaths,
      });

      onClearPendingFiles?.();

      try {
        setAlignmentError(null);
        await runSessionAlignments(documentId, sessionId, queryPaths);
      } catch (err) {
        if (!(err instanceof PairwiseSessionOperationError && err.operationState === 'canceled')) {
          console.error('[AlignmentDrawerContent] Failed to run alignments:', err);
        }
        const message = err instanceof Error ? err.message : 'Alignment failed';
        setAlignmentError(toUserMessage(message, 'alignment.failed'));
        setTimeout(() => setAlignmentError(null), 10000);
      }
    },
    [documentId, pendingFiles, createSession, runSessionAlignments, onClearPendingFiles]
  );

  const hasPendingFiles = pendingFiles && pendingFiles.length > 0;

  const handleDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!onDroppedFiles) return;
      if (!event.dataTransfer?.types.includes('Files')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    },
    [onDroppedFiles]
  );

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!onDroppedFiles) return;
      const files = event.dataTransfer ? Array.from(event.dataTransfer.files) : [];
      if (files.length === 0) return;
      event.preventDefault();
      onDroppedFiles(files);
    },
    [onDroppedFiles]
  );

  return (
    <div
      className="h-full flex flex-col bg-bg text-fg"
      data-testid="alignment-drop-target"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <div>
            <h2 className="text-sm font-medium">Alignments</h2>
            <p className="text-xs text-fg-muted">{referenceName}</p>
          </div>
          {activeSession && (
            <button
              onClick={() => toggleAlignmentVisibility(documentId, activeSession.id)}
              className={`p-1.5 rounded transition-colors ${
                activeSessionPrefs?.alignmentVisible === false
                  ? 'text-fg-muted wp-interactive bg-bg-subtle'
                  : 'text-accent hover:text-accent/80'
              }`}
              title={
                activeSessionPrefs?.alignmentVisible === false
                  ? 'Show alignment in viewer'
                  : 'Hide alignment from viewer'
              }
            >
              {activeSessionPrefs?.alignmentVisible === false ? <EyeOffIcon /> : <EyeIcon />}
            </button>
          )}
        </div>
        {!hasPendingFiles && (
          <button
            onClick={onAddFiles}
            className="px-3 py-1.5 text-xs bg-accent text-white rounded hover:bg-accent/80"
            aria-label="New Alignment"
          >
            + New
          </button>
        )}
      </div>

      {activeSession && activeSession.tracks.length > 1 && activeSessionPrefs && (
        <div
          role="group"
          aria-label="Reads shown in viewer"
          className="flex items-center gap-2 px-4 py-2"
        >
          <SegmentedControl
            value={activeSessionPrefs.viewMode}
            options={[
              { value: 'single', label: 'Selected read' },
              { value: 'stacked', label: 'All reads' },
            ]}
            onChange={(value) =>
              setSessionViewPreferences(documentId, activeSession.id, {
                viewMode: value === 'stacked' ? 'stacked' : 'single',
              })
            }
          />
        </div>
      )}

      {alignmentError && (
        <div
          className="mx-4 mt-2 p-3 bg-red-500/10 border border-red-500/30 rounded text-sm text-red-400 flex items-center justify-between"
          role="alert"
        >
          <span>{toUserMessage(alignmentError, 'alignment.failed')}</span>
          <button
            onClick={() => setAlignmentError(null)}
            className="ml-2 text-red-400 hover:text-red-300"
            aria-label="Dismiss error"
          >
            ✕
          </button>
        </div>
      )}

      {isStale && (
        <div
          className="mx-4 mt-2 p-3 bg-amber-500/10 border border-amber-600/40 dark:border-yellow-500/30 rounded text-sm text-amber-700 dark:text-yellow-300"
          role="alert"
        >
          <div className="flex items-center justify-between">
            <span>Reference sequence has changed. Alignments may be outdated.</span>
            <div className="flex items-center gap-2 ml-2 flex-shrink-0">
              {verificationState && (
                <button
                  onClick={async () => {
                    setAlignmentError(null);
                    const staleSessions = verificationState.sessions.filter((s) =>
                      staleSessionIds.includes(s.id)
                    );
                    const sessionsToRun =
                      staleSessions.length > 0 ? staleSessions : verificationState.sessions;
                    for (const session of sessionsToRun) {
                      const queryPaths = session.tracks.map((t) => t.queryPath);
                      try {
                        await runSessionAlignments(documentId, session.id, queryPaths);
                      } catch (err) {
                        console.error(
                          `[AlignmentDrawerContent] Re-run failed for session ${session.name}:`,
                          err
                        );
                        const message = err instanceof Error ? err.message : 'Re-alignment failed';
                        setAlignmentError(toUserMessage(message, 'alignment.failed'));
                        setTimeout(() => setAlignmentError(null), 10000);
                      }
                    }
                  }}
                  className="px-2 py-1 text-xs bg-amber-600/20 hover:bg-amber-600/30 dark:bg-yellow-500/20 dark:hover:bg-yellow-500/30 rounded transition-colors"
                >
                  Re-run all
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-hidden p-4 flex flex-col">
        {hasPendingFiles && (
          <InlineSessionForm
            files={pendingFiles}
            referenceName={referenceName}
            onCancel={() => onClearPendingFiles?.()}
            onSubmit={handleInlineSubmit}
            onAddFiles={onAddFiles}
          />
        )}

        {sessions.length === 0 && !hasPendingFiles && (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="text-fg-muted mb-4">
              <svg
                className="w-12 h-12 mx-auto mb-2 opacity-50"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                />
              </svg>
              <p>No alignments</p>
              <p className="text-xs mt-1">
                {onDroppedFiles
                  ? onAddFiles
                    ? 'Drop sequencing files here or click "+ New" to start'
                    : 'Drop sequencing files here to start.'
                  : onAddFiles
                    ? 'Click "+ New" to select sequencing files.'
                    : 'No sequencing files have been added.'}
              </p>
            </div>
          </div>
        )}

        {sessions.length > 0 && (
          <div className="-mx-4 flex-1 min-h-0 flex flex-col overflow-y-auto">
            {followProteinContext && (
              <button
                type="button"
                aria-label="Alignment and clone controls"
                aria-expanded={expandedReviewSources}
                onClick={() => setExpandedReviewSources((expanded) => !expanded)}
                className="flex shrink-0 items-center gap-2 border-y border-border bg-bg-subtle px-4 py-2 text-left text-xs"
              >
                <span aria-hidden="true">{expandedReviewSources ? '▾' : '▸'}</span>
                <span
                  className="truncate"
                  title={`${activeSession?.name ?? 'Alignment'} · ${selectedTrack?.label ?? 'Choose clone'}`}
                >
                  {activeSession?.name ?? 'Alignment'} · {selectedTrack?.label ?? 'Choose clone'}
                </span>
              </button>
            )}
            {showSourceControls && (
              <>
                <div className="px-4 py-2 bg-bg-subtle border-y border-border flex items-center justify-between">
                  <span className="text-xs font-semibold text-fg uppercase tracking-wide">
                    Alignments
                  </span>
                  <div className="flex items-center gap-2">
                    {archivedCount > 0 && (
                      <button
                        onClick={() => setShowArchived(!showArchived)}
                        className={`text-xs transition-colors ${
                          showArchived ? 'text-accent' : 'text-fg-muted wp-interactive'
                        }`}
                      >
                        {showArchived ? 'Hide' : 'Show'} archived ({archivedCount})
                      </button>
                    )}
                    <span className="text-xs text-fg-muted">{sessions.length}</span>
                  </div>
                </div>
                <div className="max-h-32 shrink-0 overflow-y-auto">
                  {sessions.map((session) => {
                    const sessionPendingKey = `${documentId}::${session.id}`;
                    const sessionPending =
                      useVerificationStore.getState().pendingTrackIds[sessionPendingKey];
                    const sessionPendingCount = sessionPending?.size ?? 0;
                    return (
                      <SessionListItem
                        key={session.id}
                        session={session}
                        isActive={session.id === verificationState?.activeSessionId}
                        isStale={staleSessionIds.includes(session.id)}
                        isPending={sessionPendingCount > 0}
                        pendingCount={sessionPendingCount}
                        isConfirmingDelete={confirmDeleteSessionId === session.id}
                        onSetActive={handleSetActive}
                        onRename={(sessionId, name) => renameSession(documentId, sessionId, name)}
                        onRerun={async (sessionId) => {
                          const s = verificationState?.sessions.find(
                            (sess) => sess.id === sessionId
                          );
                          if (!s) return;
                          try {
                            setAlignmentError(null);
                            await runSessionAlignments(
                              documentId,
                              sessionId,
                              s.tracks.map((t) => t.queryPath)
                            );
                          } catch (err) {
                            const message =
                              err instanceof Error ? err.message : 'Re-alignment failed';
                            setAlignmentError(toUserMessage(message, 'alignment.failed'));
                            setTimeout(() => setAlignmentError(null), 10000);
                          }
                        }}
                        onArchive={(sessionId) => archiveSession(documentId, sessionId)}
                        onUnarchive={(sessionId) => unarchiveSession(documentId, sessionId)}
                        onRequestDelete={(sessionId) => setConfirmDeleteSessionId(sessionId)}
                        onCancelDelete={() => setConfirmDeleteSessionId(null)}
                        onConfirmDelete={(sessionId) => {
                          handleDeleteSession(sessionId);
                          setConfirmDeleteSessionId(null);
                        }}
                      />
                    );
                  })}
                </div>
              </>
            )}

            <div className="border-l-[6px] border-accent flex-1 shrink-0 flex flex-col">
              {showSourceControls && (
                <>
                  <div className="px-4 py-2 bg-bg-subtle border-y border-border flex items-center justify-between">
                    <span className="text-xs font-semibold text-fg uppercase tracking-wide">
                      Clones
                    </span>
                    {activeSession && (
                      <span className="text-xs text-fg-muted">{activeSession.name}</span>
                    )}
                  </div>

                  {activeSession && activeSession.tracks.length > 0 ? (
                    <div
                      role="listbox"
                      aria-label="Clones"
                      className="max-h-40 shrink-0 overflow-y-auto"
                    >
                      {activeSession.tracks.map((track, index) => {
                        const prefsKey = `${documentId}::${activeSession.id}`;
                        const hiddenIds = sessionViewPreferences[prefsKey]?.hiddenTrackIds ?? [];
                        const isTrackHidden = hiddenIds.includes(track.id);

                        return (
                          <CloneListItem
                            key={track.id}
                            ref={(el) => {
                              cloneRowRefs.current[index] = el;
                            }}
                            track={track}
                            index={index}
                            isSelected={index === selectedTrackIndex}
                            isStale={staleSessionIds.includes(activeSession.id)}
                            isPending={pendingTrackIds.has(track.id)}
                            isTrackHidden={isTrackHidden}
                            statusOverrideTrackId={statusOverrideTrackId}
                            onSelect={handleSelectTrackIndex}
                            onKeyDown={(e, idx, maxIdx) => {
                              if (e.key === 'ArrowDown') {
                                e.preventDefault();
                                handleSelectTrackIndex(Math.min(idx + 1, maxIdx));
                              } else if (e.key === 'ArrowUp') {
                                e.preventDefault();
                                handleSelectTrackIndex(Math.max(idx - 1, 0));
                              } else if (e.key === 'Home') {
                                e.preventDefault();
                                handleSelectTrackIndex(0);
                              } else if (e.key === 'End') {
                                e.preventDefault();
                                handleSelectTrackIndex(maxIdx);
                              }
                            }}
                            onToggleVisibility={() =>
                              toggleTrackVisibility(documentId, activeSession.id, track.id)
                            }
                            onStatusOverrideToggle={() =>
                              setStatusOverrideTrackId(
                                statusOverrideTrackId === track.id ? null : track.id
                              )
                            }
                            onStatusOverride={(status, reason) => {
                              overrideTrackStatus(
                                documentId,
                                activeSession.id,
                                track.id,
                                status,
                                reason
                              );
                            }}
                            onStatusOverrideClose={() => setStatusOverrideTrackId(null)}
                            onRename={(label) =>
                              useVerificationStore
                                .getState()
                                .renameTrack(documentId, activeSession.id, track.id, label)
                            }
                            onRemove={
                              track.evidenceRunId
                                ? undefined
                                : () => handleRemoveTrack(activeSession.id, track.id)
                            }
                            maxIndex={activeSession.tracks.length - 1}
                          />
                        );
                      })}
                    </div>
                  ) : (
                    <div className="px-4 py-3 text-sm text-fg-muted">
                      {activeSession ? 'No clones' : 'Select an alignment'}
                    </div>
                  )}
                </>
              )}

              <div className="border-l-[6px] border-accent/50 flex-1 min-h-48 flex flex-col overflow-hidden">
                <div className="px-4 py-2 bg-bg-subtle border-y border-border flex items-center justify-between">
                  <span className="text-xs font-semibold text-fg uppercase tracking-wide">
                    Mutations
                  </span>
                  <div className="flex items-center gap-2">
                    {curationMode &&
                      selectedTrack &&
                      (selectedTrack.checkedMutations?.length ?? 0) > 0 && (
                        <button
                          onClick={async () => {
                            if (!activeSession || !selectedTrack) return;
                            try {
                              await applyCheckedMutations(
                                documentId,
                                activeSession.id,
                                selectedTrack.id
                              );
                              setCurationMode(false);
                            } catch (err) {
                              const message = err instanceof Error ? err.message : 'Apply failed';
                              setAlignmentError(toUserMessage(message, 'alignment.failed'));
                              setTimeout(() => setAlignmentError(null), 10000);
                            }
                          }}
                          className="px-3 py-1.5 text-xs bg-green-600 text-white rounded hover:bg-green-500"
                        >
                          Apply {selectedTrack.checkedMutations?.length ?? 0} changes
                        </button>
                      )}
                    {selectedTrack && (
                      <button
                        onClick={() => setCurationMode(!curationMode)}
                        className={`text-xs px-2 py-1 rounded transition-colors ${
                          curationMode ? 'bg-accent text-white' : 'text-fg-muted wp-interactive '
                        }`}
                      >
                        {curationMode ? 'Done' : 'Review'}
                      </button>
                    )}
                  </div>
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto">
                  {selectedTrack && pendingTrackIds.has(selectedTrack.id) ? (
                    <div className="px-4 py-3 text-sm text-fg-muted italic">Aligning…</div>
                  ) : selectedTrack ? (
                    <TrackMutationsPanel
                      track={selectedTrack}
                      mutationMarkers={selectedTrackMutationMarkers}
                      selectedMutationIndex={selectedMutationIndex}
                      onSelectMutation={setSelectedMutationIndex}
                      documentId={documentId}
                      curationMode={curationMode}
                      sessionId={activeSession?.id}
                      onInspectProteinContext={onInspectProteinContext}
                      followProteinContext={followProteinContext}
                      inspectedMutationId={
                        inspectedMutation?.trackId === selectedTrack.id
                          ? inspectedMutation.mutationId
                          : undefined
                      }
                      onClearProteinContext={onClearProteinContext}
                      proteinContextBlockedReason={
                        selectedTrack.failedToRealign ||
                        (activeSession && staleSessionIds.includes(activeSession.id))
                          ? userMessage('alignment.staleProteinMapping')
                          : undefined
                      }
                    />
                  ) : (
                    <div className="px-4 py-3 text-sm text-fg-muted">Select a clone</div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

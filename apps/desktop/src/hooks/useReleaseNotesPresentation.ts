import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { APP_BUILD } from '../lib/app-build';
import {
  trackRendererEvent,
  isAnalyticsCaptureReady,
  getAnalyticsIdentifiedAccountId,
} from '../lib/analytics';
import { getTelemetryCorrelationContext } from '../lib/telemetry-correlation';
import { RELEASE_NOTES_OBSERVED, type ReleaseNotesObservedProps } from '../lib/analytics-events';
import {
  publicReleaseNoteIdentity,
  resolveReleaseNotesRequest,
  validatedBuildReleaseIdentity,
} from '../lib/release-notes-presentation';
import { installedReleaseVersion } from '../shared/app-build-identity';
import type {
  ReleaseNotesCloseReason,
  ReleaseNotesPhase,
  ReleaseNotesSource,
} from '../shared/release-notes-telemetry';
import { safeFocus } from '../shared/utils/safeFocus';

type Presentation = {
  id: string | null;

  observationOrigin: { account: string | null; session: string; episode: string } | null;
  source: ReleaseNotesSource;
  request: ReturnType<typeof resolveReleaseNotesRequest>;
  opener: HTMLElement | null;
  displayed: string | null;
  result: 'available' | 'missing';
};

function emit(
  presentation: Presentation,
  phase: ReleaseNotesPhase,
  closeReason?: ReleaseNotesCloseReason
) {
  if (!presentation.id || presentation.displayed === null || !presentation.observationOrigin)
    return;
  try {
    const original = presentation.observationOrigin;
    if (!isAnalyticsCaptureReady() || getAnalyticsIdentifiedAccountId() !== original.account)
      return;
    const currentContext = getTelemetryCorrelationContext();
    if (
      currentContext.appSessionId !== original.session ||
      currentContext.episodeCorrelationId !== original.episode
    )
      return;
    trackRendererEvent(RELEASE_NOTES_OBSERVED, {
      feature_area: 'navigation',
      presentation_id: presentation.id,
      occurred_at_ms: Date.now(),
      notes_phase: phase,
      notes_source: presentation.source,
      notes_requested_kind: presentation.request.kind,
      notes_requested_version: publicReleaseNoteIdentity(presentation.request.version),
      notes_displayed_version: presentation.displayed,
      notes_result: presentation.result,
      notes_artifact_kind: APP_BUILD.kind,
      notes_installed_version: validatedBuildReleaseIdentity(installedReleaseVersion(APP_BUILD)),
      notes_source_version: validatedBuildReleaseIdentity(APP_BUILD.sourceReleaseVersion),
      notes_capability: 'information_only',
      ...(closeReason ? { notes_close_reason: closeReason } : {}),
    } satisfies ReleaseNotesObservedProps);
  } catch (ignoredError) {
    void ignoredError;
  }
}

function restoreFocus(opener: HTMLElement | null) {
  const focus = (element: HTMLElement | null) => {
    if (
      !element ||
      element.closest('[hidden], [inert], [aria-hidden="true"], [data-toast-phase="exiting"]') ||
      element.matches(':disabled')
    )
      return false;
    for (let node: HTMLElement | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    try {
      return safeFocus(element, { preventScroll: true }) && document.activeElement === element;
    } catch {
      return false;
    }
  };
  if (!focus(opener)) focus(document.querySelector<HTMLElement>('[data-testid="settings-button"]'));
}

export function useReleaseNotesPresentation() {
  const [presentation, setPresentation] = useState<Presentation | null>(null);
  const current = useRef<Presentation | null>(null);
  const closing = useRef<{ presentation: Presentation; reason: ReleaseNotesCloseReason } | null>(
    null
  );

  const open = useCallback(
    (source: ReleaseNotesSource, initialVersion?: string, sourceElement?: HTMLElement) => {
      if (current.current || closing.current) return;
      let id: string | null = null;
      try {
        id = crypto.randomUUID();
      } catch (ignoredError) {
        void ignoredError;
      }
      let observationOrigin: Presentation['observationOrigin'] = null;
      try {
        if (isAnalyticsCaptureReady()) {
          const context = getTelemetryCorrelationContext();
          observationOrigin = {
            account: getAnalyticsIdentifiedAccountId(),
            session: context.appSessionId,
            episode: context.episodeCorrelationId,
          };
        }
      } catch (ignoredError) {
        void ignoredError;
      }
      const accepted: Presentation = {
        id,
        observationOrigin,
        source,
        request: resolveReleaseNotesRequest(APP_BUILD, initialVersion),
        opener:
          sourceElement ??
          (document.activeElement instanceof HTMLElement ? document.activeElement : null),
        displayed: null,
        result: 'missing',
      };
      current.current = accepted;
      setPresentation(accepted);
    },
    []
  );

  const close = useCallback((reason: ReleaseNotesCloseReason = 'close') => {
    const accepted = current.current;
    if (!accepted) return;
    current.current = null;
    closing.current = { presentation: accepted, reason };
    setPresentation(null);
  }, []);

  useLayoutEffect(() => {
    if (presentation !== null || !closing.current) return;
    const accepted = closing.current;
    closing.current = null;
    emit(accepted.presentation, 'closed', accepted.reason);
    restoreFocus(accepted.presentation.opener);
  }, [presentation]);

  const displayed = useCallback(
    (version: string) => {
      if (!presentation || current.current !== presentation) return;
      const identity = publicReleaseNoteIdentity(version);
      const result = identity === 'unknown' || identity === 'missing' ? 'missing' : 'available';
      const prior = presentation.displayed;
      if (prior === identity && presentation.result === result) return;
      presentation.displayed = identity;
      presentation.result = result;
      emit(presentation, prior === null ? 'presented' : 'version_changed');
    },
    [presentation]
  );

  return {
    open,
    modalProps: {
      open: presentation !== null,
      onClose: close,
      onDisplayed: displayed,
      initialVersion: presentation?.request.version,
    },
  };
}

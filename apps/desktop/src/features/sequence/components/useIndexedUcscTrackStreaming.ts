import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import {
  sameAdmittedTrackSourceIdentity,
  type PileupReferenceInterval,
} from '@waypoint/genome-data';
import type { Assembly } from '@waypoint/genome-renderer';

import type { Lane } from '../lane-contract-store';
import { UCSC_TRACK_RECOVERING_STATUS } from '../ucsc-streaming-status';
import {
  UcscTrackStreamingController,
  type UcscStreamingDebug,
} from '../ucsc-track-streaming-controller';
import type { IndexedGenomeTileNativeMapHandle } from './IndexedGenomeTileNativeMap';
import type { UcscRenderableRecord } from '../ucsc-tile-types';
import { isTrustedRemoteSignalUrl } from '../remote-signal-url';

const REMOTE_SIGNAL_RECONNECT_MAX_DELAY_MS = 30_000;

interface RemoteSignalRecoveryEpisode {
  readonly identity: string;
  readonly alignmentTrackId: string;
  attempt: number;
  timer: ReturnType<typeof globalThis.setTimeout> | null;
  reconnecting: boolean;
  complete: boolean;
}

export interface IndexedUcscStreamingController {
  noteLaneContractWired(reseededTrackIds?: ReadonlyArray<string>): void;
  retryFailedTiles(): void;
  readonly trackErrors: Readonly<Record<string, string>>;
}

export function useIndexedUcscTrackStreaming(input: {
  webglRef: { readonly current: IndexedGenomeTileNativeMapHandle | null };
  rendererAssembly: Assembly | null;
  containerWidth: number;
  activeLanes: ReadonlyArray<Lane>;
  onTrackRecordsPublished?: (
    trackId: string,
    records: ReadonlyArray<UcscRenderableRecord>,
    revision: string
  ) => void;
  onTrackPendingIntervalsPublished?: (
    trackId: string,
    intervals: ReadonlyArray<PileupReferenceInterval>
  ) => void;
  reconnectRemoteTrack?: (trackId: string) => Promise<boolean>;
}): IndexedUcscStreamingController {
  const widthRef = useRef(input.containerWidth);
  widthRef.current = input.containerWidth;
  const latestActiveLanesRef = useRef(input.activeLanes);
  latestActiveLanesRef.current = input.activeLanes;
  const controllerRef = useRef<UcscTrackStreamingController | null>(null);
  const onTrackRecordsPublishedRef = useRef(input.onTrackRecordsPublished);
  onTrackRecordsPublishedRef.current = input.onTrackRecordsPublished;
  const onTrackPendingIntervalsPublishedRef = useRef(input.onTrackPendingIntervalsPublished);
  onTrackPendingIntervalsPublishedRef.current = input.onTrackPendingIntervalsPublished;
  const reconnectRemoteTrackRef = useRef(input.reconnectRemoteTrack);
  reconnectRemoteTrackRef.current = input.reconnectRemoteTrack;
  const remoteSignalRecoveryRef = useRef(new Map<string, RemoteSignalRecoveryEpisode>());
  const [trackErrors, setTrackErrors] = useState<Readonly<Record<string, string>>>({});
  const trackErrorsRef = useRef(trackErrors);
  trackErrorsRef.current = trackErrors;
  const publishTrackErrors = useCallback((next: Readonly<Record<string, string>>) => {
    if (sameTrackErrors(trackErrorsRef.current, next)) return;
    trackErrorsRef.current = next;
    setTrackErrors(next);
  }, []);
  const noteLaneContractWired = useCallback((reseededTrackIds?: ReadonlyArray<string>) => {
    controllerRef.current?.refreshPresentationOwner(reseededTrackIds);
  }, []);
  const retryFailedTiles = useCallback(() => {
    controllerRef.current?.retryFailedTiles();
  }, []);

  useEffect(() => {
    if (!input.rendererAssembly) {
      publishTrackErrors({});
      return;
    }
    let disposed = false;
    let retryFrame: number | null = null;
    let unsubscribe: (() => void) | undefined;
    let previous:
      | { readonly start: number; readonly end: number; readonly viewportPx: number }
      | undefined;

    const controller = new UcscTrackStreamingController({
      assembly: input.rendererAssembly,
      lanes: latestActiveLanesRef.current,
      target: {
        getRenderer: () => input.webglRef.current?.getLinearRenderer?.() ?? null,
        requestRender: () => input.webglRef.current?.requestRender(),
        publishDebug: (debug: UcscStreamingDebug) => {
          const statuses: Record<string, string> = {};
          for (const trackId of debug.recoveringTrackIds ?? []) {
            statuses[trackId] = UCSC_TRACK_RECOVERING_STATUS;
          }
          publishTrackErrors({ ...debug.errorsByTrackId, ...statuses });
          if (typeof window === 'undefined') return;
          (
            window as Window & {
              __ucscTrackDebug?: UcscStreamingDebug;
            }
          ).__ucscTrackDebug = debug;
        },
        publishTrackRecords: (trackId, records, revision) =>
          onTrackRecordsPublishedRef.current?.(trackId, records, revision),
        publishTrackPendingIntervals: (trackId, intervals) =>
          onTrackPendingIntervalsPublishedRef.current?.(trackId, intervals),
      },
    });
    controllerRef.current = controller;

    const observeViewport = () => {
      if (disposed) return;
      const range = input.webglRef.current?.getViewportRange?.();
      if (!range) return;
      const viewportPx = Math.max(1, widthRef.current);
      if (
        previous &&
        previous.start === range.start &&
        previous.end === range.end &&
        previous.viewportPx === viewportPx
      ) {
        return;
      }
      previous = { ...range, viewportPx };
      controller.setViewport({
        globalStart: range.start,
        globalEnd: range.end,
        viewportPx,
      });
    };

    const attach = () => {
      if (disposed) return;
      const map = input.webglRef.current;
      if (!map) {
        retryFrame = requestAnimationFrame(attach);
        return;
      }
      unsubscribe = map.subscribeToPresentedFrames(observeViewport);
      observeViewport();
      map.requestRender();
    };
    attach();

    return () => {
      disposed = true;
      if (controllerRef.current === controller) controllerRef.current = null;
      controller.dispose();
      unsubscribe?.();
      if (retryFrame !== null) cancelAnimationFrame(retryFrame);
    };
  }, [input.rendererAssembly, input.webglRef, publishTrackErrors]);

  useLayoutEffect(() => {
    controllerRef.current?.updateActiveLanes(input.activeLanes);
  }, [input.activeLanes]);

  useEffect(() => {
    const recoveries = remoteSignalRecoveryRef.current;
    const reconnect = reconnectRemoteTrackRef.current;
    const activeRecoveryTrackIds = new Set<string>();

    const clearRecovery = (trackId: string): void => {
      const recovery = recoveries.get(trackId);
      if (!recovery) return;
      if (recovery.timer !== null) globalThis.clearTimeout(recovery.timer);
      recoveries.delete(trackId);
    };

    const scheduleRecovery = (trackId: string, recovery: RemoteSignalRecoveryEpisode): void => {
      if (recovery.timer !== null || recovery.reconnecting || recovery.complete) return;
      const delayMs =
        recovery.attempt === 0
          ? 0
          : Math.min(
              REMOTE_SIGNAL_RECONNECT_MAX_DELAY_MS,
              1_000 * 2 ** Math.min(5, recovery.attempt - 1)
            );
      recovery.timer = globalThis.setTimeout(() => {
        recovery.timer = null;
        if (recoveries.get(trackId) !== recovery || recovery.complete) return;
        const liveReconnect = reconnectRemoteTrackRef.current;
        if (!liveReconnect) {
          clearRecovery(trackId);
          return;
        }
        recovery.reconnecting = true;
        void liveReconnect(recovery.alignmentTrackId)
          .then((handled) => {
            if (recoveries.get(trackId) !== recovery) return;
            recovery.reconnecting = false;
            recovery.attempt += 1;
            if (handled) {
              recovery.complete = true;
              return;
            }
            recovery.complete = true;
          })
          .catch(() => {
            if (recoveries.get(trackId) !== recovery) return;
            recovery.reconnecting = false;
            recovery.attempt += 1;
            scheduleRecovery(trackId, recovery);
          });
      }, delayMs);
    };

    if (reconnect) {
      for (const trackId of Object.keys(trackErrors)) {
        const target = remoteSignalRecoveryTarget(input.activeLanes, trackId);
        if (!target) continue;
        activeRecoveryTrackIds.add(trackId);
        let recovery = recoveries.get(trackId);
        if (!recovery || recovery.identity !== target.identity) {
          clearRecovery(trackId);
          recovery = {
            identity: target.identity,
            alignmentTrackId: target.alignmentTrackId,
            attempt: 0,
            timer: null,
            reconnecting: false,
            complete: false,
          };
          recoveries.set(trackId, recovery);
        }
        scheduleRecovery(trackId, recovery);
      }
    }
    for (const trackId of [...recoveries.keys()]) {
      if (!activeRecoveryTrackIds.has(trackId)) clearRecovery(trackId);
    }
  }, [input.activeLanes, input.reconnectRemoteTrack, trackErrors]);

  useEffect(
    () => () => {
      for (const recovery of remoteSignalRecoveryRef.current.values()) {
        if (recovery.timer !== null) globalThis.clearTimeout(recovery.timer);
      }
      remoteSignalRecoveryRef.current.clear();
    },
    []
  );

  return { noteLaneContractWired, retryFailedTiles, trackErrors };
}

function remoteSignalRecoveryTarget(
  lanes: ReadonlyArray<Lane>,
  quantitativeTrackId: string
): { readonly identity: string; readonly alignmentTrackId: string } | null {
  const signalLane = lanes.find((lane) => lane.dataset.trackId === quantitativeTrackId);
  if (!signalLane?.source || !isTrustedRemoteSignalUrl(signalLane.source.uri)) return null;
  const hybridLane = lanes.find(
    (lane) => lane.dataset.experimentalHybrid?.quantitativeTrackId === quantitativeTrackId
  );
  const alignmentTrackId = hybridLane?.dataset.experimentalHybrid?.alignmentTrackId;
  if (!alignmentTrackId) {
    if (!signalLane.dataset.remoteSignal) return null;
    return {
      alignmentTrackId: quantitativeTrackId,
      identity: `${signalLane.source.fingerprint}\u0000${signalLane.source.uri}\u0000${quantitativeTrackId}`,
    };
  }
  const alignmentLane = lanes.find((lane) => lane.dataset.trackId === alignmentTrackId);
  if (!alignmentLane?.dataset.source?.remote?.locator) return null;
  return {
    alignmentTrackId,
    identity: `${signalLane.source.fingerprint}\u0000${signalLane.source.uri}\u0000${alignmentTrackId}`,
  };
}

function sameTrackErrors(
  previous: Readonly<Record<string, string>>,
  next: Readonly<Record<string, string>>
): boolean {
  const previousKeys = Object.keys(previous);
  const nextKeys = Object.keys(next);
  return (
    previousKeys.length === nextKeys.length &&
    previousKeys.every((trackId) => previous[trackId] === next[trackId])
  );
}

export function sameStreamingLanes(
  previous: ReadonlyArray<Lane>,
  next: ReadonlyArray<Lane>
): boolean {
  const previousByTrackId = new Map(
    previous.filter(isStreamingLane).map((lane) => [lane.dataset.trackId, lane.source] as const)
  );
  const nextStreaming = next.filter(isStreamingLane);
  if (previousByTrackId.size !== nextStreaming.length) return false;
  return nextStreaming.every((lane) => {
    const previousSource = previousByTrackId.get(lane.dataset.trackId);
    return previousSource !== undefined && sameTrackSource(previousSource, lane.source);
  });
}

function isStreamingLane(
  lane: Lane | undefined
): lane is Lane & { source: NonNullable<Lane['source']> } {
  return lane?.visible === true && lane.dataset.kind !== 'pileup' && lane.source !== undefined;
}

function sameTrackSource(
  previous: NonNullable<Lane['source']>,
  next: NonNullable<Lane['source']>
): boolean {
  return sameAdmittedTrackSourceIdentity(previous, next);
}

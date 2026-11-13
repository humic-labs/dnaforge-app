import { randomUUID } from 'node:crypto';
import {
  hostedReferenceInstallStage,
  type HostedReferenceInstallPhase,
  type HostedReferenceInstallStage,
} from '../../shared/hosted-reference-install-telemetry';

export type HostedReferenceInstallObservation = {
  readonly feature_area: 'scientific_workflow';
  readonly install_phase: HostedReferenceInstallPhase;
  readonly operation_id: string;
  readonly occurred_at_ms: number;
  readonly origin_started_at_ms: number;
  readonly duration_ms?: number;
  readonly is_update?: boolean;
  readonly used_bundle_fallback?: boolean;
  readonly annotations_ready?: boolean;
  readonly install_stage?: HostedReferenceInstallStage;
};

export type HostedReferenceInstallObserver = (
  observation: HostedReferenceInstallObservation
) => void;

export interface HostedReferenceInstallObservationHandle {
  progress(phase: string): void;
  previousVersion(present: boolean): void;
  annotationReady(): void;
  ready(): void;
  failed(lastPhase: string | undefined, annotationsReady: boolean): void;
}

export function beginHostedReferenceInstallObservation(
  observe: HostedReferenceInstallObserver | undefined,
  now: () => number = Date.now
): HostedReferenceInstallObservationHandle {
  const operationId = randomUUID();
  const startedAt = now();
  let phase: 'started' | 'annotation_ready' | 'terminal' = 'started';
  let isUpdate: boolean | undefined;
  let usedBundleFallback = false;
  type Stage = Pick<
    HostedReferenceInstallObservation,
    'install_phase' | 'install_stage' | 'annotations_ready'
  >;
  const emit = (stage: Stage): void => {
    try {
      const occurredAt = stage.install_phase === 'started' ? startedAt : now();
      observe?.({
        feature_area: 'scientific_workflow',
        operation_id: operationId,
        occurred_at_ms: occurredAt,
        origin_started_at_ms: startedAt,
        ...stage,
        ...(stage.install_phase === 'started'
          ? {}
          : {
              duration_ms: Math.max(0, occurredAt - startedAt),
              used_bundle_fallback: usedBundleFallback,
              ...(isUpdate === undefined ? {} : { is_update: isUpdate }),
            }),
      });
    } catch {}
  };
  const settle = (stage: Stage & { install_phase: 'ready' | 'failed' }) => {
    if (phase === 'terminal') return;
    phase = 'terminal';
    emit(stage);
  };
  emit({ install_phase: 'started' });
  return {
    progress(phase) {
      if (phase === 'prepared-bundle-fallback') usedBundleFallback = true;
    },
    previousVersion(present) {
      isUpdate = present;
    },
    annotationReady() {
      if (phase !== 'started') return;
      phase = 'annotation_ready';
      emit({ install_phase: 'annotation_ready' });
    },
    ready() {
      settle({ install_phase: 'ready' });
    },
    failed(lastPhase, annotationsReady) {
      settle({
        install_phase: 'failed',
        install_stage: hostedReferenceInstallStage(lastPhase),
        annotations_ready: annotationsReady,
      });
    },
  };
}

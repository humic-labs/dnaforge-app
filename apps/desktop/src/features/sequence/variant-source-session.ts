import { withUserMessage } from '@waypoint/user-messages';
import {
  requireTrackAdmissionRequest,
  sameAdmittedTrackSourceIdentity,
  type AdmittedTrackSource,
} from '@waypoint/genome-data';

import { forgetPreparedVariantSource } from './prepared-variant-source-cache';
import { admitTrackSource } from './track-admission';
import {
  isVariantSourceChangedError,
  VariantRequestError,
  type VariantReferenceIdentity,
} from './variant-client';
import type { VariantTrackRuntime } from './variant-track-admission';

const GRANT_REFRESH_SKEW_MS = 30_000;

export interface VariantSourceSession {
  execute<T>(signal: AbortSignal, query: (runtime: VariantTrackRuntime) => Promise<T>): Promise<T>;
  dispose(): void;
}

export function createVariantSourceSession(input: {
  readonly source: AdmittedTrackSource;
  readonly assemblyReferences: ReadonlyArray<VariantReferenceIdentity>;
  readonly admit?: typeof admitTrackSource;
}): VariantSourceSession {
  const admit = input.admit ?? admitTrackSource;
  let state:
    | { phase: 'idle' }
    | { phase: 'ready'; runtime: VariantTrackRuntime }
    | { phase: 'disposed' } = { phase: 'idle' };
  const requireActive = (signal: AbortSignal) => {
    if (state.phase === 'disposed') throw new Error('The variant source session is closed.');
    if (signal.aborted) throw abortError();
  };

  const open = async (signal: AbortSignal, force = false): Promise<VariantTrackRuntime> => {
    requireActive(signal);
    if (!force && state.phase === 'ready' && runtimeIsFresh(state.runtime)) return state.runtime;

    let nextRuntime: VariantTrackRuntime | null = null;
    const request = requireTrackAdmissionRequest(input.source);
    const refreshed = await admit({
      request,
      assemblyId: input.source.assemblyId,
      assemblyReferences: input.assemblyReferences,
      signal,
      reuseRememberedPreparation: !force,
      onVariantRuntime: (admission) => {
        nextRuntime = admission.runtime;
      },
    });
    requireActive(signal);
    if (!nextRuntime) throw new Error('Variant admission did not return a regional query runtime.');
    if (!sameAdmittedTrackSourceIdentity(input.source, refreshed)) {
      throw withUserMessage(
        new Error(
          'The variant source changed since it was added. Remove it and add the current source again.'
        ),
        'variant.sourceChanged'
      );
    }
    state = { phase: 'ready', runtime: nextRuntime };
    return nextRuntime;
  };

  return {
    async execute<T>(
      signal: AbortSignal,
      query: (current: VariantTrackRuntime) => Promise<T>
    ): Promise<T> {
      let current = await open(signal);
      requireActive(signal);
      try {
        const result = await query(current);
        requireActive(signal);
        return result;
      } catch (error) {
        if (state.phase === 'disposed' || signal.aborted) throw error;
        if (isVariantSourceChangedError(error)) {
          forgetLocalPreparation(input.source);
        } else if (!isExpiredGrant(error)) {
          throw error;
        }
        current = await open(signal, true);
        requireActive(signal);
        const result = await query(current);
        requireActive(signal);
        return result;
      }
    },
    dispose(): void {
      state = { phase: 'disposed' };
    },
  };
}

function runtimeIsFresh(runtime: VariantTrackRuntime): boolean {
  if ('kind' in runtime && runtime.kind === 'local') return true;
  return Date.now() < runtime.grantExpiresAtMs - GRANT_REFRESH_SKEW_MS;
}

function forgetLocalPreparation(source: AdmittedTrackSource): void {
  const request = requireTrackAdmissionRequest(source);
  if (request.source.kind === 'local-file') forgetPreparedVariantSource(request.source.path);
}

function isExpiredGrant(error: unknown): boolean {
  return error instanceof VariantRequestError && error.status === 401;
}

function abortError(): Error {
  return new DOMException('Aborted', 'AbortError');
}

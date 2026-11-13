import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import {
  beginHistoryObservation,
  createHistoryCorrelationId,
} from '../../lib/chat-history-telemetry';
import type { HistoryDetails, HistoryObservation } from '../../shared/chat-history-telemetry';

type Receipt = {
  target: string;
  observed: HistoryObservation;
  details: Partial<HistoryDetails>;
  sourceRevision: number;
};
interface Options {
  conversationId: string | null;
  known: boolean;
  hasState: boolean;
  isOpen: boolean;
  scoped: boolean;
  switchConversation: (id: string) => unknown;
  hydrateConversation: (id: string) => unknown;
  onConversationIdChange?: (id: string) => void;
}

export function useHistoryPaneObservation(options: Options) {
  const latest = useRef(options);
  latest.current = options;

  const binding = useRef<{
    id: string | null;
    open: boolean;
    scoped: boolean;
    generation: string | null;
    revision: number;
  } | null>(null);
  if (
    !binding.current ||
    binding.current.id !== options.conversationId ||
    binding.current.open !== options.isOpen ||
    binding.current.scoped !== options.scoped
  ) {
    binding.current = {
      id: options.conversationId,
      open: options.isOpen,
      scoped: options.scoped,
      generation: createHistoryCorrelationId(),
      revision: (binding.current?.revision ?? 0) + 1,
    };
  }
  const pending = useRef<Receipt | null>(null);
  const lifetime = useRef(0);
  const mounted = useRef(true);
  const [commitTick, setCommitTick] = useState(0);
  const remember = useCallback(
    (target: string, observed: HistoryObservation, details: Partial<HistoryDetails> = {}) => {
      if (!mounted.current) {
        observed.pane({ phase: 'cancelled', result: 'surface_closed' });
        return;
      }
      if (pending.current && pending.current.observed !== observed)
        pending.current.observed.pane({
          phase: 'cancelled',
          result: 'superseded',
          freshness: 'superseded',
        });
      pending.current = {
        target,
        observed,
        details,
        sourceRevision: binding.current?.revision ?? 0,
      };
      setCommitTick((value) => value + 1);
    },
    []
  );

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      lifetime.current += 1;
      pending.current?.observed.pane({ phase: 'cancelled', result: 'surface_closed' });
      pending.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    const receipt = pending.current;
    if (!receipt) return;
    const availability = receipt.details.availability ?? receipt.observed.availability;
    if (
      receipt.target === options.conversationId &&
      (options.hasState || availability === 'placeholder')
    ) {
      pending.current = null;
      receipt.observed.pane({
        ...receipt.details,
        result: options.isOpen
          ? availability === 'placeholder'
            ? 'placeholder_presented'
            : 'pane_presented'
          : 'background_available',
        authority: options.isOpen ? 'pane_commit' : 'keyed_state',
        availability: availability === 'unknown' && options.hasState ? 'keyed' : availability,
        paneRole: !options.isOpen ? 'background' : options.scoped ? 'scoped_pane' : 'current_pane',
        presentedGenerationId: options.isOpen ? binding.current?.generation : null,
      });
    } else if (
      receipt.target !== options.conversationId &&
      receipt.sourceRevision !== binding.current?.revision
    ) {
      pending.current = null;
      receipt.observed.pane({ phase: 'cancelled', result: 'superseded', freshness: 'superseded' });
    } else if (receipt.target === options.conversationId && !options.known && !options.hasState) {
      pending.current = null;
      receipt.observed.pane({
        phase: 'refused',
        result: 'pane_unavailable',
        freshness: 'unavailable',
      });
    }
  }, [
    commitTick,
    options.conversationId,
    options.hasState,
    options.known,
    options.isOpen,
    options.scoped,
  ]);

  const observeOwnership = useCallback(
    (kind: 'switchConversation' | 'hydrateConversation', id: string) => {
      const snapshot = latest.current;
      const epoch = lifetime.current;
      const sourceRevision = binding.current?.revision;
      const observed = beginHistoryObservation(
        'presentation',
        snapshot.isOpen ? 'pane_owner' : 'background_pane',
        binding.current?.generation
      );
      let product: unknown;
      try {
        product = snapshot[kind](id);
      } catch (error) {
        observed.store({ phase: 'error', result: 'hydration_rejected' });
        observed.pane({ phase: 'error', result: 'pane_unavailable' });
        throw error;
      }
      void Promise.resolve(product).then(
        (result) => {
          try {
            observed.store({
              result: result === 'stale' ? 'tombstoned' : 'request_returned',
              authority: 'not_attested',
            });
            if (epoch !== lifetime.current) {
              observed.pane({ phase: 'cancelled', result: 'surface_closed' });
              return;
            }
            if (result === 'stale') {
              observed.pane({ phase: 'refused', result: 'pane_unavailable' });
              return;
            }
            if (sourceRevision !== binding.current?.revision) {
              observed.pane({ phase: 'cancelled', result: 'superseded', freshness: 'superseded' });
              return;
            }
            remember(id, observed, {
              availability:
                latest.current.hasState && latest.current.conversationId === id
                  ? 'keyed'
                  : 'unknown',
            });
          } catch (ignoredError) {
            void ignoredError;
          }
        },
        () => {
          observed.store({ phase: 'error', result: 'hydration_rejected' });
          observed.pane({ phase: 'error', result: 'pane_unavailable' });
        }
      );
      return product;
    },
    [remember]
  );
  const switchForOwnership = useCallback(
    (id: string) => observeOwnership('switchConversation', id),
    [observeOwnership]
  );
  const hydrateForOwnership = useCallback(
    (id: string) => observeOwnership('hydrateConversation', id),
    [observeOwnership]
  );
  const retarget = useCallback(
    (id: string, observed?: HistoryObservation, details: Partial<HistoryDetails> = {}) => {
      latest.current.onConversationIdChange?.(id);
      if (observed) remember(id, observed, details);
    },
    [remember]
  );
  return {
    paneGenerationId: binding.current.generation,
    switchForOwnership,
    hydrateForOwnership,
    retarget,
  };
}
